const mongoose = require("mongoose");
const { Voucher, LedgerEntry } = require("../../models/modules/financial/financialModels");
const Transaction = require("../../models/modules/transactionModel");
const ActivityLog = require("../../models/modules/financial/activityLogModel");
const { Cheque } = require("../../models/modules/banking/bankingModels");
const AccountConfigService = require("./accountConfigService");
const { round2, splitEntries } = require("../core/postingTrail");
const { getTenant } = require("../../utils/tenant");
const AppError = require("../../utils/AppError");

const TYPE_LABEL = {
  receipt: "Receipt",
  payment: "Payment",
  journal: "Journal voucher",
  contra: "Contra voucher",
  expense: "Expense voucher",
  debit_note: "Debit note",
  credit_note: "Credit note",
};

const DOC_LABEL = {
  purchase_order: "Purchase order",
  sales_order: "Sales order",
  purchase_return: "Purchase return",
  sales_return: "Sales return",
};

class VoucherAuditService {
  // The few fields worth keeping in an audit row.
  static snapshot(voucher) {
    if (!voucher) return null;
    const v = typeof voucher.toObject === "function" ? voucher.toObject() : voucher;
    return {
      voucherNo: v.voucherNo,
      voucherType: v.voucherType,
      status: v.status,
      date: v.date,
      partyId: v.partyId?._id || v.partyId,
      partyName: v.partyName,
      totalAmount: round2(v.totalAmount),
      paymentMode: v.paymentMode || null,
      onAccountAmount: round2(v.onAccountAmount),
      allocations: (v.linkedInvoices || []).length,
      ledgerBased: !!v.ledgerBased,
      narration: v.narration || null,
    };
  }

  static async snapshotOf(id) {
    try {
      if (!mongoose.isValidObjectId(id)) return null;
      return this.snapshot(await Voucher.findById(id).lean());
    } catch (err) {
      console.error("[audit] could not read a voucher before an edit:", err.message);
      return null;
    }
  }

  static describe(voucher) {
    const v = voucher || {};
    return `${TYPE_LABEL[v.voucherType] || v.voucherType} ${v.voucherNo} - ${round2(v.totalAmount).toFixed(2)}`;
  }

  // What a voucher wrote, counted, for the audit row that records the save. Like the log it
  // feeds, it never throws: counting for an audit row must not fail the write it describes.
  static async effects(voucherId) {
    try {
      const [ledgerEntries, cheques] = await Promise.all([
        LedgerEntry.countDocuments({ voucherId }),
        Cheque.countDocuments({ voucherId }),
      ]);
      return { ledgerEntries, cheques };
    } catch (err) {
      console.error("[audit] could not count a voucher's effects:", err.message);
      return null;
    }
  }

  // Everything one voucher did: the double entry it posted, the invoices it settled, the cheque
  // it is waiting on, and who did what to it. Read-only.
  static async trail(id) {
    if (!mongoose.isValidObjectId(id)) throw new AppError("Voucher not found", 404);
    const v = await Voucher.findById(id).lean();
    if (!v) throw new AppError("Voucher not found", 404);

    const { companyId } = getTenant();
    const invoiceIds = (v.linkedInvoices || []).map((l) => l.invoiceId).filter(Boolean);

    const [entries, invoices, cheque, activity, postingEnabled] = await Promise.all([
      LedgerEntry.find({ voucherId: v._id }).sort({ createdAt: 1, _id: 1 }).lean(),
      invoiceIds.length
        ? Transaction.find({ _id: { $in: invoiceIds } })
            .select("transactionNo type date totalAmount paidAmount outstandingAmount status")
            .lean()
        : [],
      Cheque.findOne({ companyId, voucherId: v._id }).lean(),
      ActivityLog.find({ companyId, entity: "Voucher", entityId: String(v._id) })
        .sort({ at: 1, _id: 1 })
        .lean(),
      AccountConfigService.isPostingEnabled().catch(() => false),
    ]);

    const byId = new Map(invoices.map((t) => [String(t._id), t]));
    const ledger = splitEntries(entries);

    return {
      voucher: {
        _id: v._id,
        voucherNo: v.voucherNo,
        voucherType: v.voucherType,
        typeLabel: TYPE_LABEL[v.voucherType] || v.voucherType,
        date: v.date,
        // `status` is the voucher's own state, which is what every finance screen shows.
        // `approvalStatus` is the separate approval workflow and defaults to "pending" even on a
        // posted voucher, so it must not stand in for the status.
        status: v.status,
        approvalStatus: v.approvalStatus || null,
        totalAmount: round2(v.totalAmount),
        onAccountAmount: round2(v.onAccountAmount),
        partyName: v.partyName || null,
        partyType: v.partyType || null,
        paymentMode: v.paymentMode || null,
        paymentAccountName: v.paymentDetails?.accountName || null,
        narration: v.narration || null,
        ledgerBased: !!v.ledgerBased,
        currency: v.currency || null,
        exchangeRate: v.exchangeRate || null,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      },
      ledger: { postingEnabled, ...ledger, note: this.ledgerNote(v, ledger.posted, postingEnabled) },
      allocations: (v.linkedInvoices || []).map((l) => {
        const inv = byId.get(String(l.invoiceId));
        return {
          invoiceId: l.invoiceId,
          transactionNo: inv?.transactionNo || null,
          typeLabel: inv ? DOC_LABEL[inv.type] || inv.type : null,
          date: inv?.date || null,
          invoiceTotal: round2(inv?.totalAmount),
          allocatedAmount: round2(l.allocatedAmount),
          previousBalance: round2(l.previousBalance),
          newBalance: round2(l.newBalance),
          outstandingNow: round2(inv?.outstandingAmount),
          status: inv?.status || null,
        };
      }),
      onAccount: round2(v.onAccountAmount),
      cheque: cheque
        ? {
            _id: cheque._id,
            chequeNo: cheque.chequeNo,
            chequeDate: cheque.chequeDate,
            amount: round2(cheque.amount),
            status: cheque.status,
            direction: cheque.direction,
            isPDC: !!cheque.isPDC,
            drawnOnBankName: cheque.drawnOnBankName || null,
            clearedOn: cheque.clearedOn,
            bouncedOn: cheque.bouncedOn,
            reason: cheque.reason || null,
            history: cheque.history || [],
          }
        : null,
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

  // Why a voucher has no ledger entries. Each of these is a legitimate state, so the screen says
  // which one it is instead of showing an empty table.
  static ledgerNote(v, hasEntries, postingEnabled) {
    if (hasEntries) return null;
    const status = v.status;
    if (status === "cancelled") return "This voucher was cancelled; its entries were reversed.";
    if (status === "pending" || status === "draft") return "Nothing is posted until the voucher is approved.";
    if (v.ledgerBased === false && ["journal", "contra", "expense"].includes(v.voucherType))
      return "Posted in the older format, to the cash & bank accounts list, so it has no entries in the chart.";
    if (!postingEnabled) return "Ledger posting is off for this company, so this voucher posted no entries.";
    return "Approved but not posted. Opening the chart of accounts posts what missed the ledger.";
  }
}

module.exports = VoucherAuditService;
