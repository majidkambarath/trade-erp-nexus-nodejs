const mongoose = require("mongoose");
const Transaction = require("../../models/modules/transactionModel");
const { Voucher, LedgerEntry } = require("../../models/modules/financial/financialModels");
const TaxCode = require("../../models/modules/financial/taxCodeModel");
const VATReturn = require("../../models/modules/financial/vatReturnModel");
const AccountConfigService = require("../financial/accountConfigService");
const AppError = require("../../utils/AppError");
const { round2 } = require("../../utils/accounting");
const { getTenant } = require("../../utils/tenant");
const { dayStart, dayEnd } = require("./ledgerReportsService");

// The UAE VAT return (FTA form VAT 201), built live from the approved documents so it can never
// disagree with them, and reconciled to the VAT accounts of the ledger.
//
//   What counts: approved invoices and returns (never drafts, cancelled, rejected or the opening
//   invoices carried over from old books), expense vouchers with VAT, and debit / credit notes.
//   Returns and notes are NETTED into the box of the supply they correct.
//   Treatment of a line: its tax code's kind (snapshotted on the line when it was saved). A line
//   with VAT and no code is standard-rated; a 0% line with no code is "unclassified" and is listed
//   for the user to fix instead of being guessed into zero-rated or exempt.
//
// Boxes: 1a-1g standard-rated supplies by emirate, 3 reverse-charge supplies, 4 zero-rated,
// 5 exempt, 8 total; 9 standard-rated expenses, 10 reverse-charge expenses, 11 total;
// 12 output VAT due, 13 input VAT recoverable, 14 net VAT payable (box 12 - box 13).
// Boxes 2 (tourist refunds), 6 (goods imported) and 7 (adjustments) are not tracked yet and are
// listed as such rather than shown as zero.

const EMIRATES = [
  ["1a", "Abu Dhabi"], ["1b", "Dubai"], ["1c", "Sharjah"], ["1d", "Ajman"], ["1e", "Umm Al Quwain"], ["1f", "Ras Al Khaimah"], ["1g", "Fujairah"],
];
const BOX_OF_EMIRATE = Object.fromEntries(EMIRATES.map(([box, name]) => [name.toLowerCase(), box]));
const DEFAULT_RCM_PERCENT = 5;

const num = (v) => Number(v) || 0;

// The treatment of a document line: the snapshot kind, else inferred from its VAT, else unclassified.
function treatmentOf(kind, vatPercent, vatAmount) {
  if (kind) return kind;
  return num(vatPercent) > 0 || num(vatAmount) > 0 ? "standard" : "unclassified";
}

// A line's taxable value (before VAT, after the line discount).
function taxableOf(item) {
  if (num(item.taxableAmount) || num(item.vatAmount)) return num(item.taxableAmount);
  const gross = num(item.grossAmount) - num(item.discountAmount);
  return gross || num(item.qty) * num(item.price ?? item.rate);
}

class VatReturnService {
  static EMIRATES = EMIRATES;
  static treatmentOf = treatmentOf;

  // Every VAT-relevant line of the period as a flat list:
  // { source, docId, docNo, date, direction: output|input, partyId, partyType, partyName, kind, taxable, vat, rcmVat }
  // Amounts are signed: returns and notes that reverse a supply carry a minus.
  static async collect({ from, to }) {
    const start = dayStart(from);
    const end = dayEnd(to);
    if (!start || !end) throw new AppError("Choose the first and last day of the period", 400, "PERIOD_REQUIRED");
    if (start > end) throw new AppError("The period ends before it starts", 400, "INVALID_PERIOD");
    const lines = [];

    const docs = await Transaction.find({ status: "APPROVED", isOpening: { $ne: true }, date: { $gte: start, $lte: end } })
      .select("transactionNo type date partyId partyType items charges")
      .lean();
    const OUT = { sales_order: 1, sales_return: -1 };
    const IN = { purchase_order: 1, purchase_return: -1 };
    for (const d of docs) {
      const direction = d.type in OUT ? "output" : d.type in IN ? "input" : null;
      if (!direction) continue;
      const sign = (OUT[d.type] ?? IN[d.type]);
      const base = { source: "invoice", docId: d._id, docNo: d.transactionNo, docType: d.type, date: d.date, direction, partyId: d.partyId, partyType: d.partyType };
      for (const it of d.items || []) {
        const kind = treatmentOf(it.taxKind, it.vatPercent, it.vatAmount);
        const taxable = taxableOf(it) * sign;
        const vat = num(it.vatAmount) * sign;
        const rcmVat = kind === "reverse_charge" ? round2(Math.abs(taxable) * (num(it.vatPercent) || DEFAULT_RCM_PERCENT) / 100) * (taxable < 0 ? -1 : 1) : 0;
        lines.push({ ...base, kind, taxable, vat: kind === "reverse_charge" ? 0 : vat, rcmVat });
      }
      for (const c of d.charges || []) {
        const kind = treatmentOf(null, c.vatPercent, c.vatAmount);
        lines.push({ ...base, kind, taxable: num(c.amount) * sign, vat: num(c.vatAmount) * sign, rcmVat: 0, charge: true });
      }
    }

    // vouchers that carry VAT: expenses (input) and debit / credit notes
    const vouchers = await Voucher.find({
      voucherType: { $in: ["expense", "debit_note", "credit_note"] }, ledgerBased: true, status: "approved", date: { $gte: start, $lte: end },
    }).select("voucherNo voucherType date partyId partyType partyName subtotal vatTotal taxCodeId noteLines description expenseAccountName").lean();
    const codeIds = new Set();
    for (const v of vouchers) {
      if (v.taxCodeId) codeIds.add(String(v.taxCodeId));
      for (const l of v.noteLines || []) if (l.taxCodeId) codeIds.add(String(l.taxCodeId));
    }
    const codes = new Map((await TaxCode.find({ _id: { $in: [...codeIds] } }).select("kind").lean()).map((c) => [String(c._id), c.kind]));
    for (const v of vouchers) {
      if (v.voucherType === "expense") {
        const kind = treatmentOf(v.taxCodeId && codes.get(String(v.taxCodeId)), v.subtotal && v.vatTotal ? (v.vatTotal / v.subtotal) * 100 : 0, v.vatTotal);
        lines.push({ source: "expense", docId: v._id, docNo: v.voucherNo, docType: "expense", date: v.date, direction: "input", partyId: v.partyId, partyType: v.partyType, partyName: v.partyName, kind, taxable: num(v.subtotal), vat: num(v.vatTotal), rcmVat: 0 });
        continue;
      }
      // a note follows its lines: output VAT for a customer, input VAT for a vendor. A credit note to
      // a customer and a debit note to a vendor take VAT back; the others add to it.
      const vendor = v.partyType === "Vendor";
      const isDebit = v.voucherType === "debit_note";
      const sign = (vendor ? isDebit : !isDebit) ? -1 : 1;
      for (const l of v.noteLines || []) {
        const kind = treatmentOf(l.taxCodeId && codes.get(String(l.taxCodeId)), l.vatPercent, l.vatAmount);
        lines.push({ source: "note", docId: v._id, docNo: v.voucherNo, docType: v.voucherType, date: v.date, direction: vendor ? "input" : "output", partyId: v.partyId, partyType: v.partyType, partyName: v.partyName, kind, taxable: num(l.amount) * sign, vat: num(l.vatAmount) * sign, rcmVat: 0 });
      }
    }
    return lines;
  }

  static async companyEmirate() {
    try {
      const settings = await AccountConfigService.getSettings({});
      return settings?.profile?.emirate || "Dubai";
    } catch {
      return "Dubai";
    }
  }

  // The return for a period, from the documents.
  static async compute({ from, to } = {}) {
    const lines = await this.collect({ from, to });
    const emirate = await this.companyEmirate();
    const emirateBox = BOX_OF_EMIRATE[String(emirate).toLowerCase()] || "1b";

    const acc = {};
    const add = (box, label, taxable, vat) => {
      acc[box] ||= { box, label, amount: 0, vat: 0 };
      acc[box].amount += taxable;
      acc[box].vat += vat;
    };
    const unclassified = { count: 0, amount: 0, vat: 0, lines: [] };
    const notReported = { amount: 0, count: 0 };

    for (const l of lines) {
      if (l.kind === "unclassified") {
        unclassified.count += 1;
        unclassified.amount += l.taxable;
        unclassified.vat += l.vat;
        if (unclassified.lines.length < 25) unclassified.lines.push({ docNo: l.docNo, docType: l.docType, direction: l.direction, taxable: round2(l.taxable) });
        continue;
      }
      if (l.direction === "output") {
        if (l.kind === "standard") add(emirateBox, `Standard-rated supplies in ${emirate}`, l.taxable, l.vat);
        else if (l.kind === "zero_rated") add("4", "Zero-rated supplies", l.taxable, 0);
        else if (l.kind === "exempt") add("5", "Exempt supplies", l.taxable, 0);
        else if (l.kind === "reverse_charge") add("3", "Supplies subject to the reverse charge", l.taxable, l.rcmVat);
        else { notReported.amount += l.taxable; notReported.count += 1; }
      } else if (l.kind === "standard") add("9", "Standard-rated expenses", l.taxable, l.vat);
      else if (l.kind === "reverse_charge") {
        add("10", "Expenses subject to the reverse charge", l.taxable, l.rcmVat);
        add("3", "Supplies subject to the reverse charge", l.taxable, l.rcmVat); // accounted for as output too
      } else { notReported.amount += l.taxable; notReported.count += 1; }
    }

    const get = (box, label) => acc[box] || { box, label, amount: 0, vat: 0 };
    const r = (b) => ({ ...b, amount: round2(b.amount), vat: round2(b.vat) });
    const supplies = [
      ...EMIRATES.map(([box, name]) => get(box, `Standard-rated supplies in ${name}`)),
      get("3", "Supplies subject to the reverse charge"), get("4", "Zero-rated supplies"), get("5", "Exempt supplies"),
    ].map(r);
    const expenses = [get("9", "Standard-rated expenses"), get("10", "Expenses subject to the reverse charge")].map(r);
    const sum = (list, key) => round2(list.reduce((t, b) => t + b[key], 0));
    const box8 = { box: "8", label: "Total supplies", amount: sum(supplies, "amount"), vat: sum(supplies, "vat") };
    const box11 = { box: "11", label: "Total expenses", amount: sum(expenses, "amount"), vat: sum(expenses, "vat") };
    const totals = { outputVat: box8.vat, recoverableVat: box11.vat, netPayable: round2(box8.vat - box11.vat) };
    const boxes = [
      ...supplies, box8, ...expenses, box11,
      { box: "12", label: "Total VAT due", amount: 0, vat: totals.outputVat },
      { box: "13", label: "Recoverable input VAT", amount: 0, vat: totals.recoverableVat },
      { box: "14", label: totals.netPayable >= 0 ? "Net VAT payable" : "Net VAT refundable", amount: 0, vat: totals.netPayable },
    ];

    return {
      // The UAE VAT 201 return is filed in dirhams by law, whatever currency the books are kept in: it is a UAE feature
      // (the `vatReturn` plan feature), not part of the general reports that follow the organisation's base currency.
      from, to, emirate, currency: "AED", boxes, totals,
      unclassified: { ...unclassified, amount: round2(unclassified.amount), vat: round2(unclassified.vat) },
      notReported: { count: notReported.count, amount: round2(notReported.amount), note: "Out-of-scope lines and zero-rated or exempt purchases appear in no box." },
      notTracked: [
        { box: "2", label: "Tax refunds provided to tourists" },
        { box: "6", label: "Goods imported into the UAE" },
        { box: "7", label: "Import adjustments" },
      ],
      reconciliation: await this.reconcile({ from, to, lines }),
    };
  }

  // The VAT the documents say against the VAT accounts of the ledger. Differences are reported, not
  // hidden: ledger posting off, VAT on a document edited by hand, or a reverse-charge amount (which
  // is not posted) will all show here.
  static async reconcile({ from, to, lines }) {
    const start = dayStart(from);
    const end = dayEnd(to);
    const docVat = (dir) => round2(lines.filter((l) => l.direction === dir && l.kind !== "reverse_charge").reduce((t, l) => t + l.vat, 0));
    const ledgerNet = async (key, side) => {
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
      const debit = row?.debit || 0;
      const credit = row?.credit || 0;
      return round2(side === "credit" ? credit - debit : debit - credit);
    };
    const [ledgerOutput, ledgerInput] = await Promise.all([ledgerNet("vat-sales", "credit"), ledgerNet("vat-purchase", "debit")]);
    const out = docVat("output");
    const inp = docVat("input");
    const row = (label, documents, ledger) => ({ label, documents, ledger, difference: ledger == null ? null : round2(documents - ledger), agrees: ledger != null && Math.abs(documents - ledger) < 0.01 });
    return { rows: [row("Output VAT", out, ledgerOutput), row("Input VAT", inp, ledgerInput)] };
  }

  // Document-level detail behind the boxes.
  static async detail({ from, to, direction, kind, search, page = 1, limit = 50 } = {}) {
    const lines = await this.collect({ from, to });
    const byDoc = new Map();
    for (const l of lines) {
      const key = `${l.source}:${l.docId}`;
      if (!byDoc.has(key)) byDoc.set(key, { source: l.source, docId: l.docId, docNo: l.docNo, docType: l.docType, date: l.date, direction: l.direction, partyId: l.partyId, partyType: l.partyType, partyName: l.partyName || "", kinds: new Set(), taxable: 0, vat: 0, rcmVat: 0 });
      const d = byDoc.get(key);
      d.kinds.add(l.kind);
      d.taxable += l.taxable;
      d.vat += l.vat;
      d.rcmVat += l.rcmVat;
    }
    let rows = [...byDoc.values()];

    // party names and TRNs
    const ids = (type) => [...new Set(rows.filter((r) => r.partyType === type && r.partyId).map((r) => String(r.partyId)))];
    const [customers, vendors] = await Promise.all([
      mongoose.model("Customer").find({ _id: { $in: ids("Customer") } }).select("customerName trnNumber").lean(),
      mongoose.model("Vendor").find({ _id: { $in: ids("Vendor") } }).select("vendorName trnNO").lean(),
    ]);
    const party = new Map([
      ...customers.map((c) => [String(c._id), { name: c.customerName, trn: c.trnNumber || "" }]),
      ...vendors.map((v) => [String(v._id), { name: v.vendorName, trn: v.trnNO || "" }]),
    ]);
    rows = rows.map((r) => {
      const p = party.get(String(r.partyId)) || {};
      return { ...r, kinds: [...r.kinds], partyName: r.partyName || p.name || "", trn: p.trn || "", taxable: round2(r.taxable), vat: round2(r.vat), rcmVat: round2(r.rcmVat) };
    });
    if (direction) rows = rows.filter((r) => r.direction === direction);
    if (kind) rows = rows.filter((r) => r.kinds.includes(kind));
    const needle = String(search || "").trim().toLowerCase();
    if (needle) rows = rows.filter((r) => `${r.docNo} ${r.partyName} ${r.trn}`.toLowerCase().includes(needle));
    rows.sort((a, b) => new Date(b.date) - new Date(a.date) || String(b.docNo).localeCompare(String(a.docNo)));

    const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const p = Math.max(Number(page) || 1, 1);
    return {
      from, to, total: rows.length, page: p, limit: size,
      totals: { taxable: round2(rows.reduce((t, r) => t + r.taxable, 0)), vat: round2(rows.reduce((t, r) => t + r.vat, 0)) },
      rows: rows.slice((p - 1) * size, p * size),
    };
  }

  // ---------------------------------------------------------------- saved returns

  static returnNoOf(from, to) {
    return `VAT-${from}..${to}`;
  }

  static async list() {
    const { companyId } = getTenant();
    return VATReturn.find({ companyId }).sort({ periodFrom: -1, createdAt: -1 }).lean();
  }

  static async get(id) {
    const r = await VATReturn.findOne({ _id: id, companyId: getTenant().companyId }).lean();
    if (!r) throw new AppError("VAT return not found", 404);
    return r;
  }

  // Saves the current figures for a period as a DRAFT (replacing an earlier draft of the same period).
  static async createDraft({ from, to, notes }, adminId) {
    const { companyId } = getTenant();
    const live = await this.compute({ from, to });
    const clash = await VATReturn.findOne({ companyId, status: { $in: ["FINALIZED", "FILED"] }, periodFrom: { $lte: to }, periodTo: { $gte: from } }).lean();
    if (clash) throw new AppError(`This period overlaps the ${clash.status === "FILED" ? "filed" : "finalised"} return ${clash.returnNo}`, 409, "PERIOD_OVERLAP");
    const returnNo = this.returnNoOf(from, to);
    const body = {
      companyId, returnNo, periodFrom: from, periodTo: to, emirate: live.emirate, boxes: live.boxes.map(({ box, label, amount, vat }) => ({ box, label, amount, vat })),
      totals: live.totals, unclassifiedLines: live.unclassified.count, notes: notes || "", status: "DRAFT", createdBy: String(adminId || ""),
    };
    return VATReturn.findOneAndUpdate({ companyId, returnNo }, body, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  }

  // Locks the figures as prepared. Refused while lines still have no tax treatment.
  static async finalize(id, adminId, { allowUnclassified = false } = {}) {
    const r = await VATReturn.findOne({ _id: id, companyId: getTenant().companyId });
    if (!r) throw new AppError("VAT return not found", 404);
    if (r.status !== "DRAFT") throw new AppError(`This return is already ${r.status.toLowerCase()}`, 409, "NOT_DRAFT");
    const live = await this.compute({ from: r.periodFrom, to: r.periodTo });
    if (live.unclassified.count && !allowUnclassified) {
      throw new AppError(`${live.unclassified.count} line(s) have no tax treatment (0% with no tax code). Classify them, or finalise anyway.`, 409, "UNCLASSIFIED_LINES");
    }
    r.boxes = live.boxes.map(({ box, label, amount, vat }) => ({ box, label, amount, vat }));
    r.totals = live.totals;
    r.unclassifiedLines = live.unclassified.count;
    r.status = "FINALIZED";
    r.finalizedAt = new Date();
    r.finalizedBy = String(adminId || "");
    await r.save();
    return r.toObject();
  }

  static async file(id, adminId, { reference, filedOn } = {}) {
    const r = await VATReturn.findOne({ _id: id, companyId: getTenant().companyId });
    if (!r) throw new AppError("VAT return not found", 404);
    if (r.status !== "FINALIZED") throw new AppError("Finalise the return before marking it filed", 409, "NOT_FINALIZED");
    if (!String(reference || "").trim()) throw new AppError("Enter the FTA reference of the filing", 400, "REFERENCE_REQUIRED");
    r.status = "FILED";
    r.filingReference = String(reference).trim();
    r.filedAt = filedOn ? new Date(filedOn) : new Date();
    r.filedBy = String(adminId || "");
    await r.save();
    return r.toObject();
  }

  static async remove(id) {
    const r = await VATReturn.findOne({ _id: id, companyId: getTenant().companyId });
    if (!r) throw new AppError("VAT return not found", 404);
    if (r.status !== "DRAFT") throw new AppError("Only a draft can be deleted", 409, "NOT_DRAFT");
    await r.deleteOne();
  }
}

module.exports = VatReturnService;
