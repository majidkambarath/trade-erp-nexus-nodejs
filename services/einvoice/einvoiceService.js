const mongoose = require("mongoose");
const Transaction = require("../../models/modules/transactionModel");
const Customer = require("../../models/modules/customerModel");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const TaxCode = require("../../models/modules/financial/taxCodeModel");
const { EInvoiceSettings, EInvoiceSubmission } = require("../../models/modules/einvoiceModels");
const AccountConfigService = require("../financial/accountConfigService");
const AuditService = require("../core/auditService");
const { PROVIDERS, ProviderError } = require("./providers");
const ei = require("../../utils/eInvoice");
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
    return {
      enabled: s.enabled, provider: s.provider, environment: s.environment,
      participantId: s.participantId || "", dueDays: s.dueDays, retryMax: s.retryMax,
      // Honest about reach: invoices are exchanged with the built-in sandbox only until an
      // accredited service provider is connected.
      connected: false,
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
      throw new AppError("No access point is connected yet; only the sandbox is available", 422, "PROVIDER_NOT_AVAILABLE");
    }
    if (data.environment !== undefined && data.environment !== "sandbox") {
      throw new AppError("Live e-invoicing needs a connected service provider, which is not available yet", 422, "PROVIDER_NOT_AVAILABLE");
    }
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
    // A non-empty secret replaces the stored one; omitted or empty keeps it.
    if (data.webhookSecret) s.webhookSecretEnc = encrypt(data.webhookSecret);

    if (data.enabled !== undefined) {
      if (data.enabled) {
        const bad = (await this.sellerReadiness(companyId, s)).filter((c) => !c.ok);
        if (bad.length) throw new AppError(`Not ready to enable: ${bad.map((c) => c.label).join("; ")}`, 422, "EINVOICE_NOT_READY");
      }
      s.enabled = Boolean(data.enabled);
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
      { key: "participantId", label: "Seller Participant ID", ok: ei.PARTICIPANT_RE.test(String(settings?.participantId || "")) },
      { key: "taxCodes", label: "At least one active tax code", ok: Boolean(await TaxCode.exists({ companyId, isActive: true })) },
    ];
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
    for (const k of ["city", "countryCode", "participantId"]) {
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
    const payload = ei.buildPayload({
      transaction: tx, customer, seller: cs?.profile || {}, sellerParticipantId: settings.participantId,
    });
    const issues = ei.validatePayload(payload, { headerDiscount: tx.pricing?.headerDiscount ?? tx.discount ?? 0 });
    return { tx, payload, issues, settings };
  }

  static async preview(transactionId, req) {
    const { payload, issues } = await this.build(transactionId, req);
    return { payload, issues, ready: issues.length === 0 };
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
      payload, payloadHash: ei.payloadHash(payload), buyerName: payload.buyerName,
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
  static async attempt(sub, settings) {
    const provider = PROVIDERS[settings.provider];
    const full = await this.loadSettings(sub.companyId);
    sub.attempts += 1;
    try {
      const r = await provider.submit(sub.payload, { idempotencyKey: String(sub._id) });
      sub.providerEntryId = r.entryId;
      sub.providerResponse = r.raw ?? null;
      sub.lastError = null;
      sub.nextRetryAt = null;
      this.transition(sub, "SUBMITTED");
    } catch (err) {
      const retryable = err instanceof ProviderError ? err.retryable : true;
      sub.lastError = err.message;
      sub.retryable = retryable;
      sub.nextRetryAt = retryable && sub.attempts < (full.retryMax ?? 5) ? new Date(Date.now() + BACKOFF_MS(sub.attempts)) : null;
      this.transition(sub, "FAILED", err.message);
    }
    await sub.save();
    return sub;
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
    const provider = PROVIDERS[settings.provider];
    let r;
    sub.pollCount += 1; // the provider sees this poll counted; the stored count goes up through the update below
    try {
      r = await provider.getStatus(sub);
    } catch (err) {
      // a failed poll never changes the invoice's state
      await EInvoiceSubmission.updateOne({ _id: sub._id }, { $set: { lastError: err.message }, $inc: { pollCount: 1 } });
      return EInvoiceSubmission.findById(sub._id);
    }

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
    if (r.status === "REJECTED") $set.lastError = r.note || "Rejected by the access point";
    if (steps.length) {
      $set.status = at;
      if (steps.includes("ACKNOWLEDGED")) $set.acknowledgedAt = now;
      if (steps.includes("REPORTED")) $set.reportedAt = now;
    }
    const update = { $set, $inc: { pollCount: 1 } };
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
        const inflight = await EInvoiceSubmission.find({ companyId, status: { $in: ["SUBMITTED", "ACKNOWLEDGED"] } }).limit(50);
        for (const sub of inflight) { await this.refreshOne(sub); p += 1; }
        return { r, p };
      });
      retried += done.r;
      polled += done.p;
    }
    return { retried, polled };
  }

  // ---------- lists and dashboard ----------
  static async documents(req, { page = 1, limit = 25, status, search } = {}) {
    const { companyId } = getTenant(req);
    const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const filter = { type: { $in: ELIGIBLE }, status: "APPROVED", isOpening: { $ne: true } };
    if (search) filter.transactionNo = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const docs = await Transaction.find(filter)
      .select("transactionNo type date partyId totalAmount returnOf")
      .populate({ path: "partyId", model: "Customer", select: "customerName trnNumber billingAddress eInvoice" })
      .sort({ date: -1, _id: -1 }).skip((Math.max(Number(page) || 1, 1) - 1) * lim).limit(lim).lean();
    const subs = await EInvoiceSubmission.find({ companyId, sourceId: { $in: docs.map((d) => d._id) } }).lean();
    const byDoc = new Map(subs.map((s) => [String(s.sourceId), s]));
    const settings = await this.loadSettings(companyId);
    let rows = docs.map((d) => {
      const s = byDoc.get(String(d._id));
      const party = d.partyId ? ei.partyReadiness(d.partyId) : { required: false, ready: true, missing: [] };
      const due = settings.dueDays > 0 ? new Date(new Date(d.date).getTime() + settings.dueDays * 86400000) : null;
      return {
        _id: d._id, transactionNo: d.transactionNo, type: d.type, date: d.date, customer: d.partyId?.customerName,
        total: d.totalAmount, invoiceTypeCode: d.type === "sales_return" ? "381" : "380",
        status: s?.status || "NOT_SENT", taxStatus: s?.taxStatus || null, lastError: s?.lastError || null,
        submissionId: s?._id || null, partyReady: party.ready, partyMissing: party.missing, dueDate: due,
        overdue: Boolean(due && !s && due < new Date()),
      };
    });
    if (status) rows = rows.filter((r) => r.status === status);
    return rows;
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

  static async dashboard(req) {
    const { companyId } = getTenant(req);
    const { InboundInvoice } = require("../../models/modules/einvoiceModels");
    const [byStatus, totals, recent, inbound] = await Promise.all([
      EInvoiceSubmission.aggregate([{ $match: { companyId } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
      EInvoiceSubmission.aggregate([
        { $match: { companyId, status: { $in: ["SUBMITTED", "ACKNOWLEDGED", "REPORTED"] } } },
        { $group: { _id: null, net: { $sum: "$totals.net" }, tax: { $sum: "$totals.tax" }, payable: { $sum: "$totals.payable" } } },
      ]),
      EInvoiceSubmission.find({ companyId }).select("documentNo status buyerName totals updatedAt lastError").sort({ updatedAt: -1 }).limit(8).lean(),
      InboundInvoice.aggregate([{ $match: { companyId } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    ]);
    const c = Object.fromEntries(byStatus.map((x) => [x._id, x.count]));
    const sent = (c.SUBMITTED || 0) + (c.ACKNOWLEDGED || 0) + (c.REPORTED || 0);
    const attempted = sent + (c.FAILED || 0) + (c.REJECTED || 0);
    return {
      outbound: {
        total: Object.values(c).reduce((t, n) => t + n, 0), byStatus: c,
        net: totals[0]?.net || 0, tax: totals[0]?.tax || 0, payable: totals[0]?.payable || 0,
        successRate: attempted ? Math.round(((c.REPORTED || 0) / attempted) * 1000) / 10 : null,
        needsAttention: (c.FAILED || 0) + (c.REJECTED || 0),
      },
      inbound: Object.fromEntries(inbound.map((x) => [x._id, x.count])),
      recent,
    };
  }
}

module.exports = EInvoiceService;
