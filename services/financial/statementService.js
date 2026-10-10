const mongoose = require("mongoose");
const { LedgerAccount, LedgerEntry, Voucher } = require("../../models/modules/financial/financialModels");
const Transaction = require("../../models/modules/transactionModel");
const AccountConfigService = require("./accountConfigService");
const AppError = require("../../utils/AppError");
const { round2 } = require("../../utils/accounting");

// Statement of account for one customer or vendor, read from the ledger so it always agrees with
// the Trial Balance: invoices, returns, receipts and payments, in date order, with a running
// balance computed on the server (opening + movement = closing).
//
// While ledger posting is switched off nothing is written to the ledger for invoices and returns,
// so the statement is built from the approved documents themselves (invoices, returns, receipts,
// payments) instead of showing an empty page. `source` says which one was used.
//
//   customer:  balance = debits - credits   (positive = they owe us)
//   vendor:    balance = credits - debits   (positive = we owe them)
class StatementService {
  static escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  static async partyAccountIds(partyType, name) {
    // the party's own account and its advance account: "Customer Advance - X" and "Advance to Vendor - X" (partyAccounts.js KINDS)
    const prefix = partyType === "Vendor" ? "(Vendor|Advance to Vendor)" : "(Customer|Customer Advance)";
    const exact = new RegExp(`^${prefix} - ${this.escape(name)}$`);
    const accounts = await LedgerAccount.find({ accountName: exact }).select("_id").lean();
    return accounts.map((a) => a._id);
  }

  static async getStatement({ partyId, partyType, from, to }) {
    if (!mongoose.isValidObjectId(partyId) || !["Customer", "Vendor"].includes(partyType)) {
      throw new AppError("partyId and partyType (Customer or Vendor) are required", 400);
    }
    const Party = mongoose.model(partyType);
    const party = await Party.findById(partyId).lean();
    if (!party) throw new AppError(`${partyType} not found`, 404);
    const name = partyType === "Vendor" ? party.vendorName : party.customerName;

    const sign = partyType === "Vendor" ? -1 : 1; // net = sign * (debit - credit)
    const empty = { party: { _id: party._id, name, type: partyType }, from: from || null, to: to || null, opening: 0, rows: [], closing: 0, totals: { debit: 0, credit: 0 }, source: "ledger" };

    const postingOn = await AccountConfigService.isPostingEnabled();
    const accountIds = postingOn ? await this.partyAccountIds(partyType, name) : [];
    let source = "ledger";
    let movements;
    if (postingOn) {
      if (!accountIds.length) return empty;
      movements = await this.ledgerMovements(accountIds);
    } else {
      source = "documents";
      movements = await this.documentMovements(partyId, partyType);
    }

    // movements: { _id, date, voucherNo, voucherType, narration, debit, credit }, any order
    movements.sort((a, b) => new Date(a.date) - new Date(b.date) || String(a._id).localeCompare(String(b._id)));
    let opening = 0;
    if (from) {
      const before = movements.filter((m) => new Date(m.date) < new Date(from));
      opening = round2(sign * before.reduce((t, m) => t + m.debit - m.credit, 0));
    }
    const entries = movements.filter((m) => (!from || new Date(m.date) >= new Date(from)) && (!to || new Date(m.date) <= new Date(to)));

    let running = opening;
    const rows = entries.map((e) => {
      running = round2(running + sign * (e.debit - e.credit));
      return {
        _id: e._id, date: e.date, voucherNo: e.voucherNo, voucherType: e.voucherType,
        narration: e.narration, debit: round2(e.debit), credit: round2(e.credit), balance: running,
      };
    });
    return {
      ...empty,
      opening,
      rows,
      closing: running,
      source,
      totals: { debit: round2(entries.reduce((t, e) => t + e.debit, 0)), credit: round2(entries.reduce((t, e) => t + e.credit, 0)) },
    };
  }

  static async ledgerMovements(accountIds) {
    const entries = await LedgerEntry.find({ accountId: { $in: accountIds }, isReversed: { $ne: true } }).lean();
    return entries.map((e) => ({
      _id: e._id, date: e.date, voucherNo: e.voucherNo, voucherType: e.voucherType,
      narration: e.narration, debit: e.debitAmount, credit: e.creditAmount,
    }));
  }

  // Approved documents only: drafts, rejected and cancelled ones never reached the party's balance.
  static async documentMovements(partyId, partyType) {
    const isVendor = partyType === "Vendor";
    const types = isVendor ? ["purchase_order", "purchase_return"] : ["sales_order", "sales_return"];
    const LABEL = {
      sales_order: "Sales invoice", sales_return: "Sales return",
      purchase_order: "Purchase invoice", purchase_return: "Purchase return",
    };
    const [docs, vouchers] = await Promise.all([
      Transaction.find({ partyId, type: { $in: types }, status: "APPROVED" }).select("transactionNo type date totalAmount isOpening docno").lean(),
      Voucher.find({ partyId, partyType, status: "approved", voucherType: { $in: ["receipt", "payment"] } })
        .select("voucherNo voucherType date totalAmount narration paymentMode").lean(),
    ]);
    const rows = [];
    for (const d of docs) {
      // customers owe us for sales and are credited for returns; vendors are the other way round
      const increases = d.type === "sales_order" || d.type === "purchase_order";
      const amount = round2(d.totalAmount);
      rows.push({
        _id: d._id, date: d.date, voucherNo: d.transactionNo, voucherType: d.type,
        narration: d.isOpening ? `Opening ${d.type === "sales_order" ? "sales" : "purchase"} invoice${d.docno ? " " + d.docno : ""}` : LABEL[d.type],
        debit: isVendor ? (increases ? 0 : amount) : (increases ? amount : 0),
        credit: isVendor ? (increases ? amount : 0) : (increases ? 0 : amount),
      });
    }
    for (const v of vouchers) {
      const amount = round2(v.totalAmount);
      const mode = v.paymentMode ? ` (${v.paymentMode === "online" ? "transfer" : v.paymentMode})` : "";
      rows.push({
        _id: v._id, date: v.date, voucherNo: v.voucherNo, voucherType: v.voucherType,
        narration: `${v.voucherType === "receipt" ? "Receipt" : "Payment"}${mode}${v.narration ? " - " + v.narration : ""}`,
        // a receipt reduces what a customer owes; a payment reduces what we owe a vendor
        debit: v.voucherType === "payment" ? amount : 0,
        credit: v.voucherType === "receipt" ? amount : 0,
      });
    }
    return rows;
  }
}

module.exports = StatementService;
