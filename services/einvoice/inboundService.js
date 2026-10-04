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
    const open = await Transaction.find({ type: "purchase_order", status: "APPROVED", partyId: vendor._id })
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
  static async ingest(payload, { source = "manual", req } = {}) {
    const { companyId } = getTenant(req);
    const doc = this.normalise(payload);
    if (!doc.documentId) throw new AppError("documentId is required", 400);
    const dup = await InboundInvoice.findOne({ companyId, providerId: doc.providerId });
    if (dup) return { invoice: dup, duplicate: true };
    const m = await this.match(doc, companyId);
    const invoice = await InboundInvoice.create({
      ...doc, companyId, source, matchedVendorId: m.vendorId || null, suggestedPurchaseOrderId: m.purchaseOrderId || null, matchNote: m.note,
    });
    return { invoice, duplicate: false };
  }

  static async list(req, { status, page = 1, limit = 25 } = {}) {
    const { companyId } = getTenant(req);
    const q = { companyId };
    if (status) q.status = status;
    const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const [rows, total] = await Promise.all([
      InboundInvoice.find(q).sort({ createdAt: -1 }).skip((Math.max(Number(page) || 1, 1) - 1) * lim).limit(lim)
        .populate("matchedVendorId", "vendorName").populate("suggestedPurchaseOrderId", "transactionNo totalAmount").lean(),
      InboundInvoice.countDocuments(q),
    ]);
    return { rows, total };
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
