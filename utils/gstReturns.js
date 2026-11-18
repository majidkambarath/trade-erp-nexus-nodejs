// GSTR-1 (outward supplies) and GSTR-3B (the summary return) built from a flat list of document lines. Pure, no database.
//
// A line is one line of an approved sales invoice, sales return (credit note), purchase bill or purchase return, already read by
// services/reports/gstReturnService.js:
//   { docId, docNo, docType, date, direction: "output" | "input", sign: 1 | -1, party: { id, name, gstin }, gstType, placeOfSupply,
//     docValue, hsnCode, qty, kind, rate, taxable, cgst, sgst, igst, rcmCgst, rcmSgst, rcmIgst }
// Amounts are POSITIVE as printed on the document; `sign` is -1 for a return, applied where figures are added together. A credit
// note is listed in its own table (positive, as the portal asks) and reduces the totals.
//
// Simplifications of this first version, stated so nobody mistakes them for the full return: no amendments (tables 9), no supplies
// through e-commerce operators (table 14/15), no ITC reversals or ineligible ITC (3B 4B/4D), no interest or late fee (3B 5.1/6),
// debit notes raised as ledger vouchers are not in the document list, and the government JSON upload file is not produced.
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (n) => Number(n) || 0;
const ZERO = () => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0 });
const addInto = (acc, l, sign = 1) => {
  acc.taxable = round2(acc.taxable + sign * num(l.taxable));
  acc.igst = round2(acc.igst + sign * num(l.igst));
  acc.cgst = round2(acc.cgst + sign * num(l.cgst));
  acc.sgst = round2(acc.sgst + sign * num(l.sgst));
  return acc;
};
const taxOf = (t) => round2(num(t.igst) + num(t.cgst) + num(t.sgst));

const isNote = (l) => l.docType === "sales_return" || l.docType === "purchase_return";
const registered = (l) => Boolean(l.party?.gstin);
const GSTR1_LARGE_LIMIT = 100000; // an inter-state invoice to an unregistered buyer above this is listed invoice by invoice (from Aug 2024)

// one row per document and rate, as the portal's tables ask
function perDocumentAndRate(lines) {
  const rows = new Map();
  for (const l of lines) {
    const key = `${l.docId}|${l.rate}`;
    let r = rows.get(key);
    if (!r) {
      r = {
        gstin: l.party?.gstin || null, party: l.party?.name || "", docNo: l.docNo, date: l.date, docValue: round2(l.docValue),
        placeOfSupply: l.placeOfSupply || null, gstType: l.gstType || null, rate: num(l.rate), ...ZERO(),
      };
      rows.set(key, r);
    }
    addInto(r, l);
  }
  return [...rows.values()].sort((a, b) => String(a.docNo).localeCompare(String(b.docNo)) || a.rate - b.rate);
}

function totalsOf(rows) {
  const t = ZERO();
  for (const r of rows) addInto(t, r);
  return { ...t, tax: taxOf(t) };
}

function gstr1(lines, { largeLimit = GSTR1_LARGE_LIMIT } = {}) {
  const out = lines.filter((l) => l.direction === "output");
  const standard = out.filter((l) => l.kind === "standard");

  const invoices = standard.filter((l) => !isNote(l));
  const notes = standard.filter(isNote);
  const large = (l) => l.gstType === "inter" && num(l.docValue) > largeLimit;

  const b2b = perDocumentAndRate(invoices.filter(registered));
  const b2cl = perDocumentAndRate(invoices.filter((l) => !registered(l) && large(l)));
  const cdnr = perDocumentAndRate(notes.filter(registered));
  const cdnur = perDocumentAndRate(notes.filter((l) => !registered(l) && large(l)));

  // everything to an unregistered buyer that is not listed invoice by invoice, summed by state and rate; a return reduces it
  const b2cs = new Map();
  for (const l of standard.filter((x) => !registered(x) && !large(x))) {
    const key = `${l.placeOfSupply || ""}|${l.rate}`;
    if (!b2cs.has(key)) b2cs.set(key, { placeOfSupply: l.placeOfSupply || null, rate: num(l.rate), type: "OE", ...ZERO() });
    addInto(b2cs.get(key), l, l.sign);
  }

  // zero-rated (exports and SEZ supplies): listed by document, with the tax paid if any
  const zeroRated = perDocumentAndRate(out.filter((l) => l.kind === "zero_rated" && !isNote(l)));

  // table 8: nil-rated and exempt, and non-GST supplies, by whether the buyer is registered and whether it crosses a state line
  const nil = { interRegistered: ZERO(), intraRegistered: ZERO(), interUnregistered: ZERO(), intraUnregistered: ZERO() };
  const nonGst = { interRegistered: ZERO(), intraRegistered: ZERO(), interUnregistered: ZERO(), intraUnregistered: ZERO() };
  const bucket = (l) => `${l.gstType === "inter" ? "inter" : "intra"}${registered(l) ? "Registered" : "Unregistered"}`;
  for (const l of out) {
    if (l.kind === "exempt") addInto(nil[bucket(l)], l, l.sign);
    else if (l.kind === "out_of_scope") addInto(nonGst[bucket(l)], l, l.sign);
  }

  // table 12: summary by HSN and rate, over invoices and credit notes (a note reduces it)
  const hsn = new Map();
  for (const l of out.filter((x) => !x.charge && (x.kind === "standard" || x.kind === "zero_rated"))) {
    const key = `${l.hsnCode || ""}|${l.rate}`;
    if (!hsn.has(key)) hsn.set(key, { hsnCode: l.hsnCode || "", rate: num(l.rate), qty: 0, ...ZERO() });
    const r = hsn.get(key);
    r.qty = round2(r.qty + l.sign * num(l.qty));
    addInto(r, l, l.sign);
  }
  const hsnRows = [...hsn.values()].sort((a, b) => a.hsnCode.localeCompare(b.hsnCode) || a.rate - b.rate);

  // table 13: documents issued
  const issued = (type) => {
    const nos = [...new Set(out.filter((l) => l.docType === type).map((l) => l.docNo))].sort();
    return { count: nos.length, from: nos[0] || null, to: nos[nos.length - 1] || null };
  };

  const all = ZERO();
  for (const l of out.filter((x) => x.kind === "standard" || x.kind === "zero_rated")) addInto(all, l, l.sign);

  return {
    b2b, b2cl, b2cs: [...b2cs.values()].sort((a, b) => String(a.placeOfSupply).localeCompare(String(b.placeOfSupply)) || a.rate - b.rate),
    cdnr, cdnur, zeroRated, nil, nonGst, hsn: hsnRows,
    hsnMissing: hsnRows.some((r) => !r.hsnCode),
    documentsIssued: { invoices: issued("sales_order"), creditNotes: issued("sales_return") },
    totals: { ...all, tax: taxOf(all) },
    sections: { b2b: totalsOf(b2b), b2cl: totalsOf(b2cl), cdnr: totalsOf(cdnr), cdnur: totalsOf(cdnur) },
  };
}

/**
 * Pays `liability` (the ordinary output tax, by component) with `itc` (the input tax credit, by component), in the order section 49A
 * and rule 86B allow:
 *   IGST credit   first IGST, then CGST, then SGST
 *   CGST credit   first CGST, then IGST   (never SGST)
 *   SGST credit   first SGST, then IGST   (never CGST)
 * Credit that is left carries forward; tax that is left is paid in cash. Tax on a reverse charge is NOT paid by credit at all
 * (it is cash only, then claimed as credit next), so the caller adds it to `cash` after.
 */
function utilise(liability, itc) {
  const L = { igst: round2(num(liability.igst)), cgst: round2(num(liability.cgst)), sgst: round2(num(liability.sgst)) };
  const C = { igst: round2(num(itc.igst)), cgst: round2(num(itc.cgst)), sgst: round2(num(itc.sgst)) };
  const used = { igst: { igst: 0, cgst: 0, sgst: 0 }, cgst: { igst: 0, cgst: 0, sgst: 0 }, sgst: { igst: 0, cgst: 0, sgst: 0 } }; // used[credit][liability]
  const pay = (credit, tax) => {
    const take = round2(Math.min(Math.max(C[credit], 0), Math.max(L[tax], 0)));
    if (take <= 0) return;
    C[credit] = round2(C[credit] - take);
    L[tax] = round2(L[tax] - take);
    used[credit][tax] = round2(used[credit][tax] + take);
  };
  for (const tax of ["igst", "cgst", "sgst"]) pay("igst", tax); // IGST credit: IGST, CGST, SGST
  pay("cgst", "cgst"); pay("cgst", "igst"); // CGST credit: CGST, then IGST
  pay("sgst", "sgst"); pay("sgst", "igst"); // SGST credit: SGST, then IGST
  return { cash: L, carryForward: C, used };
}

function gstr3b(lines) {
  const out = lines.filter((l) => l.direction === "output");
  const inp = lines.filter((l) => l.direction === "input");
  const sum = (arr) => arr.reduce((acc, l) => addInto(acc, l, l.sign), ZERO());
  const of = (arr, kind) => sum(arr.filter((l) => l.kind === kind));

  const outwardTaxable = of(out, "standard"); // 3.1(a)
  const outwardZero = of(out, "zero_rated"); // 3.1(b)
  const outwardNil = of(out, "exempt"); // 3.1(c)
  const outwardNonGst = of(out, "out_of_scope"); // 3.1(e)

  // 3.1(d): inward supplies liable to reverse charge: the value of the lines and the tax the recipient assesses
  const rcLines = inp.filter((l) => l.kind === "reverse_charge");
  const rc = ZERO();
  for (const l of rcLines) {
    rc.taxable = round2(rc.taxable + l.sign * num(l.taxable));
    rc.igst = round2(rc.igst + l.sign * num(l.rcmIgst));
    rc.cgst = round2(rc.cgst + l.sign * num(l.rcmCgst));
    rc.sgst = round2(rc.sgst + l.sign * num(l.rcmSgst));
  }

  // 4(A): input tax credit. (3) inward supplies liable to reverse charge (once the tax is paid in cash), (5) all other ITC.
  const otherItc = inp.filter((l) => l.kind === "standard" || l.kind === "zero_rated").reduce((acc, l) => addInto(acc, l, l.sign), ZERO());
  const itcFromRc = { igst: rc.igst, cgst: rc.cgst, sgst: rc.sgst };
  const itcTotal = { igst: round2(otherItc.igst + itcFromRc.igst), cgst: round2(otherItc.cgst + itcFromRc.cgst), sgst: round2(otherItc.sgst + itcFromRc.sgst) };

  const liability = { igst: round2(outwardTaxable.igst + outwardZero.igst), cgst: round2(outwardTaxable.cgst + outwardZero.cgst), sgst: round2(outwardTaxable.sgst + outwardZero.sgst) };
  const utilised = utilise(liability, itcTotal);
  const reverseChargeCash = { igst: rc.igst, cgst: rc.cgst, sgst: rc.sgst };

  return {
    outward: {
      taxable: { ...outwardTaxable, tax: taxOf(outwardTaxable) }, zeroRated: { ...outwardZero, tax: taxOf(outwardZero) },
      nilExempt: outwardNil, nonGst: outwardNonGst, reverseCharge: { ...rc, tax: taxOf(rc) },
    },
    itc: { other: { igst: otherItc.igst, cgst: otherItc.cgst, sgst: otherItc.sgst }, reverseCharge: itcFromRc, total: itcTotal },
    liability: { ordinary: liability, reverseCharge: reverseChargeCash },
    utilised: utilised.used,
    payableInCash: {
      igst: round2(utilised.cash.igst + reverseChargeCash.igst), cgst: round2(utilised.cash.cgst + reverseChargeCash.cgst), sgst: round2(utilised.cash.sgst + reverseChargeCash.sgst),
    },
    creditCarriedForward: utilised.carryForward,
  };
}

module.exports = { GSTR1_LARGE_LIMIT, gstr1, gstr3b, utilise };
