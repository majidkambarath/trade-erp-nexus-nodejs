const mongoose = require("mongoose");
const Transaction = require("../../models/modules/transactionModel");
const { Voucher, LedgerEntry } = require("../../models/modules/financial/financialModels");
const TaxCode = require("../../models/modules/financial/taxCodeModel");
const VATReturn = require("../../models/modules/financial/vatReturnModel");
const Branch = require("../../models/core/branchModel");
const AccountConfigService = require("../financial/accountConfigService");
const AppError = require("../../utils/AppError");
const { round2 } = require("../../utils/accounting");
const { getTenant } = require("../../utils/tenant");
const { ambientTenant } = require("../../utils/tenantContext");
const { dayStart, dayEnd } = require("./ledgerReportsService");

// One return is filed for the taxpayer (one TRN), whatever branches it has. Inside a branch view the figures are that branch's slice
// only, so a return saved from there would be filed as the organisation's. Year-end close refuses the same way.
const assertWholeOrganisation = () => {
  if (ambientTenant()?.branchView) {
    throw new AppError("The VAT return covers every branch: switch to All branches first", 409, "ALL_BRANCHES_REQUIRED");
  }
};

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
//
// Reverse charge (FTA VAT Returns User Guide, boxes 3 and 10): the RECIPIENT declares the net value and the VAT it assesses in box 3
// (output) and, if recoverable, the same in box 10 (input); the two cancel in box 14. A purchase or purchase return line of that
// kind does so, with the VAT taken from the line's own stored figure (utils/pricing.js `rcmVat`, the figure that was posted to the
// ledger). A SALE of that kind is the supplier's: it charges no VAT and declares none, so it is in no box and is listed apart
// (`customerAccounts`). Box 9 never includes reverse-charge purchases ("should be recovered in Box 10, not Box 9").

const EMIRATES = [
  ["1a", "Abu Dhabi"], ["1b", "Dubai"], ["1c", "Sharjah"], ["1d", "Ajman"], ["1e", "Umm Al Quwain"], ["1f", "Ras Al Khaimah"], ["1g", "Fujairah"],
];
const BOX_OF_EMIRATE = Object.fromEntries(EMIRATES.map(([box, name]) => [name.toLowerCase(), box]));
const { DEFAULT_RCM_PERCENT } = require("../../utils/pricing"); // the rate an older reverse-charge line with none is worked out at

const num = (v) => Number(v) || 0;

// "dubai" -> "Dubai"; anything that is not one of the seven -> null
const emirateName = (text) => EMIRATES.find(([, name]) => name.toLowerCase() === String(text || "").trim().toLowerCase())?.[1] || null;
// what a line with a tax treatment and no tax code is called in the report by tax code
const KIND_LABEL = {
  standard: "Standard rated (no code)", zero_rated: "Zero rated (no code)", exempt: "Exempt (no code)",
  reverse_charge: "Reverse charge (no code)", out_of_scope: "Out of scope (no code)", unclassified: "No tax treatment",
};

// The treatment of a document line: the snapshot kind, else inferred from its VAT, else unclassified.
function treatmentOf(kind, vatPercent, vatAmount) {
  if (kind) return kind;
  return num(vatPercent) > 0 || num(vatAmount) > 0 ? "standard" : "unclassified";
}

// Which VAT 201 box a tax code's KIND lands in, for each direction a line carrying it can be
// used on - a code is not itself "a sales code" or "a purchase code", the same one can go on
// either, so both are named. Mirrors the branches of compute()'s box-building loop below exactly
// (keep the two in step); this is what the Tax codes screen shows so a person can tell, before
// ever raising a document, which box a line will land in (F05: a 5% line with no code used to be
// unclassified on the return with nothing on screen to say that mattered).
const SALES_BOX = {
  standard: "1 (by emirate)", zero_rated: "4", exempt: "5",
  reverse_charge: "None - the customer declares it in box 3",
};
const PURCHASE_BOX = { standard: "9", reverse_charge: "3 and 10" };
function boxesOf(kind) {
  return { sales: SALES_BOX[kind] || "None", purchases: PURCHASE_BOX[kind] || "None" };
}

// A line's taxable value (before VAT, after the line discount).
function taxableOf(item) {
  if (num(item.taxableAmount) || num(item.vatAmount)) return num(item.taxableAmount);
  const gross = num(item.grossAmount) - num(item.discountAmount);
  return gross || num(item.qty) * num(item.price ?? item.rate);
}

class VatReturnService {
  static EMIRATES = EMIRATES;
  static assertWholeOrganisation = assertWholeOrganisation;
  static treatmentOf = treatmentOf;
  static boxesOf = boxesOf;

  // Every VAT-relevant line of the period as a flat list:
  // { source, docId, docNo, date, direction: output|input, partyId, partyType, partyName, kind, taxable, vat, rcmVat,
  //   branchId, lineNo, description, itemId, taxCodeId, supplierRef, fx: { currency, taxable, vat } | null }
  // Amounts are signed: returns and notes that reverse a supply carry a minus. The fields after rcmVat are what the FTA Audit
  // File and the reports by tax code and by emirate are made from, so they can never disagree with the return's own boxes.
  static async collect({ from, to }) {
    const start = dayStart(from);
    const end = dayEnd(to);
    if (!start || !end) throw new AppError("Choose the first and last day of the period", 400, "PERIOD_REQUIRED");
    if (start > end) throw new AppError("The period ends before it starts", 400, "INVALID_PERIOD");
    const lines = [];

    const docs = await Transaction.find({ status: "APPROVED", isOpening: { $ne: true }, date: { $gte: start, $lte: end } })
      .select("transactionNo type date partyId partyType items charges vatRegistered branchId vendorReference fx.currency selfBilledNo")
      .lean();
    const OUT = { sales_order: 1, sales_return: -1 };
    const IN = { purchase_order: 1, purchase_return: -1 };
    for (const d of docs) {
      // made while the organisation was not registered for VAT: no VAT was charged and none can be claimed, so it is not in the return
      if (d.vatRegistered === false) continue;
      const direction = d.type in OUT ? "output" : d.type in IN ? "input" : null;
      if (!direction) continue;
      const sign = (OUT[d.type] ?? IN[d.type]);
      const base = {
        source: "invoice", docId: d._id, docNo: d.transactionNo, docType: d.type, date: d.date, direction, partyId: d.partyId, partyType: d.partyType,
        branchId: d.branchId, supplierRef: d.vendorReference || "", selfBilledNo: d.selfBilledNo || "",
      };
      // the foreign amounts of a line, when the document was made in a foreign currency (the figures above stay in base)
      const inForeign = (taxable, vat) => (d.fx?.currency ? { currency: d.fx.currency, taxable: num(taxable) * sign, vat: num(vat) * sign } : null);
      let lineNo = 0;
      for (const it of d.items || []) {
        lineNo += 1;
        const kind = treatmentOf(it.taxKind, it.vatPercent, it.vatAmount);
        const taxable = taxableOf(it) * sign;
        const vat = num(it.vatAmount) * sign;
        // A reverse-charge line is declared by the RECIPIENT (FTA VAT Returns User Guide: box 3 is "supplies of goods and services
        // received", box 10 recovers the VAT declared there). So only a purchase or a purchase return carries a self-assessed
        // amount; the supplier's own sale of the same kind charges no VAT and owes none (see compute()).
        //   - a line priced since reverse charge was posted carries its own figure (`rcmVat`), the one the ledger was posted with;
        //   - an older line has none and is worked out from the line as it always was (taxable x rate, 5% when it names none).
        const stored = kind === "reverse_charge" && it.rcmVat != null;
        let rcmVat = 0;
        if (kind === "reverse_charge" && direction === "input") {
          rcmVat = stored ? num(it.rcmVat) * sign : round2(Math.abs(taxable) * (num(it.vatPercent) || DEFAULT_RCM_PERCENT) / 100) * (taxable < 0 ? -1 : 1);
        }
        lines.push({
          ...base, kind, taxable, vat: kind === "reverse_charge" ? 0 : vat, rcmVat, rcmStored: stored && direction === "input",
          lineNo, description: it.description || "", itemId: it.itemId, taxCodeId: it.taxCodeId || null,
          fx: inForeign(it.fx?.taxableAmount, kind === "reverse_charge" ? it.fx?.rcmVat : it.fx?.vatAmount),
        });
      }
      for (const c of d.charges || []) {
        const kind = treatmentOf(null, c.vatPercent, c.vatAmount);
        lineNo += 1;
        lines.push({
          ...base, kind, taxable: num(c.amount) * sign, vat: num(c.vatAmount) * sign, rcmVat: 0, charge: true,
          lineNo, description: c.description || c.code || "Charge", taxCodeId: null, fx: inForeign(c.fx?.amount, c.fx?.vatAmount),
        });
      }
    }

    // vouchers that carry VAT: expenses (input) and debit / credit notes
    const vouchers = await Voucher.find({
      voucherType: { $in: ["expense", "debit_note", "credit_note"] }, ledgerBased: true, status: "approved", date: { $gte: start, $lte: end },
    }).select("voucherNo voucherType date partyId partyType partyName subtotal vatTotal taxCodeId noteLines description expenseAccountName narration branchId referenceNo").lean();
    const codeIds = new Set();
    for (const v of vouchers) {
      if (v.taxCodeId) codeIds.add(String(v.taxCodeId));
      for (const l of v.noteLines || []) if (l.taxCodeId) codeIds.add(String(l.taxCodeId));
    }
    const codes = new Map((await TaxCode.find({ _id: { $in: [...codeIds] } }).select("kind").lean()).map((c) => [String(c._id), c.kind]));
    for (const v of vouchers) {
      if (v.voucherType === "expense") {
        const kind = treatmentOf(v.taxCodeId && codes.get(String(v.taxCodeId)), v.subtotal && v.vatTotal ? (v.vatTotal / v.subtotal) * 100 : 0, v.vatTotal);
        lines.push({
          source: "expense", docId: v._id, docNo: v.voucherNo, docType: "expense", date: v.date, direction: "input", partyId: v.partyId, partyType: v.partyType, partyName: v.partyName, kind, taxable: num(v.subtotal), vat: num(v.vatTotal), rcmVat: 0,
          branchId: v.branchId, lineNo: 1, description: v.description || v.expenseAccountName || v.narration || "", taxCodeId: v.taxCodeId || null, supplierRef: v.referenceNo || "", fx: null,
        });
        continue;
      }
      // a note follows its lines: output VAT for a customer, input VAT for a vendor. A credit note to
      // a customer and a debit note to a vendor take VAT back; the others add to it.
      const vendor = v.partyType === "Vendor";
      const isDebit = v.voucherType === "debit_note";
      const sign = (vendor ? isDebit : !isDebit) ? -1 : 1;
      let lineNo = 0;
      for (const l of v.noteLines || []) {
        lineNo += 1;
        const kind = treatmentOf(l.taxCodeId && codes.get(String(l.taxCodeId)), l.vatPercent, l.vatAmount);
        lines.push({
          source: "note", docId: v._id, docNo: v.voucherNo, docType: v.voucherType, date: v.date, direction: vendor ? "input" : "output", partyId: v.partyId, partyType: v.partyType, partyName: v.partyName, kind, taxable: num(l.amount) * sign, vat: num(l.vatAmount) * sign, rcmVat: 0,
          branchId: v.branchId, lineNo, description: l.description || v.narration || "", taxCodeId: l.taxCodeId || null, supplierRef: v.referenceNo || "", fx: null,
        });
      }
    }
    return lines;
  }

  // The emirate set in the company profile, or null when none is (the return then assumes Dubai and says so).
  static async configuredEmirate() {
    try {
      const settings = await AccountConfigService.getSettings({});
      return String(settings?.profile?.emirate || "").trim() || null;
    } catch {
      return null;
    }
  }

  static async companyEmirate() {
    return (await this.configuredEmirate()) || "Dubai";
  }

  // The emirate each branch (establishment) is in, where it names one of the seven: branch code -> emirate.
  static async branchEmirates() {
    const branches = await Branch.find({ emirate: { $exists: true, $ne: "" } }).select("code emirate").lean();
    const named = branches.map((b) => [b.code, emirateName(b.emirate)]).filter(([, name]) => name);
    return new Map(named);
  }

  // Which emirate a supply is reported under: its branch's, else the company's (Dubai when none is set).
  static async emiratePicker() {
    const [configured, branches] = await Promise.all([this.configuredEmirate(), this.branchEmirates()]);
    const known = emirateName(configured);
    const company = known || configured || "Dubai";
    return {
      company,
      of: (line) => branches.get(line.branchId || "main") || known || "Dubai",
      // an assumption was made when a supply fell back to a company emirate that is not set or not one of the seven
      assumed: (lines) => {
        if (known) return false;
        const supplies = lines.filter((l) => l.direction === "output" && l.kind === "standard");
        return supplies.length ? supplies.some((l) => !branches.has(l.branchId || "main")) : branches.size === 0;
      },
    };
  }

  // The return for a period, from the documents.
  static async compute({ from, to } = {}) {
    const lines = await this.collect({ from, to });
    // standard-rated supplies are reported under the emirate of the establishment (the branch, else the company): when none is
    // set, or the text is not one of the seven, the return says it assumed Dubai rather than looking as though it knew
    const picker = await this.emiratePicker();
    const emirate = picker.company;
    const emirateAssumed = picker.assumed(lines);

    const acc = {};
    const add = (box, label, taxable, vat) => {
      acc[box] ||= { box, label, amount: 0, vat: 0 };
      acc[box].amount += taxable;
      acc[box].vat += vat;
    };
    const unclassified = { count: 0, amount: 0, vat: 0, lines: [] };
    const notReported = { amount: 0, count: 0 };
    // Our own sales on which the CUSTOMER accounts for the VAT (reverse charge, supplier side): no output VAT, and not box 3
    const customerAccounts = { amount: 0, count: 0 };

    for (const l of lines) {
      if (l.kind === "unclassified") {
        unclassified.count += 1;
        unclassified.amount += l.taxable;
        unclassified.vat += l.vat;
        if (unclassified.lines.length < 25) unclassified.lines.push({ docNo: l.docNo, docType: l.docType, direction: l.direction, taxable: round2(l.taxable) });
        continue;
      }
      if (l.direction === "output") {
        if (l.kind === "standard") {
          const where = picker.of(l);
          add(BOX_OF_EMIRATE[where.toLowerCase()], `Standard-rated supplies in ${where}`, l.taxable, l.vat);
        }
        else if (l.kind === "zero_rated") add("4", "Zero-rated supplies", l.taxable, 0);
        else if (l.kind === "exempt") add("5", "Exempt supplies", l.taxable, 0);
        else if (l.kind === "reverse_charge") {
          // Box 3 is the RECIPIENT's declaration of supplies received (FTA VAT Returns User Guide, box 3). A supplier whose customer
          // accounts for the VAT charges none and declares no output tax on it; it used to be added to box 3 with 5% of its value,
          // which made the supplier pay VAT the customer is already paying. Listed beside the return, in no box.
          customerAccounts.amount += l.taxable; customerAccounts.count += 1;
          notReported.amount += l.taxable; notReported.count += 1;
        } else { notReported.amount += l.taxable; notReported.count += 1; }
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
      from, to, emirate, emirateAssumed, currency: "AED", boxes, totals,
      unclassified: { ...unclassified, amount: round2(unclassified.amount), vat: round2(unclassified.vat) },
      notReported: { count: notReported.count, amount: round2(notReported.amount), note: "Out-of-scope lines, zero-rated or exempt purchases and sales on which the customer accounts for the VAT (reverse charge) appear in no box." },
      customerAccounts: { count: customerAccounts.count, amount: round2(customerAccounts.amount), note: "Sales on which the customer accounts for the VAT under the reverse charge. You charge no VAT and declare no output tax on them; the customer declares them in box 3." },
      notTracked: [
        { box: "2", label: "Tax refunds provided to tourists" },
        { box: "6", label: "Goods imported into the UAE" },
        { box: "7", label: "Import adjustments" },
      ],
      reconciliation: await this.reconcile({ from, to, lines }),
    };
  }

  // The VAT the documents say against the VAT accounts of the ledger. Differences are reported, not
  // hidden: ledger posting off, or VAT on a document edited by hand, will show here.
  //
  // Reverse charge is posted (a purchase: Dr Input VAT / Cr Reverse-charge VAT, a return the reverse), so it is reconciled too:
  //   Output VAT   standard output VAT of the documents  vs  credits on vat-sales
  //   Input VAT    standard input VAT + the reverse-charge input vs  debits on vat-purchase
  //   Reverse-charge VAT   the self-assessed VAT of the documents vs  credits on rcm-purchase
  // Only lines priced since reverse charge was posted (`rcmStored`) are counted: an older reverse-charge line was posted as if the
  // supplier had charged the VAT, so it is left out of the documents' side as it always was and shows as a difference, honestly.
  static async reconcile({ from, to, lines }) {
    const start = dayStart(from);
    const end = dayEnd(to);
    const docVat = (dir) => round2(lines.filter((l) => l.direction === dir && l.kind !== "reverse_charge").reduce((t, l) => t + l.vat, 0));
    const docRcm = round2(lines.filter((l) => l.direction === "input" && l.kind === "reverse_charge" && l.rcmStored).reduce((t, l) => t + l.rcmVat, 0));
    const ledgerNet = async (key, side) => {
      let accountId;
      try {
        accountId = await AccountConfigService.resolveAccount(key);
      } catch (err) {
        if (err.code === "ACCOUNT_NOT_CONFIGURED") return null;
        throw err;
      }
      // Split by whether a person's journal made the entry: the VAT paid to the tax authority is cleared against these accounts
      // by a journal, so every quarter holds the previous quarter's settlement. It still counts (an adjustment made behind the
      // documents' backs must show as a difference); the split only lets the screen say how much of a difference it is.
      const parts = await LedgerEntry.aggregate([
        { $match: { accountId: new mongoose.Types.ObjectId(String(accountId)), isReversed: { $ne: true }, date: { $gte: start, $lte: end } } },
        { $group: { _id: { $eq: ["$voucherType", "journal"] }, debit: { $sum: "$debitAmount" }, credit: { $sum: "$creditAmount" } } },
      ]);
      const net = (p) => (p ? round2(side === "credit" ? (p.credit || 0) - (p.debit || 0) : (p.debit || 0) - (p.credit || 0)) : 0);
      const journals = net(parts.find((p) => p._id === true));
      return { total: round2(net(parts.find((p) => p._id === true)) + net(parts.find((p) => p._id === false))), journals };
    };
    const [ledgerOutput, ledgerInput, ledgerRcm] = await Promise.all([ledgerNet("vat-sales", "credit"), ledgerNet("vat-purchase", "debit"), ledgerNet("rcm-purchase", "credit")]);
    const out = docVat("output");
    const inp = round2(docVat("input") + docRcm); // the reverse-charge input is posted to the same Input VAT account
    const row = (label, documents, l) => {
      const ledger = l == null ? null : l.total;
      const journals = l == null ? 0 : l.journals;
      const difference = ledger == null ? null : round2(documents - ledger);
      const agrees = ledger != null && Math.abs(documents - ledger) < 0.01;
      // `explained`: the documents match what the ledger holds apart from journals, i.e. the whole difference is a settlement or an
      // adjustment posted by journal. It is still not "agrees" (a journal is a difference to look at); the screen says it in words.
      const explained = !agrees && ledger != null && journals !== 0 && Math.abs(round2(ledger - journals) - documents) < 0.01;
      return { label, documents, ledger, difference, agrees, journals, explained };
    };
    const rows = [row("Output VAT", out, ledgerOutput), row("Input VAT", inp, ledgerInput)];
    // The reverse-charge row appears when there is something to say about it (an account unmapped on a company that never used reverse
    // charge would only be noise), but always when a document or the ledger holds an amount, so a mismatch cannot hide.
    if (docRcm || (ledgerRcm && (ledgerRcm.total || ledgerRcm.journals))) rows.push(row("Reverse-charge VAT (self-assessed)", docRcm, ledgerRcm));
    return { rows };
  }

  // The period's tax by tax code (each direction apart) and its supplies by emirate, from the same lines as the return.
  static async analysis({ from, to } = {}) {
    const lines = await this.collect({ from, to });
    const picker = await this.emiratePicker();
    const ids = [...new Set(lines.map((l) => l.taxCodeId).filter(Boolean).map(String))];
    const codes = new Map((await TaxCode.find({ _id: { $in: ids } }).select("name").lean()).map((c) => [String(c._id), c.name]));

    const byCode = new Map();
    const byEmirate = new Map(EMIRATES.map(([box, name]) => [name, { box, emirate: name, standard: 0, standardVat: 0, zeroRated: 0, exempt: 0, other: 0 }]));
    for (const l of lines) {
      const id = l.taxCodeId ? String(l.taxCodeId) : null;
      const key = `${l.direction}|${id || ""}|${l.kind}`;
      if (!byCode.has(key)) {
        const code = (id && codes.get(id)) || KIND_LABEL[l.kind] || l.kind;
        byCode.set(key, { direction: l.direction, taxCodeId: id, code, kind: l.kind, taxable: 0, vat: 0, rcmVat: 0, lines: 0 });
      }
      const row = byCode.get(key);
      row.taxable += l.taxable;
      row.vat += l.vat;
      row.rcmVat += l.rcmVat;
      row.lines += 1;
      if (l.direction !== "output") continue;
      const e = byEmirate.get(picker.of(l));
      if (l.kind === "standard") { e.standard += l.taxable; e.standardVat += l.vat; }
      else if (l.kind === "zero_rated") e.zeroRated += l.taxable;
      else if (l.kind === "exempt") e.exempt += l.taxable;
      else e.other += l.taxable;
    }
    const rounded = (o, keys) => ({ ...o, ...Object.fromEntries(keys.map((k) => [k, round2(o[k])])) });
    const taxCodes = [...byCode.values()]
      .map((r) => rounded(r, ["taxable", "vat", "rcmVat"]))
      .sort((a, b) => b.direction.localeCompare(a.direction) || a.code.localeCompare(b.code));
    const emirates = [...byEmirate.values()].map((r) => rounded(r, ["standard", "standardVat", "zeroRated", "exempt", "other"]));
    return { from, to, currency: "AED", taxCodes, emirates, emirateAssumed: picker.assumed(lines) };
  }

  // Document-level detail behind the boxes.
  // `all`: every row of the period in one answer, for the export (the screen pages).
  static async detail({ from, to, direction, kind, search, page = 1, limit = 50, all = false } = {}) {
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
      rows: all ? rows : rows.slice((p - 1) * size, p * size),
    };
  }

  // ---------------------------------------------------------------- saved returns

  // The taxable person as the company profile describes them today.
  static async taxpayer() {
    const settings = await AccountConfigService.getSettings({});
    const p = settings?.profile || {};
    const address = [p.addressLine1, p.addressLine2, p.city, p.emirate, p.country].map((v) => String(v || "").trim()).filter(Boolean);
    return {
      trn: p.trn || "", nameEn: p.legalName || "", nameAr: p.legalNameArabic || "",
      address: address.filter((v, i) => address.findIndex((w) => w.toLowerCase() === v.toLowerCase()) === i).join(", "),
    };
  }

  // The names behind the account ids a saved return keeps (a removed account has none).
  static async namesOf(ids) {
    const wanted = [...new Set(ids.filter((id) => mongoose.isValidObjectId(id)).map(String))];
    if (!wanted.length) return new Map();
    const Admin = require("../../models/core/adminModel");
    const rows = await Admin.find({ _id: { $in: wanted } }).select("name email").lean();
    return new Map(rows.map((a) => [String(a._id), a.name || a.email]));
  }

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
    // a return saved before the snapshot was kept shows today's details
    if (!r.taxpayer?.trn) r.taxpayer = await this.taxpayer();
    const names = await this.namesOf([r.createdBy, r.finalizedBy, r.filedBy]);
    Object.assign(r, { createdByName: names.get(r.createdBy) || "", finalizedByName: names.get(r.finalizedBy) || "", filedByName: names.get(r.filedBy) || "" });
    // A finalised or filed return is the figures as they were. Documents and vouchers dated inside its period can still be posted
    // afterwards (a bank fee found on a statement, a card settlement), so what the books say for the period can move: said here,
    // with the amounts, because the tax authority has the old ones.
    if (r.status === "FINALIZED" || r.status === "FILED") {
      const live = await this.compute({ from: r.periodFrom, to: r.periodTo });
      const delta = (a, b) => round2((a || 0) - (b || 0));
      const diff = { outputVat: delta(live.totals.outputVat, r.totals?.outputVat), recoverableVat: delta(live.totals.recoverableVat, r.totals?.recoverableVat), netPayable: delta(live.totals.netPayable, r.totals?.netPayable) };
      r.changedSince = Object.values(diff).some((v) => Math.abs(v) >= 0.005) ? { ...diff, current: live.totals } : null;
    }
    return r;
  }

  // Saves the current figures for a period as a DRAFT (replacing an earlier draft of the same period).
  static async createDraft({ from, to, notes }, adminId) {
    assertWholeOrganisation();
    const { companyId } = getTenant();
    const live = await this.compute({ from, to });
    const clash = await VATReturn.findOne({ companyId, status: { $in: ["FINALIZED", "FILED"] }, periodFrom: { $lte: to }, periodTo: { $gte: from } }).lean();
    if (clash) throw new AppError(`This period overlaps the ${clash.status === "FILED" ? "filed" : "finalised"} return ${clash.returnNo}`, 409, "PERIOD_OVERLAP");
    const returnNo = this.returnNoOf(from, to);
    const body = {
      companyId, returnNo, periodFrom: from, periodTo: to, emirate: live.emirate, taxpayer: await this.taxpayer(), boxes: live.boxes.map(({ box, label, amount, vat }) => ({ box, label, amount, vat })),
      totals: live.totals, unclassifiedLines: live.unclassified.count, notes: notes || "", status: "DRAFT", createdBy: String(adminId || ""),
    };
    return VATReturn.findOneAndUpdate({ companyId, returnNo }, body, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  }

  // Locks the figures as prepared. Refused while lines still have no tax treatment.
  static async finalize(id, adminId, { allowUnclassified = false } = {}) {
    assertWholeOrganisation();
    const r = await VATReturn.findOne({ _id: id, companyId: getTenant().companyId });
    if (!r) throw new AppError("VAT return not found", 404);
    if (r.status !== "DRAFT") throw new AppError(`This return is already ${r.status.toLowerCase()}`, 409, "NOT_DRAFT");
    const live = await this.compute({ from: r.periodFrom, to: r.periodTo });
    if (live.unclassified.count && !allowUnclassified) {
      throw new AppError(`${live.unclassified.count} line(s) have no tax treatment (0% with no tax code). Classify them, or finalise anyway.`, 409, "UNCLASSIFIED_LINES");
    }
    r.boxes = live.boxes.map(({ box, label, amount, vat }) => ({ box, label, amount, vat }));
    r.totals = live.totals;
    r.emirate = live.emirate;
    r.taxpayer = await this.taxpayer();
    r.unclassifiedLines = live.unclassified.count;
    r.status = "FINALIZED";
    r.finalizedAt = new Date();
    r.finalizedBy = String(adminId || "");
    await r.save();
    return r.toObject();
  }

  static async file(id, adminId, { reference, filedOn } = {}) {
    assertWholeOrganisation();
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

  // Takes a FINALIZED return back to DRAFT, so the period it locked (FiscalYearService.assertPostingAllowed)
  // can be posted into again - a mistaken finalise must not freeze a period for good. A FILED return
  // stays locked: it has already gone to the tax authority, and there is no correcting that from here.
  static async reopen(id, adminId) {
    assertWholeOrganisation();
    const r = await VATReturn.findOne({ _id: id, companyId: getTenant().companyId });
    if (!r) throw new AppError("VAT return not found", 404);
    if (r.status === "FILED") throw new AppError("A filed return cannot be reopened: it has already gone to the tax authority", 409, "ALREADY_FILED");
    if (r.status !== "FINALIZED") throw new AppError(`This return is ${r.status.toLowerCase()}, not finalised`, 409, "NOT_FINALIZED");
    r.status = "DRAFT";
    r.finalizedAt = undefined;
    r.finalizedBy = undefined;
    r.reopenedAt = new Date();
    r.reopenedBy = String(adminId || "");
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
