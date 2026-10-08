const mongoose = require("mongoose");
const Transaction = require("../../models/modules/transactionModel");
const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const Stock = require("../../models/modules/stockModel");
const DebitLog = require("../../models/modules/DebitLog");
const CreditLog = require("../../models/modules/CreditLog");
const ActivityLog = require("../../models/modules/financial/activityLogModel");
const { LedgerEntry, Voucher } = require("../../models/modules/financial/financialModels");
const { EInvoiceSubmission } = require("../../models/modules/einvoiceModels");
const { DocumentSend, ShareLink } = require("../../models/modules/messagingModels");
const AccountConfigService = require("../financial/accountConfigService");
const { getTenant } = require("../../utils/tenant");
const AppError = require("../../utils/AppError");
const { round2, splitEntries } = require("../core/postingTrail");

const TYPE_LABEL = {
  purchase_order: "Purchase order",
  sales_order: "Sales order",
  purchase_return: "Purchase return",
  sales_return: "Sales return",
};

class DocumentAuditService {
  // The few fields worth keeping in an audit row. A whole document would bloat the log and
  // repeat what the document itself already holds.
  static snapshot(transaction) {
    if (!transaction) return null;
    const t = typeof transaction.toObject === "function" ? transaction.toObject() : transaction;
    return {
      transactionNo: t.transactionNo,
      type: t.type,
      status: t.status,
      date: t.date,
      partyId: t.partyId,
      partyType: t.partyType,
      totalAmount: round2(t.totalAmount),
      vatAmount: round2(t.pricing?.vatTotal ?? t.vatAmount),
      discount: round2(t.discount),
      items: (t.items || []).length,
      refNo: t.lpono || null,
      docNo: t.docno || null,
    };
  }

  // The same shape, read fresh. Used for the "before" side of an update, where the controller
  // only has the id. Returns null rather than throwing: a missing row must not fail the request.
  static async snapshotOf(id) {
    try {
      if (!mongoose.isValidObjectId(id)) return null;
      return this.snapshot(await Transaction.findById(id).lean());
    } catch (err) {
      console.error("[audit] could not read a document before an edit:", err.message);
      return null;
    }
  }

  static describe(transaction) {
    const t = transaction || {};
    return `${TYPE_LABEL[t.type] || t.type} ${t.transactionNo} - ${round2(t.totalAmount).toFixed(2)}`;
  }

  // What a document actually wrote, counted. Cheap enough to run on every approval, so the audit
  // row can say what the approval did rather than only that it happened. Like the log it feeds,
  // it never throws: counting for an audit row must not fail the write it describes.
  static async effects(transactionId, partyType) {
    try {
      const PartyLog = partyType === "Vendor" ? DebitLog : CreditLog;
      const [ledgerEntries, stockMovements, partyLogs] = await Promise.all([
        LedgerEntry.countDocuments({ voucherId: transactionId }),
        InventoryMovement.countDocuments({ referenceType: "Transaction", referenceId: transactionId }),
        PartyLog.countDocuments({ ref: { $in: [String(transactionId), `REV-${transactionId}`] } }),
      ]);
      return { ledgerEntries, stockMovements, partyLogs };
    } catch (err) {
      console.error("[audit] could not count a document's effects:", err.message);
      return null;
    }
  }

  // Everything one trade document did: the entries it posted, the stock it moved, the party
  // balance it changed, the vouchers that settled it, its e-invoice, and who did what to it.
  // Read-only - it never repairs or back-fills anything it finds missing.
  static async trail(id) {
    if (!mongoose.isValidObjectId(id)) throw new AppError("Transaction not found", 404);
    const doc = await Transaction.findById(id).lean();
    if (!doc) throw new AppError("Transaction not found", 404);

    const PartyLog = doc.partyType === "Vendor" ? DebitLog : CreditLog;
    const partyKey = doc.partyType === "Vendor" ? "vendorId" : "customerId";
    const { companyId } = getTenant();

    const [entries, movements, partyRows, settlements, activity, einvoice, sends, shares, postingEnabled, party] =
      await Promise.all([
        LedgerEntry.find({ voucherId: doc._id }).sort({ createdAt: 1, _id: 1 }).lean(),
        InventoryMovement.find({ referenceType: "Transaction", referenceId: doc._id })
          .sort({ date: 1, createdAt: 1 })
          .lean(),
        PartyLog.find({ [partyKey]: doc.partyId, ref: { $in: [String(doc._id), `REV-${doc._id}`] } })
          .sort({ createdAt: 1 })
          .lean(),
        Voucher.find({ "linkedInvoices.invoiceId": doc._id })
          .select("voucherNo voucherType date totalAmount status approvalStatus paymentMode linkedInvoices")
          .sort({ date: 1, createdAt: 1 })
          .lean(),
        ActivityLog.find({ companyId, entity: "Transaction", entityId: String(doc._id) })
          .sort({ at: 1, _id: 1 })
          .lean(),
        EInvoiceSubmission.findOne({ companyId, sourceType: "Transaction", sourceId: doc._id })
          .select("documentNo status taxStatus attempts lastError submittedAt acknowledgedAt reportedAt")
          .lean(),
        // how it went to the customer: every email and WhatsApp hand-over, and the links made for them
        DocumentSend.find({ companyId, sourceType: "Transaction", sourceId: doc._id })
          .select("channel status to phone subject sentAt failedAt lastError lastErrorCode openedAt sentByName attempts attachment.fileName attachment.bytes shareLinkId createdAt")
          .sort({ createdAt: -1 })
          .limit(50)
          .lean(),
        ShareLink.find({ companyId, sourceType: "Transaction", sourceId: doc._id })
          .select("publicId expiresAt revokedAt revokeReason fetchCount viewCount firstViewedAt createdAt")
          .sort({ createdAt: -1 })
          .limit(50)
          .lean(),
        AccountConfigService.isPostingEnabled().catch(() => false),
        this.partyName(doc),
      ]);

    const itemNames = await this.itemNames(movements);
    const ledger = splitEntries(entries);

    return {
      document: {
        _id: doc._id,
        transactionNo: doc.transactionNo,
        type: doc.type,
        typeLabel: TYPE_LABEL[doc.type] || doc.type,
        status: doc.status,
        date: doc.date,
        dueDate: doc.dueDate,
        isOpening: !!doc.isOpening,
        totalAmount: round2(doc.totalAmount),
        paidAmount: round2(doc.paidAmount),
        outstandingAmount: round2(doc.outstandingAmount),
        items: (doc.items || []).length,
        createdBy: doc.createdBy,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        grnGenerated: !!doc.grnGenerated,
        invoiceGenerated: !!doc.invoiceGenerated,
        creditNoteIssued: !!doc.creditNoteIssued,
      },
      party: { _id: doc.partyId, type: doc.partyType, name: party },
      ledger: { postingEnabled, ...ledger, note: this.ledgerNote(doc, ledger.posted, postingEnabled) },
      stock: {
        movements: movements.map((m) => ({
          _id: m._id,
          itemId: m.stockId,
          itemName: itemNames.get(m.stockId) || m.stockId,
          eventType: m.eventType,
          quantity: m.quantity,
          previousStock: m.previousStock,
          newStock: m.newStock,
          unitCost: round2(m.unitCost),
          totalValue: round2(m.totalValue),
          rateBefore: m.rateBefore,
          rateAfter: m.rateAfter,
          cogsAmount: m.cogsAmount == null ? null : round2(m.cogsAmount),
          costBasis: m.costBasis,
          batchNumber: m.batchNumber || null,
          date: m.date,
          isReversed: !!m.isReversed,
        })),
      },
      partyBalance: {
        rows: partyRows.map((r) => ({
          _id: r._id,
          type: r.type,
          date: r.date,
          invNo: r.invNo,
          amount: round2(r.amount),
          paid: round2(r.paid),
          balance: round2(r.balance),
          status: r.status,
          isReversal: String(r.ref || "").startsWith("REV-"),
        })),
      },
      settlements: settlements.map((v) => {
        const line = (v.linkedInvoices || []).find((l) => String(l.invoiceId) === String(doc._id));
        return {
          _id: v._id,
          voucherNo: v.voucherNo,
          voucherType: v.voucherType,
          date: v.date,
          paymentMode: v.paymentMode,
          status: v.approvalStatus || v.status,
          allocatedAmount: round2(line?.allocatedAmount),
          previousBalance: round2(line?.previousBalance),
          newBalance: round2(line?.newBalance),
        };
      }),
      einvoice: einvoice || null,
      sends,
      shares,
      activity: activity.map((a) => ({
        _id: a._id,
        at: a.at,
        action: a.action,
        username: a.username,
        summary: a.summary,
        before: a.before,
        after: a.after,
        ip: a.ip,
      })),
    };
  }

  // Why a document has no ledger entries. Each of these is a legitimate state, so the screen
  // says which one it is instead of showing an empty table.
  static ledgerNote(doc, hasEntries, postingEnabled) {
    if (hasEntries) return null;
    if (doc.status !== "APPROVED") return "Nothing is posted until the document is approved.";
    if (doc.isOpening) return "An opening document is posted by Opening balances, not by the sales or purchase template.";
    if (!postingEnabled) return "Ledger posting is off for this company, so approval moved stock and the party balance but posted no entries.";
    return "Approved but not posted. Opening the chart of accounts posts documents that missed the ledger.";
  }

  static async partyName(doc) {
    try {
      const Party = mongoose.model(doc.partyType === "Vendor" ? "Vendor" : "Customer");
      const party = await Party.findById(doc.partyId).select("vendorName customerName").lean();
      return party?.vendorName || party?.customerName || null;
    } catch (_) {
      return null;
    }
  }

  static async itemNames(movements) {
    const ids = [...new Set(movements.map((m) => m.stockId).filter(Boolean))];
    if (!ids.length) return new Map();
    const stocks = await Stock.find({ itemId: { $in: ids } }).select("itemId itemName").lean();
    return new Map(stocks.map((s) => [s.itemId, s.itemName]));
  }
}

module.exports = DocumentAuditService;
