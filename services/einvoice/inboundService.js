const mongoose = require("mongoose");
const Vendor = require("../../models/modules/vendorModel");
const Transaction = require("../../models/modules/transactionModel");
const { EInvoiceSettings, InboundInvoice } = require("../../models/modules/einvoiceModels");
const AuditService = require("../core/auditService");
const ei = require("../../utils/eInvoice");
const { decrypt, hmac, safeEqual } = require("../../utils/secretBox");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// Invoices from suppliers arrive through the access point (a signed webhook, or entered by hand).
// Each is matched to a vendor by TRN / participant id and, when possible, to the purchase order
// it bills. Accepting records the decision and the link; it does NOT create a purchase document.
class InboundService {
  // The sender's identity is established by an HMAC over the raw request body, using the secret
  // stored in settings. A request without a valid signature is refused.
  static async verifyWebhook(rawBody, signature, companyId) {
    const s = await EInvoiceSettings.findOne({ companyId }).select("+webhookSecretEnc").lean();
    if (!s?.webhookSecretEnc) throw new AppError("Webhook is not configured", 503, "WEBHOOK_NOT_CONFIGURED");
    if (!signature || !rawBody || !safeEqual(hmac(decrypt(s.webhookSecretEnc), rawBody), String(signature).replace(/^sha256=/, ""))) {
      throw new AppError("Invalid webhook signature", 401, "INVALID_SIGNATURE");
    }
  }

  static normalise(p) {
    const lines = Array.isArray(p.lines) ? p.lines : [];
    return {
      providerId: String(p.providerId || p.id || p.entryId || `${p.sellerVatTrn || p.sellerName}|${p.documentId}`),
      documentId: String(p.documentId || "").trim(),
      issueDate: p.issueDate ? new Date(p.issueDate) : undefined,
      sellerName: p.sellerName, sellerVatTrn: String(p.sellerVatTrn || "").trim() || undefined,
      sellerParticipantId: p.sellerParticipantId || p.supplierParticipantId,
      invoiceRef: p.invoiceRef || p.buyerReference,
      currency: p.documentCurrencyCode || "AED",
      totals: {
        net: round2(p.lineExtensionTotal ?? lines.reduce((t, l) => t + (Number(l.lineNetAmount) || 0), 0)),
        tax: round2(p.taxAmount ?? lines.reduce((t, l) => t + (Number(l.lineTaxAmount) || 0), 0)),
        payable: round2(p.payableAmount ?? p.totalIncludingTax),
      },
      lines,
    };
  }

  static async match(doc, companyId) {
    const or = [];
    if (doc.sellerVatTrn) or.push({ trnNO: doc.sellerVatTrn });
    if (doc.sellerParticipantId) or.push({ participantId: doc.sellerParticipantId });
    const vendor = or.length ? await Vendor.findOne({ $or: or }).select("vendorName").lean() : null;
    if (!vendor) {
      return { note: "No vendor matches this supplier's TRN or participant id - add the vendor, then re-check." };
    }
    // The purchase order it bills: referenced by number, else a single open one for the same amount.
    const open = await Transaction.find({ type: "purchase_order", status: "APPROVED", isOpening: { $ne: true }, partyId: vendor._id })
      .select("transactionNo totalAmount outstandingAmount vendorReference").lean();
    const byRef = open.find((o) => [doc.invoiceRef, doc.documentId].filter(Boolean).some((r) => r === o.transactionNo || r === o.vendorReference));
    const byAmount = open.filter((o) => Math.abs(o.totalAmount - doc.totals.payable) <= 0.01);
    const po = byRef || (byAmount.length === 1 ? byAmount[0] : null);
    return {
      vendorId: vendor._id,
      purchaseOrderId: po?._id || null,
      note: po
        ? `Matched to ${vendor.vendorName}, purchase order ${po.transactionNo}${byRef ? " (by reference)" : " (by amount)"}`
        : `Matched to ${vendor.vendorName}; no single purchase order matches - ${byAmount.length > 1 ? "several have the same amount" : "none has this reference or amount"}`,
    };
  }

  // Idempotent: the same invoice delivered twice (a webhook retry) is stored once.
  static async ingest(payload, { source = "manual", req, extra = {} } = {}) {
    const { companyId } = getTenant(req);
    const doc = this.normalise(payload);
    if (!doc.documentId) throw new AppError("documentId is required", 400);
    const dup = await InboundInvoice.findOne({ companyId, providerId: doc.providerId });
    if (dup) return { invoice: dup, duplicate: true };
    const m = await this.match(doc, companyId);
    const invoice = await InboundInvoice.create({
      ...doc, companyId, source, matchedVendorId: m.vendorId || null, suggestedPurchaseOrderId: m.purchaseOrderId || null, matchNote: m.note, ...extra,
    });
    return { invoice, duplicate: false };
  }

  static async list(req, { status, page = 1, limit = 25, recorded } = {}) {
    const { companyId } = getTenant(req);
    const q = { companyId };
    if (status) q.status = status;
    if (String(recorded) === "0") { q.kind = { $ne: "credit_note" }; q.purchaseOrderId = { $in: [null, undefined] }; }
    const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const [rows, total] = await Promise.all([
      InboundInvoice.find(q).sort({ createdAt: -1 }).skip((Math.max(Number(page) || 1, 1) - 1) * lim).limit(lim)
        .populate("matchedVendorId", "vendorName").populate("suggestedPurchaseOrderId", "transactionNo totalAmount").lean(),
      InboundInvoice.countDocuments(q),
    ]);
    return { rows, total };
  }

  // The tax code a received line maps to: S at its rate -> the active standard code of that rate, Z / E / O / AE -> the code of that kind.
  static taxCodeFor(codes, line) {
    const KIND = { Z: "zero_rated", E: "exempt", O: "out_of_scope", AE: "reverse_charge" };
    if (line.taxCategory === "S") return codes.find((c) => c.kind === "standard" && Math.abs(Number(c.ratePercent) - Number(line.taxRatePercent)) < 0.005) || null;
    const kind = KIND[line.taxCategory];
    return kind ? codes.find((c) => c.kind === kind) || null : null;
  }

  // Record a received supplier invoice as a DRAFT purchase invoice (never approved here: approving is the ordinary purchase approval).
  // The person names an item for each received line; the tax comes from the supplier's own category and rate. Any difference between
  // the draft's total and what the supplier billed is returned for the screen to show, never hidden.
  static async recordAsPurchase(id, body = {}, req) {
    const { companyId } = getTenant(req);
    const TransactionService = require("../orderPurchase/transactionService"); // late: it is a large module
    const TaxCode = require("../../models/modules/financial/taxCodeModel");
    const Stock = require("../../models/modules/stockModel");
    const inv = await InboundInvoice.findOne({ _id: id, companyId });
    if (!inv) throw new AppError("Inbound invoice not found", 404);
    if (inv.status !== "RECEIVED") throw new AppError(`This invoice was already ${inv.status.toLowerCase()}`, 409, "ALREADY_DECIDED");
    if (inv.kind === "credit_note") throw new AppError("A supplier's credit note is accepted or rejected here; it cannot be recorded as a purchase invoice yet", 422, "INBOUND_IS_CREDIT_NOTE");
    if (!inv.matchedVendorId) throw new AppError("Add the vendor first (its TRN or participant id must match the supplier), then check again", 422, "VENDOR_NOT_MATCHED");
    const picked = Array.isArray(body.lines) ? body.lines : [];
    if (!inv.lines.length) throw new AppError("The received invoice has no lines", 422, "NO_LINES");

    const dup = await Transaction.exists({ type: "purchase_order", partyId: inv.matchedVendorId, vendorReference: inv.documentId, status: { $ne: "REJECTED" } });
    if (dup) throw new AppError(`A purchase invoice from this supplier with number ${inv.documentId} already exists`, 409, "DUPLICATE_SUPPLIER_INVOICE");

    const codes = await TaxCode.find({ companyId, isActive: true }).lean();
    const items = [];
    for (let i = 0; i < inv.lines.length; i += 1) {
      const l = inv.lines[i];
      const itemId = picked[i]?.itemId;
      if (!itemId || !mongoose.isValidObjectId(itemId)) throw new AppError(`Choose the item for line ${i + 1} (${l.itemName || "no name"})`, 400, "ITEM_REQUIRED");
      const stock = await Stock.findById(itemId).select("itemName").lean();
      if (!stock) throw new AppError(`Item for line ${i + 1} not found`, 404, "ITEM_NOT_FOUND");
      const code = this.taxCodeFor(codes, l);
      if (!code) throw new AppError(`Line ${i + 1}: no active tax code matches ${l.taxCategory || "its tax"} at ${l.taxRatePercent}%. Add one in Accounting setup, then try again`, 422, "TAX_CODE_NOT_FOUND");
      const qty = Number(l.quantity) || 0;
      const net = round2(l.lineNetAmount);
      if (!(qty > 0)) throw new AppError(`Line ${i + 1} has no quantity`, 422, "NO_QUANTITY");
      const price = Math.round((net / qty) * 1e6) / 1e6; // the line's net / quantity: the draft's line then reproduces the supplier's net
      items.push({ itemId, description: l.itemName || stock.itemName, qty, price, rate: net, taxCodeId: code._id });
    }

    const by = req?.admin?.id ? String(req.admin.id) : null;
    const draft = await TransactionService.createTransaction({
      type: "purchase_order", status: "DRAFT", partyId: inv.matchedVendorId, partyType: "Vendor", partyTypeRef: "Vendor",
      vendorReference: inv.documentId, date: inv.issueDate || new Date(), items,
    }, by);
    inv.purchaseOrderId = draft._id;
    inv.status = "ACCEPTED";
    inv.decision = { by, at: new Date(), reason: `Recorded as purchase invoice ${draft.transactionNo}` };
    await inv.save();
    await AuditService.log({ req, action: "INBOUND_EINVOICE_RECORDED", entity: "InboundInvoice", entityId: inv._id, summary: `${inv.documentId} from ${inv.sellerName} -> ${draft.transactionNo}` });
    const received = round2(inv.totals?.payable);
    return { transactionId: draft._id, transactionNo: draft.transactionNo, total: round2(draft.totalAmount), receivedTotal: received, difference: round2(draft.totalAmount - received) };
  }

  static async decide(id, decision, { reason, purchaseOrderId } = {}, req) {
    const { companyId } = getTenant(req);
    const inv = await InboundInvoice.findOne({ _id: id, companyId });
    if (!inv) throw new AppError("Inbound invoice not found", 404);
    if (inv.status !== "RECEIVED") throw new AppError(`This invoice was already ${inv.status.toLowerCase()}`, 409, "ALREADY_DECIDED");

    if (decision === "REJECTED" && !String(reason || "").trim()) {
      throw new AppError("Give a reason for rejecting the invoice", 400, "REASON_REQUIRED");
    }
    if (decision === "ACCEPTED") {
      const poId = purchaseOrderId || inv.suggestedPurchaseOrderId;
      if (poId) {
        if (!mongoose.isValidObjectId(poId)) throw new AppError("Invalid purchase order", 400);
        const po = await Transaction.findOne({ _id: poId, type: "purchase_order" }).select("partyId").lean();
        if (!po) throw new AppError("Purchase order not found", 404);
        if (inv.matchedVendorId && String(po.partyId) !== String(inv.matchedVendorId)) {
          throw new AppError("That purchase order belongs to a different vendor", 400, "VENDOR_MISMATCH");
        }
        inv.purchaseOrderId = poId;
      }
    }
    inv.status = decision;
    inv.decision = { by: req?.admin?.id ? String(req.admin.id) : null, at: new Date(), reason: reason || undefined };
    await inv.save();
    await AuditService.log({ req, action: `INBOUND_EINVOICE_${decision}`, entity: "InboundInvoice", entityId: inv._id, summary: `${inv.documentId} from ${inv.sellerName}`, after: inv.decision });
    return inv;
  }
}

module.exports = InboundService;
