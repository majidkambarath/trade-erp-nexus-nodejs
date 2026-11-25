const mongoose = require("mongoose");
const Transaction = require("../../models/modules/transactionModel");
const Customer = require("../../models/modules/customerModel");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const TaxCode = require("../../models/modules/financial/taxCodeModel");
const { EInvoiceSettings, EInvoiceSubmission } = require("../../models/modules/einvoiceModels");
const AccountConfigService = require("../financial/accountConfigService");
const AuditService = require("../core/auditService");
const Stock = require("../../models/modules/stockModel");
const { PROVIDERS, ProviderError } = require("./providers");
const { modeConfig } = require("./wafeq/config");
const { WafeqClient } = require("./wafeq/client");
const WafeqInboundPull = require("./wafeq/inboundPull");
const { toWafeqDocument, validGtin } = require("../../utils/wafeqPayload");
const { dueDateOf } = require("../../utils/paymentState");
const ei = require("../../utils/eInvoice");
const { todayInOrg } = require("../../utils/documentExpiry");
const { encrypt } = require("../../utils/secretBox");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const { runWithTenant, runUnscoped } = require("../../utils/tenantContext");
const UsageService = require("../core/usageService");

const ELIGIBLE = ["sales_order", "sales_return"];
const BACKOFF_MS = (attempt) => Math.min(60000 * 2 ** Math.max(attempt - 1, 0), 6 * 3600 * 1000); // 1m, 2m, 4m ... capped at 6h

class EInvoiceService {
  // ---------- settings ----------
  static async loadSettings(companyId, { withSecrets = false } = {}) {
    let q = EInvoiceSettings.findOne({ companyId });
    if (withSecrets) q = q.select("+webhookSecretEnc");
    return (await q) || new EInvoiceSettings({ companyId });
  }

  static publicSettings(s) {
    const w = s.wafeq || {};
    const modes = Object.fromEntries(["sandbox", "live"].map((m) => { const c = modeConfig(m); return [m, { available: c.available, oauth: c.oauth }]; }));
    return {
      enabled: s.enabled, provider: s.provider, environment: s.environment, startDate: s.startDate || null,
      participantId: (s.provider === "wafeq" && w.participantId) || s.participantId || "", dueDays: s.dueDays, retryMax: s.retryMax,
      // Honest about reach: invoices are exchanged with the built-in sandbox only until the business is linked to an
      // accredited service provider (Wafeq), and then only in the mode (test or live) that link was made in.
      connected: s.provider === "wafeq" && w.status === "active",
      wafeq: {
        status: w.status || "disconnected", mode: w.mode || null, name: w.name || "", tin: w.tin || "", participantId: w.participantId || "",
        linkedVia: w.linkedVia || null, connectedAt: w.connectedAt || null, lastWebhookAt: w.lastWebhookAt || null, inboundPulledAt: w.inboundPulledAt || null, lastError: w.lastError || null, modes,
      },
      // secrets are write-only: the client learns only whether one is stored
      hasWebhookSecret: Boolean(s.webhookSecretEnc),
    };
  }

  static async getSettings(req) {
    const { companyId } = getTenant(req);
    const s = await EInvoiceSettings.findOne({ companyId }).select("+webhookSecretEnc");
    return this.publicSettings(s || new EInvoiceSettings({ companyId }));
  }

  static async updateSettings(data, req) {
    const { companyId } = getTenant(req);
    const s = (await EInvoiceSettings.findOne({ companyId }).select("+webhookSecretEnc")) || new EInvoiceSettings({ companyId });

    if (data.provider !== undefined && !PROVIDERS[data.provider]) {
      throw new AppError("That access point is not available", 422, "PROVIDER_NOT_AVAILABLE");
    }
    const provider = data.provider !== undefined ? data.provider : s.provider;
    if (data.provider === "wafeq" && s.wafeq?.status !== "active") {
      throw new AppError("Connect this business to Wafeq first", 422, "WAFEQ_NOT_CONNECTED");
    }
    if (data.environment !== undefined && !["sandbox", "live"].includes(data.environment)) {
      throw new AppError("Only the sandbox and live modes exist", 422, "PROVIDER_NOT_AVAILABLE");
    }
    if (data.environment !== undefined && data.environment !== "sandbox" && provider !== "wafeq") {
      throw new AppError("Live e-invoicing needs a connected service provider", 422, "PROVIDER_NOT_AVAILABLE");
    }
    if (provider === "wafeq" && data.environment !== undefined && data.environment !== s.wafeq?.mode && s.wafeq?.mode) {
      throw new AppError("This business is linked to Wafeq in " + s.wafeq.mode + " mode; connect it again to change the mode", 422, "WAFEQ_MODE_MISMATCH");
    }
    if (data.environment === "live" && !modeConfig("live").available) {
      throw new AppError("Live Wafeq access is not installed on this server", 422, "PROVIDER_NOT_AVAILABLE");
    }
    if (data.provider !== undefined) s.provider = data.provider;
    if (data.environment !== undefined) s.environment = data.environment;
    if (s.provider === "wafeq" && s.wafeq?.mode) s.environment = s.wafeq.mode;
    if (data.participantId !== undefined) {
      const pid = String(data.participantId).trim();
      if (pid && !ei.PARTICIPANT_RE.test(pid)) throw new AppError("Participant ID must look like 0235:100123456700003", 400, "INVALID_PARTICIPANT_ID");
      s.participantId = pid;
    }
    if (data.dueDays !== undefined) {
      const n = Number(data.dueDays);
      if (!Number.isInteger(n) || n < 0) throw new AppError("dueDays must be a whole number, 0 or more", 400);
      s.dueDays = n;
    }
    if (data.startDate !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data.startDate)) || Number.isNaN(Date.parse(data.startDate))) throw new AppError("startDate must be a day (YYYY-MM-DD)", 400, "INVALID_START_DATE");
      s.startDate = data.startDate;
    }
    // A non-empty secret replaces the stored one; omitted or empty keeps it.
    if (data.webhookSecret) s.webhookSecretEnc = encrypt(data.webhookSecret);

    if (data.enabled !== undefined) {
      if (data.enabled) {
        const bad = (await this.sellerReadiness(companyId, s)).filter((c) => !c.ok);
        if (bad.length) throw new AppError(`Not ready to enable: ${bad.map((c) => c.label).join("; ")}`, 422, "EINVOICE_NOT_READY");
      }
      s.enabled = Boolean(data.enabled);
      if (s.enabled && !s.startDate) s.startDate = todayInOrg();
    }
    await s.save();
    return this.publicSettings(s);
  }

  // ---------- readiness ----------
  static async sellerReadiness(companyId, settings) {
    const cs = await CompanySettings.findOne({ companyId }).select("profile").lean();
    const p = cs?.profile || {};
    const checks = [
      { key: "trn", label: "Company TRN (15 digits)", ok: ei.TRN_RE.test(String(p.trn || "")) },
      { key: "legalName", label: "Company legal name", ok: Boolean(String(p.legalName || "").trim()) },
      { key: "address", label: "Company address and city", ok: Boolean(String(p.addressLine1 || "").trim() && String(p.city || "").trim()) },
      { key: "participantId", label: "Seller Participant ID", ok: ei.PARTICIPANT_RE.test(String((settings?.provider === "wafeq" && settings.wafeq?.participantId) || settings?.participantId || "")) },
      { key: "taxCodes", label: "At least one active tax code", ok: Boolean(await TaxCode.exists({ companyId, isActive: true })) },
    ];
    if (settings?.provider === "wafeq") {
      checks.push({ key: "wafeqConnected", label: "Business connected to Wafeq", ok: settings.wafeq?.status === "active" });
    }
    return checks;
  }

  static async readiness(req) {
    const { companyId } = getTenant(req);
    const settings = await this.loadSettings(companyId);
    const seller = await this.sellerReadiness(companyId, settings);

    const customers = await Customer.find({ trnNumber: { $nin: [null, ""] } })
      .select("customerName trnNumber billingAddress eInvoice status").lean();
    const rows = customers.map((c) => ({ _id: c._id, customerName: c.customerName, ...ei.partyReadiness(c) })).filter((r) => r.required);
    const notReady = rows.filter((r) => !r.ready);

    return {
      enabled: settings.enabled,
      seller,
      parties: { total: rows.length, ready: rows.length - notReady.length, notReady },
      ready: seller.every((c) => c.ok),
    };
  }

  // Fix a customer's e-invoice details (the readiness page's "edit" action).
  static async updateParty(customerId, data) {
    const c = await Customer.findById(customerId);
    if (!c) throw new AppError("Customer not found", 404);
    if (data.customerName !== undefined) c.customerName = String(data.customerName).trim();
    if (data.trnNumber !== undefined) c.trnNumber = String(data.trnNumber).trim() || null;
    if (data.billingAddress !== undefined) c.billingAddress = String(data.billingAddress).trim() || null;
    c.eInvoice = c.eInvoice || {};
    for (const k of ["city", "countryCode", "participantId", "buyerIdentifier"]) {
      if (data[k] !== undefined) c.eInvoice[k] = String(data[k]).trim();
    }
    if (c.eInvoice.countryCode) c.eInvoice.countryCode = c.eInvoice.countryCode.toUpperCase();
    if (data.trnNumber && !ei.TRN_RE.test(c.trnNumber || "")) throw new AppError("VAT Number must be 15 digits", 400, "INVALID_TRN");
    if (c.eInvoice.participantId && !ei.PARTICIPANT_RE.test(c.eInvoice.participantId)) {
      throw new AppError("Participant ID must look like 0235:100123456700003", 400, "INVALID_PARTICIPANT_ID");
    }
    c.markModified("eInvoice");
    await c.save({ validateModifiedOnly: true });
    return { _id: c._id, customerName: c.customerName, ...ei.partyReadiness(c.toObject()) };
  }

  // ---------- building ----------
  static async build(transactionId, req) {
    const { companyId } = getTenant(req);
    if (!mongoose.isValidObjectId(transactionId)) throw new AppError("Invalid document id", 400);
    const tx = await Transaction.findById(transactionId).lean();
    if (!tx) throw new AppError("Document not found", 404);
    if (!ELIGIBLE.includes(tx.type)) throw new AppError("Only sales invoices and sales returns (credit notes) are e-invoiced", 422, "NOT_ELIGIBLE");
    if (tx.isOpening) throw new AppError("An opening balance invoice was issued before go-live and is not e-invoiced", 422, "NOT_ELIGIBLE");
    if (tx.status !== "APPROVED") throw new AppError("Only an approved document can be sent", 422, "NOT_APPROVED");

    const [customer, cs, settings] = await Promise.all([
      Customer.findById(tx.partyId).lean(),
      CompanySettings.findOne({ companyId }).select("profile").lean(),
      this.loadSettings(companyId),
    ]);
    const viaWafeq = settings.provider === "wafeq";
    const payload = ei.buildPayload({
      transaction: tx, customer, seller: cs?.profile || {}, sellerParticipantId: (viaWafeq && settings.wafeq?.participantId) || settings.participantId,
    });
    const issues = ei.validatePayload(payload, { headerDiscount: ei.legacyHeaderDiscount(tx) });
    if (viaWafeq) {
      const w = await this.wafeqDocument({ tx, payload, customer, companyId });
      payload.wafeq = { path: w.path, body: w.body };
      issues.push(...w.issues);
      // Wafeq takes the seller from its own record, and has its own buyer rules: the checks above that it answers for are replaced
      const own = new Set(["customerParticipantId", "sellerAddressLine1", "sellerCity"]);
      return { tx, payload, issues: issues.filter((i) => !(i.field && own.has(i.field))), settings };
    }
    return { tx, payload, issues, settings };
  }

  // The body Wafeq takes for this document, with what only the database knows: the tax codes' reason codes, the buyer's emirate, the
  // due date and (a credit note) the invoice it credits.
  static async wafeqDocument({ tx, payload, customer, companyId }) {
    const codeIds = [...new Set((tx.items || []).map((i) => i.taxCodeId).filter(Boolean).map(String))];
    const codes = codeIds.length ? await TaxCode.find({ companyId, _id: { $in: codeIds } }).select("exemptionReasonCode reverseChargeGoodsType").lean() : [];
    const byId = new Map(codes.map((c) => [String(c._id), c]));
    const itemIds = [...new Set((tx.items || []).map((i) => i.itemId).filter(Boolean).map(String))];
    const stock = itemIds.length ? await Stock.find({ _id: { $in: itemIds } }).select("barcodeQrCode").lean() : [];
    const gtins = new Map(stock.map((s) => [String(s._id), s.barcodeQrCode]));
    const reasons = (tx.items || []).map((i) => byId.get(String(i.taxCodeId))?.exemptionReasonCode || undefined);
    // the line's goods type and GTIN, for a reverse-charge line only
    const enriched = { ...payload, lines: payload.lines.map((l, i) => {
      const item = (tx.items || [])[i];
      if (!item || l.taxCategory !== "AE") return l;
      const gtin = gtins.get(String(item.itemId));
      return { ...l, reverseChargeGoodsType: byId.get(String(item.taxCodeId))?.reverseChargeGoodsType, gtin: validGtin(gtin) ? String(gtin).trim() : undefined };
    }) };
    let original;
    if (tx.type === "sales_return") {
      const origId = tx.returnOf?.transactionId;
      const sub = origId ? await EInvoiceSubmission.findOne({ companyId, sourceType: "Transaction", sourceId: origId, providerEntryId: { $ne: null } }).select("providerEntryId").lean() : null;
      let issueDate;
      if (origId) { const o = await Transaction.findById(origId).select("date").lean(); if (o) issueDate = ei.dubaiDate(o.date); }
      original = { wafeqDocumentId: sub?.providerEntryId, number: tx.returnOf?.transactionNo, issueDate };
    }
    const due = dueDateOf({ date: tx.date, dueDate: tx.dueDate, paymentTerms: customer?.paymentTerms });
    return toWafeqDocument(enriched, {
      sourceId: String(tx._id), dueDate: due ? ei.dubaiDate(due) : undefined, reasons, original,
      buyer: { emirate: customer?.emirate, street: customer?.billingAddress, identifier: customer?.eInvoice?.buyerIdentifier, legalRegistration: customer?.eInvoice?.legalRegistration },
    });
  }

  static async preview(transactionId, req) {
    const { payload, issues, settings } = await this.build(transactionId, req);
    const out = { payload, issues, ready: issues.length === 0 };
    // Wafeq's own validation (the PINT-AE rules) on top of ours. Never a failure: a Wafeq outage is a note.
    if (settings.provider === "wafeq" && payload.wafeq?.body && issues.length === 0 && settings.wafeq?.status === "active") {
      try {
        const mode = settings.environment === "live" ? "live" : "sandbox";
        const res = await WafeqClient.validate(mode, settings.wafeq.taxpayerId, payload.wafeq.path, payload.wafeq.body);
        if (res.status === 200 && res.body) {
          const b = res.body;
          out.wafeq = { checked: true, valid: b.valid, route: b.route || null, recipient: b.effective_recipient_id || null, errors: (b.errors || []).map((e) => ({ code: e.code, message: e.message })), warnings: (b.warnings || []).map((e) => ({ code: e.code, message: e.message })) };
          if (b.valid === false) out.ready = false;
        } else {
          out.wafeq = { checked: false, note: "Could not check with Wafeq just now" };
        }
      } catch {
        out.wafeq = { checked: false, note: "Could not check with Wafeq just now" };
      }
    }
    return out;
  }

  // ---------- submission ----------
  static transition(sub, to, note) {
    if (sub.status === to) return;
    if (!ei.canTransition(sub.status, to)) {
      throw new AppError(`An invoice that is ${sub.status} cannot become ${to}`, 409, "INVALID_TRANSITION");
    }
    sub.status = to;
    sub.history.push({ status: to, at: new Date(), note });
    if (to === "SUBMITTED") sub.submittedAt = new Date();
    if (to === "ACKNOWLEDGED") sub.acknowledgedAt = new Date();
    if (to === "REPORTED") sub.reportedAt = new Date();
  }

  static async submit(transactionId, req) {
    const { companyId } = getTenant(req);
    const settings = await this.loadSettings(companyId);
    if (!settings.enabled) throw new AppError("E-invoicing is not enabled", 422, "EINVOICE_DISABLED");

    const { tx, payload, issues } = await this.build(transactionId, req);

    const existing = await EInvoiceSubmission.findOne({ companyId, sourceType: "Transaction", sourceId: tx._id });
    if (existing && existing.status !== "FAILED") return { submission: existing, alreadySubmitted: true };
    if (issues.length) {
      throw new AppError(`Cannot send ${tx.transactionNo}: ${issues.length} problem(s)`, 422, "EINVOICE_VALIDATION", { issues });
    }

    const fresh = {
      payload, payloadHash: ei.payloadHash(payload), buyerName: payload.buyerName, issueDate: tx.date,
      totals: { net: payload.lineExtensionTotal, tax: payload.taxAmount, payable: payload.payableAmount },
    };
    const by = req?.admin?.id ? String(req.admin.id) : null;
    let sub;
    if (existing) {
      // A failed invoice being sent again: exactly one caller wins the FAILED -> QUEUED claim.
      sub = await EInvoiceSubmission.findOneAndUpdate(
        { _id: existing._id, status: "FAILED" },
        { $set: { ...fresh, status: "QUEUED" }, $push: { history: { status: "QUEUED", at: new Date(), note: "Resubmitted after correction" } } },
        { new: true }
      );
    } else {
      // Create-or-fetch in one step. The unique index lets only one caller insert; the others see
      // that the document already existed and do not send.
      const r = await EInvoiceSubmission.findOneAndUpdate(
        { companyId, sourceType: "Transaction", sourceId: tx._id },
        {
          $setOnInsert: {
            documentNo: tx.transactionNo, invoiceTypeCode: payload.invoiceTypeCode, status: "QUEUED",
            history: [{ status: "QUEUED", at: new Date() }], submittedBy: by, ...fresh,
          },
        },
        { upsert: true, new: true, includeResultMetadata: true }
      ).catch((err) => (err.code === 11000 ? { lastErrorObject: { updatedExisting: true }, value: null } : Promise.reject(err)));
      sub = r.lastErrorObject?.updatedExisting ? null : r.value;
    }
    if (!sub) {
      return { submission: await EInvoiceSubmission.findOne({ companyId, sourceType: "Transaction", sourceId: tx._id }), alreadySubmitted: true };
    }

    await AuditService.log({ req, action: "EINVOICE_SUBMITTED", entity: "EInvoiceSubmission", entityId: sub._id, summary: `${tx.transactionNo} (${payload.invoiceTypeCode})` });
    return { submission: await this.attempt(sub, settings), alreadySubmitted: false };
  }

  // One delivery attempt. Never throws for provider problems - they become the invoice's state.
  // The provider this business sends through. An unknown one is a plain refusal, never "cannot read getStatus of undefined".
  static providerFor(settings) {
    const provider = PROVIDERS[settings?.provider];
    if (!provider) throw new ProviderError(`E-invoicing provider "${settings?.provider}" is not available on this server`, { retryable: false, code: "PROVIDER_NOT_AVAILABLE" });
    return provider;
  }

  static async attempt(sub, settings) {
    const full = await this.loadSettings(sub.companyId);
    sub.attempts += 1;
    try {
      const provider = this.providerFor(settings);
      const r = await provider.submit(sub.payload, { idempotencyKey: String(sub._id), settings: full, submission: sub });
      sub.providerEntryId = r.entryId;
      sub.providerResponse = r.raw ?? null;
      sub.lastError = null;
      sub.nextRetryAt = null;
      sub.providerIssues = [];
      if (settings.provider === "wafeq") sub.providerMode = full.environment;
      this.applyExtra(sub, r.extra);
      this.transition(sub, "SUBMITTED");
    } catch (err) {
      const retryable = err instanceof ProviderError ? err.retryable : true;
      sub.lastError = err.message;
      const refused = err.raw?.validation_errors || err.raw?.errors;
      sub.providerIssues = Array.isArray(refused) ? refused.slice(0, 10).map((e) => ({ code: e.code, message: e.message || String(e) })) : [];
      await this.noteLostConnection(sub.companyId, err);
      sub.retryable = retryable;
      sub.nextRetryAt = retryable && sub.attempts < (full.retryMax ?? 5) ? new Date(Date.now() + BACKOFF_MS(sub.attempts)) : null;
      this.transition(sub, "FAILED", err.message);
    }
    await sub.save();
    return sub;
  }

  // ---------- fix and resend ----------
  // The buyer rejected the invoice (reason BV or SV: wrong buyer details): after the customer is fixed, the SAME number is sent again as a
  // correction that points at the rejected document. Only through here may a REJECTED invoice become QUEUED again. A rejection by the tax
  // authority, or an FD one, cannot be corrected: that is a credit note and a new invoice.
  static async correct(id, req) {
    const { companyId } = getTenant(req);
    const sub = await EInvoiceSubmission.findOne({ _id: id, companyId });
    if (!sub) throw new AppError("Submission not found", 404);
    const settings = await this.loadSettings(companyId);
    const no = (message) => new AppError(message, 409, "NOT_CORRECTABLE");
    if (settings.provider !== "wafeq") throw no("Corrections are made through Wafeq");
    if (sub.status !== "REJECTED") throw no("Only a rejected invoice can be corrected");
    if (sub.rejectedBy !== "buyer") throw no("The tax authority rejected this invoice: issue a credit note and a corrected invoice instead");
    if (!["BV", "SV"].includes(sub.deliveryReasonCode)) throw no("The buyer's reason for rejecting cannot be corrected: issue a credit note and a new invoice instead");
    if (!sub.providerEntryId) throw no("There is no Wafeq document to correct");

    // rebuilt from today's data, so the corrected customer details are what is sent
    const { payload, issues } = await this.build(sub.sourceId, req);
    if (issues.length) throw new AppError(`Still not valid: ${issues.length} problem(s)`, 422, "EINVOICE_VALIDATION", { issues });
    payload.wafeq.body.corrects_document_id = sub.providerEntryId;
    sub.previousEntryIds = [...(sub.previousEntryIds || []), sub.providerEntryId];
    sub.payload = payload;
    sub.payloadHash = ei.payloadHash(payload);
    Object.assign(sub, { rejectedBy: null, deliveryStatus: null, taxStatus: null, lastError: null, providerIssues: [], retryable: true });
    sub.status = "QUEUED";
    sub.history.push({ status: "QUEUED", at: new Date(), note: `Correction of ${sub.previousEntryIds[sub.previousEntryIds.length - 1]}` });
    await sub.save();
    await AuditService.log({ req, action: "EINVOICE_CORRECTED", entity: "EInvoiceSubmission", entityId: sub._id, summary: `${sub.documentNo} corrected after the buyer's rejection` });
    return this.attempt(sub, settings);
  }

  // ---------- credit in full ----------
  // Cancelling an invoice that was e-invoiced is a credit note, never an edit. This makes the DRAFT sales return for everything not yet
  // credited, at the original prices and tax codes; a person reviews and approves it (Sales > Returns) and sends it like any credit note.
  static async creditInFull(transactionId, req) {
    const { companyId } = getTenant(req);
    if (!mongoose.isValidObjectId(transactionId)) throw new AppError("Invalid document id", 400);
    const tx = await Transaction.findById(transactionId).lean();
    if (!tx || tx.type !== "sales_order") throw new AppError("Sales invoice not found", 404);
    const sub = await EInvoiceSubmission.findOne({ companyId, sourceType: "Transaction", sourceId: tx._id }).select("status").lean();
    if (!sub || !["SUBMITTED", "ACKNOWLEDGED", "REPORTED"].includes(sub.status)) throw new AppError("Only an invoice that was sent as an e-invoice is credited this way", 409, "NOT_E_INVOICED");
    const ReturnService = require("../orderPurchase/returnService");
    const TransactionService = require("../orderPurchase/transactionService");
    const r = await ReturnService.returnable(tx._id);
    const lines = r.lines.filter((l) => l.remainingQty > 0);
    if (!lines.length) throw new AppError("Everything on this invoice is already credited", 409, "NOTHING_LEFT");
    const by = req?.admin?.id ? String(req.admin.id) : null;
    const draft = await TransactionService.createTransaction({
      type: "sales_return", status: "DRAFT", partyId: tx.partyId, partyType: "Customer", partyTypeRef: "Customer",
      returnOf: { transactionId: tx._id, transactionNo: tx.transactionNo },
      items: this.creditLines(tx, lines),
    }, by);
    await AuditService.log({ req, action: "EINVOICE_CREDIT_IN_FULL", entity: "Transaction", entityId: draft._id, summary: `${draft.transactionNo} drafted to credit ${tx.transactionNo}` });
    return { _id: draft._id, transactionNo: draft.transactionNo, credits: tx.transactionNo };
  }

  // The lines of a credit note for what is left of an invoice, at the invoice's prices and tax codes (a line with no code keeps its rate).
  static creditLines(tx, lines) {
    return lines.map((l) => {
      const taxCodeId = tx.items.find((i) => String(i._id) === String(l.lineId))?.taxCodeId;
      return {
        itemId: l.itemId, description: l.description, qty: l.remainingQty, price: l.price, rate: l.price, discountPercent: l.discountPercent || 0,
        ...(taxCodeId ? { taxCodeId } : { vatPercent: l.vatPercent ?? 0 }), returnOfLineId: l.lineId,
      };
    });
  }

  // ---------- credit and re-issue ----------
  // An invoice priced before 18 Nov 2026 took its whole-invoice discount off the total AFTER the tax (ei.legacyHeaderDiscount), which an e-invoice
  // cannot carry, and an approved invoice cannot be edited. This drafts, in ONE transaction, a credit note for the whole invoice and a new invoice
  // with the same customer, lines, charges and discount: priced today, the discount is shared over the lines, so the new invoice's total is what
  // the old one's was and its tax is right. Both credit note and new invoice carry the discount, so the customer is credited and charged the same
  // amount. Nothing is approved or posted: a person approves the credit note, then the new invoice, and sends that.
  // Only for this one problem: any other invoice that was never e-invoiced is still not credited from here (creditInFull: NOT_E_INVOICED).
  static async reissue(transactionId, req) {
    const { companyId } = getTenant(req);
    if (!mongoose.isValidObjectId(transactionId)) throw new AppError("Invalid document id", 400);
    const tx = await Transaction.findById(transactionId).lean();
    if (!tx || tx.type !== "sales_order") throw new AppError("Sales invoice not found", 404);
    if (tx.isOpening) throw new AppError("An opening balance invoice is not e-invoiced", 409, "NOT_REISSUABLE");
    if (tx.status !== "APPROVED") throw new AppError("Only an approved invoice is credited and issued again; a draft can simply be edited", 409, "NOT_REISSUABLE");
    if (tx.fx?.currency) throw new AppError("A foreign-currency invoice is not e-invoiced", 409, "NOT_REISSUABLE");
    const discount = ei.legacyHeaderDiscount(tx);
    if (!(discount > 0)) throw new AppError("This invoice has no discount taken off after VAT, so there is nothing to re-issue it for", 409, "NOT_REISSUABLE");
    const sub = await EInvoiceSubmission.findOne({ companyId, sourceType: "Transaction", sourceId: tx._id, status: { $in: ["QUEUED", "SUBMITTED", "ACKNOWLEDGED", "REPORTED"] } }).select("status").lean();
    if (sub) throw new AppError("This invoice was already sent as an e-invoice: use Credit in full instead", 409, "ALREADY_E_INVOICED");

    const ReturnService = require("../orderPurchase/returnService");
    const TransactionService = require("../orderPurchase/transactionService");
    const { withTransactionSession } = require("../../utils/withTransactionSession");
    const by = req?.admin?.id ? String(req.admin.id) : null;
    const charges = (tx.charges || []).map((c) => ({ code: c.code, description: c.description, amount: c.amount, vatPercent: c.vatPercent }));

    const made = await withTransactionSession(async (session) => {
      // read inside the transaction, so two presses cannot both see the whole invoice still to credit (the second sees the first's draft)
      const r = await ReturnService.returnable(tx._id, { session });
      if (r.lines.some((l) => !(l.remainingQty === l.originalQty))) {
        throw new AppError("Part of this invoice is already credited (or a credit note is waiting in Sales > Returns); re-issue it by hand", 409, "ALREADY_CREDITED");
      }
      const credit = await TransactionService.createTransaction({
        type: "sales_return", status: "DRAFT", partyId: tx.partyId, partyType: "Customer", partyTypeRef: "Customer",
        returnOf: { transactionId: tx._id, transactionNo: tx.transactionNo },
        items: this.creditLines(tx, r.lines), charges, discount,
        notes: `Credits ${tx.transactionNo} so it can be issued again with its discount shared over the lines (e-invoicing).`,
      }, by, session);
      const invoice = await TransactionService.createTransaction({
        type: "sales_order", status: "DRAFT", partyId: tx.partyId, partyType: "Customer", partyTypeRef: "Customer",
        items: (tx.items || []).map((l) => ({
          itemId: l.itemId, description: l.description, qty: l.qty, price: l.price ?? l.rate, rate: l.price ?? l.rate,
          discountPercent: l.discountPercent || 0, ...(l.taxCodeId ? { taxCodeId: l.taxCodeId } : { vatPercent: l.vatPercent ?? 0 }),
          ...(l.costCentreId ? { costCentreId: l.costCentreId } : {}),
        })),
        charges, discount,
        ...(tx.costCentreId ? { costCentreId: tx.costCentreId } : {}),
        ...(tx.lpono ? { lpono: tx.lpono } : {}), ...(tx.terms ? { terms: tx.terms } : {}),
        notes: [`Issued again in place of ${tx.transactionNo}.`, tx.notes].filter(Boolean).join(" "),
      }, by, session);
      return { credit, invoice };
    })();

    await AuditService.log({ req, action: "EINVOICE_REISSUED", entity: "Transaction", entityId: tx._id, summary: `${tx.transactionNo}: credit note ${made.credit.transactionNo} and new invoice ${made.invoice.transactionNo} drafted` });
    const brief = (d) => ({ _id: d._id, transactionNo: d.transactionNo, totalAmount: d.totalAmount, vat: d.pricing ? Math.round(((d.pricing.lineVat || 0) + (d.pricing.chargesVat || 0)) * 100) / 100 : undefined });
    return { original: tx.transactionNo, creditNote: brief(made.credit), invoice: brief(made.invoice) };
  }

  // What a provider tells us beside the step: its delivery leg, the job and the route.
  static applyExtra(sub, extra) {
    if (!extra) return;
    if (extra.deliveryStatus !== undefined && extra.deliveryStatus !== null) sub.deliveryStatus = extra.deliveryStatus;
    if (extra.deliveryJobId) sub.deliveryJobId = extra.deliveryJobId;
    if (extra.route) sub.route = extra.route;
  }

  // Wafeq says the grant is gone or the business unknown: mark the link so the screen asks for it to be connected again.
  static async noteLostConnection(companyId, err) {
    if (!["grant_not_active", "unknown_taxpayer"].includes(err?.code)) return;
    await EInvoiceSettings.updateOne({ companyId, "wafeq.status": "active" }, { $set: { "wafeq.status": "revoked", "wafeq.lastError": err.message } });
  }

  static async retry(id, req) {
    const { companyId } = getTenant(req);
    const sub = await EInvoiceSubmission.findOne({ _id: id, companyId });
    if (!sub) throw new AppError("Submission not found", 404);
    if (sub.status !== "FAILED") throw new AppError("Only a failed invoice can be retried", 409, "INVALID_TRANSITION");
    // Rebuild from the document so a corrected customer record is picked up.
    const { payload, issues } = await this.build(sub.sourceId, req);
    if (issues.length) throw new AppError(`Still not valid: ${issues.length} problem(s)`, 422, "EINVOICE_VALIDATION", { issues });
    sub.payload = payload;
    sub.payloadHash = ei.payloadHash(payload);
    this.transition(sub, "QUEUED", "Manual retry");
    await sub.save();
    await AuditService.log({ req, action: "EINVOICE_RETRIED", entity: "EInvoiceSubmission", entityId: sub._id, summary: sub.documentNo });
    return this.attempt(sub, await this.loadSettings(companyId));
  }

  // Ask the provider where the invoice is and move forward, one allowed step at a time.
  static async refresh(id, req) {
    const { companyId } = getTenant(req);
    const sub = await EInvoiceSubmission.findOne({ _id: id, companyId });
    if (!sub) throw new AppError("Submission not found", 404);
    return this.refreshOne(sub);
  }

  static async refreshOne(sub) {
    if (!["SUBMITTED", "ACKNOWLEDGED"].includes(sub.status)) return sub;
    const settings = await this.loadSettings(sub.companyId);
    let r;
    sub.pollCount += 1; // the provider sees this poll counted; the stored count goes up through the update below
    try {
      r = await this.providerFor(settings).getStatus(sub, { settings });
    } catch (err) {
      // a failed poll never changes the invoice's state
      await this.noteLostConnection(sub.companyId, err);
      await EInvoiceSubmission.updateOne({ _id: sub._id }, { $set: { lastError: err.message }, $inc: { pollCount: 1 } });
      return EInvoiceSubmission.findById(sub._id);
    }

    return this.applyStatus(sub, r, { polled: true });
  }

  // A status read from the provider (a poll, or a webhook): walk the allowed steps from where the invoice is and apply them in ONE
  // update that only matches while it is still there.
  static async applyStatus(sub, r, { polled = false } = {}) {
    // Walk the allowed steps from the status we read, then apply them in ONE update that only matches
    // while the invoice is still in that status. The background poll and a user's Refresh can overlap;
    // the loser matches nothing, so each step is recorded in the history exactly once.
    const wanted = { ACKNOWLEDGED: ["ACKNOWLEDGED"], REPORTED: ["ACKNOWLEDGED", "REPORTED"], REJECTED: ["REJECTED"] }[r.status] || [];
    const steps = [];
    let at = sub.status;
    for (const step of wanted) {
      if (at === step || !ei.canTransition(at, step)) continue;
      steps.push(step);
      at = step;
    }
    const now = new Date();
    const $set = {};
    if (r.taxStatus) $set.taxStatus = r.taxStatus;
    if (r.extra?.deliveryStatus) $set.deliveryStatus = r.extra.deliveryStatus;
    if (r.status === "REJECTED") {
      $set.rejectedBy = r.extra?.rejectedBy || null;
      if (r.extra?.reasonCode) $set.deliveryReasonCode = r.extra.reasonCode;
      if (r.extra?.reasonText) $set.deliveryReasonText = r.extra.reasonText;
    }
    if (r.status === "REJECTED") $set.lastError = r.note || "Rejected by the access point";
    // a successful read that is not a rejection clears an error left by an earlier failed poll: it no longer describes the invoice
    const clear = r.status !== "REJECTED" && (sub.lastError || sub.providerIssues?.length);
    if (clear) $set.providerIssues = [];
    if (steps.length) {
      $set.status = at;
      if (steps.includes("ACKNOWLEDGED")) $set.acknowledgedAt = now;
      if (steps.includes("REPORTED")) $set.reportedAt = now;
    }
    if (!polled && !steps.length && !Object.keys($set).length && !clear) return sub;
    const update = polled ? { $set, $inc: { pollCount: 1 } } : { $set };
    if (clear) update.$unset = { lastError: "" };
    if (steps.length) update.$push = { history: { $each: steps.map((status) => ({ status, at: now, note: r.note })) } };
    const moved = await EInvoiceSubmission.findOneAndUpdate({ _id: sub._id, status: sub.status }, update, { new: true });
    return moved || EInvoiceSubmission.findById(sub._id); // someone else moved it first: report where it is now
  }

  // Background pass: retry failed deliveries whose time has come, and poll in-flight invoices.
  static async processDue(now = new Date()) {
    // Listing which organisations have e-invoicing on is the one cross-organisation read; each one's work
    // then runs inside its own scope.
    const enabled = await runUnscoped("background job: lists the organisations that have e-invoicing switched on", () =>
      EInvoiceSettings.find({ enabled: true }).select("companyId").lean()
    );
    const live = await UsageService.liveCodes({ feature: "einvoicing", now });
    let retried = 0, polled = 0;
    for (const { companyId } of enabled) {
      if (!live.has(companyId)) continue; // suspended, expired or without the feature: nothing is submitted for it
      const done = await runWithTenant({ companyId }, async () => {
        let r = 0, p = 0;
        const settings = await this.loadSettings(companyId);
        const failed = await EInvoiceSubmission.find({ companyId, status: "FAILED", retryable: true, nextRetryAt: { $lte: now } }).limit(25);
        for (const sub of failed) {
          this.transition(sub, "QUEUED", "Automatic retry");
          await sub.save();
          await this.attempt(sub, settings);
          r += 1;
        }
        // Wafeq's reads are shared by every client of ours (120 a minute): the webhook is the main path, polling only the backstop
        const q = { companyId, status: { $in: ["SUBMITTED", "ACKNOWLEDGED"] } };
        if (settings.provider === "wafeq") q.updatedAt = { $lte: new Date(now.getTime() - 10 * 60 * 1000) };
        // received supplier invoices: asked for here at most every ten minutes (the webhook is the quick path)
        if (settings.provider === "wafeq") await WafeqInboundPull.pull(companyId, { now }).catch(() => {});
        const inflight = await EInvoiceSubmission.find(q).limit(50);
        for (const sub of inflight) { await this.refreshOne(sub); p += 1; }
        return { r, p };
      });
      retried += done.r;
      polled += done.p;
    }
    return { retried, polled };
  }

  // ---------- lists and dashboard ----------
  static async documents(req, { page = 1, limit = 25, status, search, overdue, kind } = {}) {
    const { companyId } = getTenant(req);
    const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const settings = await this.loadSettings(companyId);
    const filter = { type: { $in: ELIGIBLE }, status: "APPROVED", isOpening: { $ne: true } };
    if (search) filter.transactionNo = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (kind === "380") filter.type = "sales_order";
    if (kind === "381") filter.type = "sales_return";
    // The status filter is decided by the database, not by whichever page happens to be loaded.
    if (status === "NOT_SENT") filter._id = { $nin: await EInvoiceSubmission.distinct("sourceId", { companyId }) };
    else if (status) filter._id = { $in: await EInvoiceSubmission.distinct("sourceId", { companyId, status }) };
    if (overdue && settings.dueDays > 0) filter.date = { $lt: new Date(Date.now() - settings.dueDays * 86400000) };
    const docs = await Transaction.find(filter)
      .select("transactionNo type date partyId totalAmount returnOf")
      .populate({ path: "partyId", model: "Customer", select: "customerName trnNumber billingAddress eInvoice" })
      .sort({ date: -1, _id: -1 }).skip((Math.max(Number(page) || 1, 1) - 1) * lim).limit(lim).lean();
    const subs = await EInvoiceSubmission.find({ companyId, sourceId: { $in: docs.map((d) => d._id) } }).lean();
    const byDoc = new Map(subs.map((s) => [String(s.sourceId), s]));
    // the credit notes made against these invoices, so an invoice says it was credited and a credit note says what it credits
    const credits = await Transaction.find({ type: "sales_return", status: { $nin: ["REJECTED", "CANCELLED"] }, "returnOf.transactionId": { $in: docs.filter((d) => d.type === "sales_order").map((d) => d._id) } }).select("transactionNo returnOf.transactionId").lean();
    const creditsOf = new Map();
    for (const c of credits) { const k = String(c.returnOf.transactionId); creditsOf.set(k, [...(creditsOf.get(k) || []), c.transactionNo]); }
    return docs.map((d) => {
      const s = byDoc.get(String(d._id));
      const party = d.partyId ? ei.partyReadiness(d.partyId) : { required: false, ready: true, missing: [] };
      const due = settings.dueDays > 0 ? new Date(new Date(d.date).getTime() + settings.dueDays * 86400000) : null;
      return {
        _id: d._id, transactionNo: d.transactionNo, type: d.type, date: d.date, customer: d.partyId?.customerName,
        total: d.totalAmount, invoiceTypeCode: d.type === "sales_return" ? "381" : "380",
        status: s?.status || "NOT_SENT", taxStatus: s?.taxStatus || null, deliveryStatus: s?.deliveryStatus || null, route: s?.route || null, rejectedBy: s?.rejectedBy || null, deliveryReasonCode: s?.deliveryReasonCode || null, deliveryReasonText: s?.deliveryReasonText || null, lastError: s?.lastError || null,
        creditOf: d.type === "sales_return" ? d.returnOf?.transactionNo || null : null, creditedBy: creditsOf.get(String(d._id)) || [],
        submissionId: s?._id || null, partyReady: party.ready, partyMissing: party.missing, dueDate: due,
        overdue: Boolean(due && !s && due < new Date()),
      };
    });
  }

  static async listSubmissions(req, { status, page = 1, limit = 25 } = {}) {
    const { companyId } = getTenant(req);
    const q = { companyId };
    if (status) q.status = status;
    const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const [rows, total] = await Promise.all([
      EInvoiceSubmission.find(q).select("-payload").sort({ createdAt: -1 }).skip((Math.max(Number(page) || 1, 1) - 1) * lim).limit(lim).lean(),
      EInvoiceSubmission.countDocuments(q),
    ]);
    return { rows, total };
  }

  static async getSubmission(id, req) {
    const { companyId } = getTenant(req);
    const sub = await EInvoiceSubmission.findOne({ _id: id, companyId }).lean();
    if (!sub) throw new AppError("Submission not found", 404);
    return sub;
  }

  // The tracking dashboard. `todo` is the worklist as of now; everything else is for the period, by the invoice's own date.
  static async dashboard(req, { from, to } = {}) {
    const { companyId } = getTenant(req);
    const { InboundInvoice } = require("../../models/modules/einvoiceModels");
    const dash = require("../../utils/einvoiceDashboard");
    const settings = await this.loadSettings(companyId);
    const today = todayInOrg();
    const DAY = /^\d{4}-\d{2}-\d{2}$/;
    if ((from && !DAY.test(from)) || (to && !DAY.test(to))) throw new AppError("from and to must be days (YYYY-MM-DD)", 400, "INVALID_RANGE");
    const start = from || `${today.slice(0, 8)}01`;
    const end = to || today;
    if (start > end) throw new AppError("The period ends before it starts", 400, "INVALID_RANGE");
    const range = { $gte: new Date(`${start}T00:00:00.000Z`), $lte: new Date(`${end}T23:59:59.999Z`) };
    const now = new Date();
    const months = dash.lastMonths(end, 6);
    const trendFrom = new Date(`${months[0]}-01T00:00:00.000Z`);
    const sourceIds = await EInvoiceSubmission.distinct("sourceId", { companyId });
    const unsent = { type: { $in: ELIGIBLE }, status: "APPROVED", isOpening: { $ne: true }, _id: { $nin: sourceIds }, date: { $gte: new Date(`${settings.startDate || start}T00:00:00.000Z`) } };
    const SUBS = "documentNo issueDate status taxStatus deliveryStatus route rejectedBy deliveryReasonCode deliveryReasonText lastError invoiceTypeCode totals buyerName submittedAt updatedAt sourceId";

    const [inPeriod, openRows, unsentDocs, sentTrend, inboundPeriod, inboundByStatus, inboundNotRecorded, inboundTrend, recent, attentionRows] = await Promise.all([
      EInvoiceSubmission.find({ companyId, issueDate: range }).select(SUBS).lean(),
      EInvoiceSubmission.find({ companyId, status: { $in: ["FAILED", "REJECTED", "SUBMITTED"] } }).select(SUBS).lean(),
      Transaction.find(unsent).select("date totalAmount").lean(),
      EInvoiceSubmission.aggregate([
        { $match: { companyId, issueDate: { $gte: trendFrom, $lte: range.$lte }, status: { $in: ["SUBMITTED", "ACKNOWLEDGED", "REPORTED"] } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$issueDate" } }, count: { $sum: 1 }, amount: { $sum: { $cond: [{ $eq: ["$invoiceTypeCode", "381"] }, { $multiply: ["$totals.payable", -1] }, "$totals.payable"] } } } },
      ]),
      InboundInvoice.find({ companyId, issueDate: range }).select("status kind totals sellerName purchaseOrderId").lean(),
      InboundInvoice.aggregate([{ $match: { companyId } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
      InboundInvoice.countDocuments({ companyId, status: "ACCEPTED", kind: { $ne: "credit_note" }, purchaseOrderId: { $in: [null, undefined] } }),
      InboundInvoice.aggregate([
        { $match: { companyId, issueDate: { $gte: trendFrom, $lte: range.$lte } } },
        { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$issueDate" } }, count: { $sum: 1 }, amount: { $sum: "$totals.payable" } } },
      ]),
      EInvoiceSubmission.find({ companyId }).select(SUBS).sort({ updatedAt: -1 }).limit(8).lean(),
      EInvoiceSubmission.find({ companyId, status: { $in: ["FAILED", "REJECTED"] } }).select(SUBS).sort({ updatedAt: -1 }).limit(8).lean(),
    ]);

    const dueMs = settings.dueDays > 0 ? settings.dueDays * 86400000 : null;
    const overdueDocs = dueMs ? unsentDocs.filter((d) => new Date(d.date).getTime() + dueMs < now.getTime()) : [];
    const sumOf = (rows) => Math.round(rows.reduce((t, d) => t + (d.totalAmount || 0), 0) * 100) / 100;
    const failed = openRows.filter((s) => s.status === "FAILED").length;
    const rejected = openRows.filter((s) => s.status === "REJECTED");
    const todo = dash.todoItems({
      notSent: { count: unsentDocs.length, amount: sumOf(unsentDocs) }, overdue: { count: overdueDocs.length, amount: sumOf(overdueDocs) },
      failed, rejectedByBuyer: rejected.filter((s) => s.rejectedBy !== "fta").length, rejectedByFta: rejected.filter((s) => s.rejectedBy === "fta").length,
      stuck: openRows.filter((s) => dash.isStuck(s, now)).length,
      inboundToReview: inboundByStatus.find((x) => x._id === "RECEIVED")?.count || 0, inboundNotRecorded,
    });

    const c = {};
    for (const s of inPeriod) c[s.status] = (c[s.status] || 0) + 1;
    const sent = (c.SUBMITTED || 0) + (c.ACKNOWLEDGED || 0) + (c.REPORTED || 0);
    const attempted = sent + (c.FAILED || 0) + (c.REJECTED || 0);
    const t = dash.totalsByType(inPeriod);
    // the same figures for the period before, so each one can say how it moved
    const prev = dash.previousRange(start, end);
    const prevRange = { $gte: new Date(`${prev.from}T00:00:00.000Z`), $lte: new Date(`${prev.to}T23:59:59.999Z`) };
    const [prevSubs, prevInbound] = await Promise.all([
      EInvoiceSubmission.find({ companyId, issueDate: prevRange }).select("status invoiceTypeCode totals deliveryStatus route taxStatus rejectedBy").lean(),
      InboundInvoice.find({ companyId, issueDate: prevRange, kind: { $ne: "credit_note" } }).select("totals").lean(),
    ]);
    const pt = dash.totalsByType(prevSubs);
    const pl = dash.legs(prevSubs.filter((s) => s.status !== "QUEUED"));
    const previous = {
      from: prev.from, to: prev.to, payable: pt.net.payable, invoices: pt.invoices.count, creditNotes: pt.creditNotes.count, creditNotesAmount: pt.creditNotes.payable,
      delivered: pl.delivery.delivered, received: prevInbound.length, receivedAmount: Math.round(prevInbound.reduce((x, i) => x + (i.totals?.payable || 0), 0) * 100) / 100,
    };
    const leg = dash.legs(inPeriod.filter((s) => s.status !== "QUEUED"));
    const reach = leg.delivery.delivered + leg.delivery.inProgress + leg.delivery.ftaOnly + leg.delivery.failed + leg.delivery.rejected;
    const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

    const top = (rows, key) => {
      const m = new Map();
      for (const r of rows) {
        const k = r[key] || "Unknown";
        const v = m.get(k) || { name: k, count: 0, amount: 0 };
        v.count += 1; v.amount += (r.totals?.payable || 0) * (r.invoiceTypeCode === "381" || r.kind === "credit_note" ? -1 : 1);
        m.set(k, v);
      }
      return [...m.values()].map((v) => ({ ...v, amount: Math.round(v.amount * 100) / 100 })).sort((a, b) => b.amount - a.amount).slice(0, 5);
    };
    const asMap = (rows) => Object.fromEntries(rows.map((r) => [r._id, { count: r.count, amount: r.amount }]));
    const ibIn = inboundPeriod.filter((i) => i.kind !== "credit_note");
    const act = (s) => ({ _id: s._id, documentNo: s.documentNo, sourceId: s.sourceId, invoiceTypeCode: s.invoiceTypeCode, buyerName: s.buyerName, status: s.status });

    return {
      period: { from: start, to: end },
      sandbox: settings.provider !== "wafeq" || settings.environment !== "live",
      todo,
      pipeline: { byStatus: c, notSent: unsentDocs.filter((d) => new Date(d.date) >= range.$gte && new Date(d.date) <= range.$lte).length, delivery: leg.delivery, fta: leg.fta, deliveredRate: pct(leg.delivery.delivered, reach), reportedRate: pct(leg.fta.reported, sent) },
      totals: t,
      previous,
      monthly: dash.monthly(months, asMap(sentTrend), asMap(inboundTrend)),
      topCustomers: top(inPeriod.filter((s) => ["SUBMITTED", "ACKNOWLEDGED", "REPORTED"].includes(s.status)), "buyerName"),
      topSuppliers: top(inboundPeriod, "sellerName"),
      inboundPeriod: { received: inboundPeriod.length, accepted: inboundPeriod.filter((i) => i.status === "ACCEPTED").length, rejected: inboundPeriod.filter((i) => i.status === "REJECTED").length, recorded: ibIn.filter((i) => i.purchaseOrderId).length, amount: Math.round(ibIn.reduce((s, i) => s + (i.totals?.payable || 0), 0) * 100) / 100 },
      attention: attentionRows.map((s) => ({ ...act(s), ...dash.attentionOf(s) })),
      // kept for older callers
      outbound: {
        total: Object.values(c).reduce((n, x) => n + x, 0), byStatus: c, net: t.invoices.net, tax: t.invoices.tax, payable: t.invoices.payable,
        successRate: attempted ? Math.round(((c.REPORTED || 0) / attempted) * 1000) / 10 : null, needsAttention: (c.FAILED || 0) + (c.REJECTED || 0),
      },
      inbound: Object.fromEntries(inboundByStatus.map((x) => [x._id, x.count])),
      recent: recent.map((s) => ({ ...act(s), deliveryStatus: s.deliveryStatus, taxStatus: s.taxStatus, totals: s.totals, updatedAt: s.updatedAt, lastError: s.lastError })),
    };
  }
}

module.exports = EInvoiceService;
