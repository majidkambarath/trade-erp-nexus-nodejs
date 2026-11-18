const mongoose = require("mongoose");
const Transaction = require("../../models/modules/transactionModel");
const Customer = require("../../models/modules/customerModel");
const Vendor = require("../../models/modules/vendorModel");
const { LedgerEntry } = require("../../models/modules/financial/financialModels");
const AccountConfigService = require("../financial/accountConfigService");
const AppError = require("../../utils/AppError");
const { round2 } = require("../../utils/accounting");
const { dayStart, dayEnd } = require("./ledgerReportsService");
const { gstr1, gstr3b } = require("../../utils/gstReturns");
const { GST_KEYS } = require("../../utils/gst");
const { stateName } = require("../../utils/gstStates");

// India's GST returns, read live from the approved documents so they can never disagree with them, and reconciled to the six
// component accounts of the ledger. See utils/gstReturns.js for what a return holds and what this version leaves out.
//
//   What counts: approved sales invoices, credit notes, purchase bills and purchase returns that were priced WITH their tax by
//   component (gstType on the document). One priced before that, or while the company's own state was not on file, carries total
//   tax only: it cannot be placed in a table honestly, so it is listed apart (`withoutGstDetail`) and never guessed into one.
//   Tax on expense vouchers and debit / credit notes is posted to the single Input / Output GST account with no component; the
//   reconciliation shows that movement as its own line.
const num = (n) => Number(n) || 0;
const OUT = { sales_order: 1, sales_return: -1 };
const IN = { purchase_order: 1, purchase_return: -1 };
const TYPES = [...Object.keys(OUT), ...Object.keys(IN)];

// the treatment of a line, from the tax code's kind kept on it; a line with tax and no kind is standard, a 0% one with no kind is unclassified
const kindOf = (it) => it.taxKind || (num(it.vatAmount) > 0 ? "standard" : "unclassified");
const taxableOf = (it) => (it.taxableAmount != null ? num(it.taxableAmount) : round2(num(it.grossAmount) - num(it.discountAmount)));

class GstReturnService {
  static period({ from, to }) {
    const start = dayStart(from);
    const end = dayEnd(to);
    if (!start || !end) throw new AppError("Choose the first and last day of the period", 400, "PERIOD_REQUIRED");
    if (start > end) throw new AppError("The period ends before it starts", 400, "INVALID_PERIOD");
    return { start, end };
  }

  /**
   * Every line of the period as the flat list utils/gstReturns.js reads, plus what could not be placed.
   * -> { lines, withoutGstDetail: { documents, taxable, tax }, unclassified: { lines, taxable } }
   */
  static async collect({ from, to }) {
    const { start, end } = this.period({ from, to });
    const docs = await Transaction.find({ status: "APPROVED", isOpening: { $ne: true }, type: { $in: TYPES }, date: { $gte: start, $lte: end } })
      .select("transactionNo type date partyId partyType items charges totalAmount gstType placeOfSupply supplierState")
      .lean();

    const ids = (type) => [...new Set(docs.filter((d) => d.partyType === type).map((d) => String(d.partyId)))];
    const [customers, vendors] = await Promise.all([
      Customer.find({ _id: { $in: ids("Customer") } }).select("customerName vat trnNumber").lean(),
      Vendor.find({ _id: { $in: ids("Vendor") } }).select("vendorName vat trnNO").lean(),
    ]);
    const partyOf = new Map();
    for (const c of customers) partyOf.set(String(c._id), { id: String(c._id), name: c.customerName, gstin: c.vat?.status === "registered" || c.vat?.trn || c.trnNumber ? c.vat?.trn || c.trnNumber || null : null });
    for (const v of vendors) partyOf.set(String(v._id), { id: String(v._id), name: v.vendorName, gstin: v.vat?.trn || v.trnNO || null });

    const lines = [];
    const withoutGstDetail = { documents: 0, taxable: 0, tax: 0 };
    const unclassified = { lines: 0, taxable: 0 };
    for (const d of docs) {
      const sign = OUT[d.type] ?? IN[d.type];
      const direction = d.type in OUT ? "output" : "input";
      if (!d.gstType) {
        withoutGstDetail.documents += 1;
        for (const it of d.items || []) {
          withoutGstDetail.taxable = round2(withoutGstDetail.taxable + sign * taxableOf(it));
          withoutGstDetail.tax = round2(withoutGstDetail.tax + sign * num(it.vatAmount));
        }
        continue;
      }
      const base = {
        docId: String(d._id), docNo: d.transactionNo, docType: d.type, date: d.date, direction, sign, gstType: d.gstType,
        placeOfSupply: d.placeOfSupply || null, docValue: num(d.totalAmount), party: partyOf.get(String(d.partyId)) || { id: String(d.partyId), name: "", gstin: null },
      };
      for (const it of d.items || []) {
        const kind = kindOf(it);
        if (kind === "unclassified") {
          unclassified.lines += 1;
          unclassified.taxable = round2(unclassified.taxable + sign * taxableOf(it));
          continue;
        }
        lines.push({
          ...base, hsnCode: it.hsnCode || "", qty: num(it.qty), kind, rate: num(it.vatPercent), taxable: taxableOf(it),
          cgst: num(it.gst?.cgst), sgst: num(it.gst?.sgst), igst: num(it.gst?.igst),
          rcmCgst: num(it.rcmGst?.cgst), rcmSgst: num(it.rcmGst?.sgst), rcmIgst: num(it.rcmGst?.igst),
        });
      }
      for (const c of d.charges || []) {
        if (!(num(c.amount) > 0)) continue;
        lines.push({
          ...base, charge: true, hsnCode: "", qty: 0, kind: num(c.vatAmount) > 0 ? "standard" : "exempt", rate: num(c.vatPercent), taxable: num(c.amount),
          cgst: num(c.gst?.cgst), sgst: num(c.gst?.sgst), igst: num(c.gst?.igst), rcmCgst: 0, rcmSgst: 0, rcmIgst: 0,
        });
      }
    }
    return { lines, withoutGstDetail, unclassified };
  }

  // The documents' tax by component for one direction, signed (returns reduce it); reverse-charge tax counts as input as well.
  static documentTax(lines, direction) {
    const t = { cgst: 0, sgst: 0, igst: 0 };
    for (const l of lines.filter((x) => x.direction === direction)) {
      t.cgst = round2(t.cgst + l.sign * (l.cgst + (direction === "input" ? l.rcmCgst : 0)));
      t.sgst = round2(t.sgst + l.sign * (l.sgst + (direction === "input" ? l.rcmSgst : 0)));
      t.igst = round2(t.igst + l.sign * (l.igst + (direction === "input" ? l.rcmIgst : 0)));
    }
    return t;
  }

  // What the ledger moved on one posting key in the period (credit side for output tax, debit side for input tax). null: the key is not mapped.
  static async ledgerNet(key, side, { start, end }) {
    let accountId;
    try {
      accountId = await AccountConfigService.resolveAccount(key);
    } catch (err) {
      if (err.code === "ACCOUNT_NOT_CONFIGURED") return null;
      throw err;
    }
    const [row] = await LedgerEntry.aggregate([
      { $match: { accountId: new mongoose.Types.ObjectId(String(accountId)), isReversed: { $ne: true }, date: { $gte: start, $lte: end } } },
      { $group: { _id: null, debit: { $sum: "$debitAmount" }, credit: { $sum: "$creditAmount" } } },
    ]);
    if (!row) return 0;
    return round2(side === "credit" ? row.credit - row.debit : row.debit - row.credit);
  }

  /**
   * The documents against the ledger, by component: output tax (credits on the three Output accounts), input tax (debits on the three
   * Input accounts, reverse-charge input included), and the tax posted without a component (expense vouchers, notes) on the single
   * Input / Output GST accounts, which is not in any document table.
   */
  static async reconcile({ from, to, lines }) {
    const range = this.period({ from, to });
    const docs = { output: this.documentTax(lines, "output"), input: this.documentTax(lines, "input") };
    const rows = [];
    for (const [direction, side] of [["output", "credit"], ["input", "debit"]]) {
      for (const c of ["cgst", "sgst", "igst"]) {
        const ledger = await this.ledgerNet(GST_KEYS[direction][c], side, range);
        const documents = docs[direction][c];
        const difference = ledger == null ? null : round2(documents - ledger);
        rows.push({ label: `${direction === "output" ? "Output" : "Input"} ${c.toUpperCase()}`, direction, component: c, documents, ledger, difference, agrees: ledger != null && Math.abs(documents - ledger) < 0.01 });
      }
    }
    const [unsplitOutput, unsplitInput] = await Promise.all([this.ledgerNet("vat-sales", "credit", range), this.ledgerNet("vat-purchase", "debit", range)]);
    return { rows, unsplit: { output: unsplitOutput || 0, input: unsplitInput || 0 } };
  }

  static async gstr1(query) {
    const { lines, withoutGstDetail, unclassified } = await this.collect(query);
    const report = gstr1(lines);
    return { period: { from: query.from, to: query.to }, ...report, notReported: { withoutGstDetail, unclassified }, placeNames: this.placeNames(lines) };
  }

  static async gstr3b(query) {
    const { lines, withoutGstDetail, unclassified } = await this.collect(query);
    const report = gstr3b(lines);
    const reconciliation = await this.reconcile({ ...query, lines });
    return { period: { from: query.from, to: query.to }, ...report, reconciliation, notReported: { withoutGstDetail, unclassified } };
  }

  // the state names the lines refer to, so a table can print "Karnataka" beside 29
  static placeNames(lines) {
    const names = {};
    for (const l of lines) if (l.placeOfSupply && !names[l.placeOfSupply]) names[l.placeOfSupply] = stateName(l.placeOfSupply);
    return names;
  }
}

module.exports = GstReturnService;
