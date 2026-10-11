const mongoose = require("mongoose");
const { Voucher, LedgerEntry, LedgerAccount } = require("../../models/modules/financial/financialModels");
const OpeningBalanceVoucher = require("../../models/modules/financial/openingBalanceModel");
const FiscalYear = require("../../models/modules/financial/fiscalYearModel");
const Transaction = require("../../models/modules/transactionModel");
const ActivityLog = require("../../models/modules/financial/activityLogModel");
const { Cheque } = require("../../models/modules/banking/bankingModels");
const AccountConfigService = require("./accountConfigService");
const { round2, splitEntries, isReversalRow } = require("../core/postingTrail");
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

// A posting whose number is shown in the ledger but which has no Voucher behind it: the ledger
// rows are the record. Each kind keeps its facts somewhere of its own (the opening voucher, the
// fiscal year that was closed, the account that was opened with a balance), so the trail finds
// them there instead of answering "Voucher not found" for a number the ledger itself printed.
const SOURCE_LABEL = {
  opening: "Opening balance",
  opening_stock: "Opening stock",
  closing: "Year-end closing",
  stock_adjustment: "Stock adjustment",
  stock_writeoff: "Stock write-off",
  cheque_clearance: "Cheque clearing",
};

const fact = (label, value, type = "text") => (value === null || value === undefined || value === "" ? null : { label, value, type });

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
    if (!v) return this.postingTrail(id);

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
      activity: this.activityRows(activity),
    };
  }

  static activityRows(rows) {
    return rows.map((a) => ({
      _id: a._id,
      at: a.at,
      action: a.action,
      username: a.username,
      summary: a.summary,
      before: a.before,
      after: a.after,
      ip: a.ip,
    }));
  }

  // The trail of a posting that has no Voucher behind it: an opening balance, opening stock, a
  // year-end closing entry, an account opened with a balance, a stock adjustment or write-off.
  // Same shape as a voucher's trail, so the screen is one component; `source` says what it is and
  // carries the facts that kind keeps. It answers 404 only when nothing was posted under the id.
  static async postingTrail(id) {
    const entries = await LedgerEntry.find({ voucherId: id }).sort({ createdAt: 1, _id: 1 }).lean();
    if (!entries.length) throw new AppError("Voucher not found", 404);

    const { companyId } = getTenant();
    const head = entries.find((e) => !isReversalRow(e)) || entries[0];
    const kind = head.voucherType;
    // a reversal marks every row of the posting reversed, the original and its reversal alike
    let status = entries.every((e) => e.isReversed) ? "reversed" : "posted";
    let narration = head.narration || null;
    let facts = [];
    let label = SOURCE_LABEL[kind] || (kind ? String(kind).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Posting");
    let year = null;
    let account = null;

    if (kind === "opening" || kind === "opening_stock") {
      const ob = await OpeningBalanceVoucher.findById(id).lean();
      if (ob) {
        if (ob.status === "reversed") status = "reversed";
        narration = ob.narration || narration;
        facts =
          ob.section === "stock"
            ? [fact("Items", (ob.rows || []).length, "number"), fact("Stock value", round2(ob.totalValue), "money")]
            : [
                fact("Accounts", (ob.lines || []).length, "number"),
                fact("Total debit", round2(ob.totalDebit), "money"),
                fact("Total credit", round2(ob.totalCredit), "money"),
                ob.differenceAmount > 0
                  ? fact(`Balancing figure to Opening Balance Equity (${ob.differenceSide})`, round2(ob.differenceAmount), "money")
                  : null,
              ];
        if (ob.reversedAt) facts.push(fact("Reversed on", ob.reversedAt, "datetime"));
      } else if (head.referenceType === "opening_invoice") {
        // a customer's or vendor's opening invoice is a trade document: its id is the voucherId
        const t = await Transaction.findById(id).select("transactionNo type date totalAmount").lean();
        label = "Opening invoice";
        if (t) {
          facts = [fact("Invoice", t.transactionNo), fact("Document", DOC_LABEL[t.type] || t.type), fact("Amount", round2(t.totalAmount), "money")];
        }
      } else if (kind === "opening") {
        // an account created with an opening balance: the account's own id is the voucherId
        account = await LedgerAccount.findById(id).select("accountCode accountName openingBalance openingSide").lean();
        if (account) {
          facts = [
            fact("Account", `${account.accountCode} ${account.accountName}`),
            fact("Opening balance", round2(account.openingBalance), "money"),
            fact("Side", account.openingSide === "credit" ? "Credit" : account.openingSide === "debit" ? "Debit" : null),
          ];
        }
      }
    } else if (kind === "closing") {
      year =
        (await FiscalYear.findOne({ "closing.voucherId": id }).lean()) ||
        // a year since reopened has lost its `closing`; the entries still name the year
        (head.financialYear ? await FiscalYear.findOne({ code: head.financialYear }).lean() : null);
      const c = year?.closing && String(year.closing.voucherId) === String(id) ? year.closing : null;
      facts = [
        fact("Fiscal year", year?.code || head.financialYear),
        c ? fact("Income", round2(c.income), "money") : null,
        c ? fact("Expenses", round2(c.expenses), "money") : null,
        c ? fact(c.profit < 0 ? "Loss moved to equity" : "Profit moved to equity", round2(Math.abs(c.profit)), "money") : null,
        c ? fact("Moved to", c.retainedAccountName) : null,
        c ? fact("Accounts closed", c.accounts, "number") : null,
        c && year.closedAt ? fact("Closed on", year.closedAt, "datetime") : null,
      ];
    }

    const sourceActivity = [{ entityId: String(id) }];
    // closing and reopening a year is logged against the year, not against the entry it posted
    if (year) sourceActivity.push({ entity: "FiscalYear", entityId: String(year._id), action: { $in: ["PERIOD_CLOSED", "PERIOD_REOPENED"] } });
    const activity = await ActivityLog.find({ companyId, $or: sourceActivity }).sort({ at: 1, _id: 1 }).lean();

    const ledger = splitEntries(entries);
    return {
      voucher: {
        _id: id,
        voucherNo: head.voucherNo,
        voucherType: kind,
        typeLabel: label,
        date: head.date,
        status,
        approvalStatus: null,
        totalAmount: ledger.totals.debit,
        onAccountAmount: 0,
        partyName: null,
        partyType: null,
        paymentMode: null,
        paymentAccountName: null,
        narration,
        ledgerBased: true,
        currency: null,
        exchangeRate: null,
        createdAt: entries[0].createdAt,
        updatedAt: entries[entries.length - 1].createdAt,
      },
      source: { kind, label, facts: facts.filter(Boolean) },
      ledger: {
        postingEnabled: true,
        ...ledger,
        note: status === "reversed" ? "This posting was reversed; its entries were taken back." : null,
      },
      allocations: [],
      onAccount: 0,
      cheque: null,
      activity: this.activityRows(activity),
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
