const test = require("node:test");
const assert = require("node:assert/strict");
const { gstr1, gstr3b, utilise } = require("../gstReturns");

const L = (o) => ({
  docId: "d1", docNo: "SO-1", docType: "sales_order", date: "2026-11-02", direction: "output", sign: 1, party: { id: "p", name: "Buyer", gstin: null },
  gstType: "intra", placeOfSupply: "27", docValue: 1180, hsnCode: "7318", qty: 1, kind: "standard", rate: 18, taxable: 1000, cgst: 90, sgst: 90, igst: 0, ...o,
});
const REG = { id: "r", name: "Registered Co", gstin: "29AAPFU0939F1ZV" };

test("GSTR-1: registered buyers go to B2B invoice by invoice and rate, unregistered small ones are summed by state and rate", () => {
  const r = gstr1([
    L({ docId: "a", docNo: "SO-1", party: REG, gstType: "inter", placeOfSupply: "29", cgst: 0, sgst: 0, igst: 180 }),
    L({ docId: "a", docNo: "SO-1", party: REG, gstType: "inter", placeOfSupply: "29", rate: 5, taxable: 200, cgst: 0, sgst: 0, igst: 10, hsnCode: "7319" }),
    L({ docId: "b", docNo: "SO-2" }),
    L({ docId: "c", docNo: "SO-3" }),
  ]);
  assert.deepEqual(r.b2b.map((x) => [x.docNo, x.rate, x.taxable, x.igst]), [["SO-1", 5, 200, 10], ["SO-1", 18, 1000, 180]]);
  assert.equal(r.b2b[0].gstin, "29AAPFU0939F1ZV");
  assert.equal(r.b2cs.length, 1);
  assert.deepEqual([r.b2cs[0].placeOfSupply, r.b2cs[0].rate, r.b2cs[0].taxable, r.b2cs[0].cgst, r.b2cs[0].sgst], ["27", 18, 2000, 180, 180]);
  assert.equal(r.b2cl.length, 0);
});

test("GSTR-1: an inter-state invoice to an unregistered buyer above one lakh is listed invoice by invoice", () => {
  const big = L({ docId: "big", docNo: "SO-9", gstType: "inter", placeOfSupply: "29", docValue: 250000, taxable: 211864.41, cgst: 0, sgst: 0, igst: 38135.59 });
  const small = L({ docId: "sm", docNo: "SO-10", gstType: "inter", placeOfSupply: "29", docValue: 99999 });
  const r = gstr1([big, small]);
  assert.deepEqual(r.b2cl.map((x) => x.docNo), ["SO-9"]);
  assert.equal(r.b2cs.reduce((s, x) => s + x.taxable, 0), 1000, "the small one stays in the summary");
});

test("GSTR-1: a credit note is its own row, positive, and reduces the totals and the HSN summary", () => {
  const r = gstr1([
    L({ docId: "a", docNo: "SO-1", party: REG, qty: 10 }),
    L({ docId: "n", docNo: "SR-1", docType: "sales_return", sign: -1, party: REG, qty: 2, taxable: 200, cgst: 18, sgst: 18, docValue: 236 }),
  ]);
  assert.deepEqual(r.cdnr.map((x) => [x.docNo, x.taxable, x.cgst]), [["SR-1", 200, 18]]);
  assert.equal(r.hsn.length, 1);
  assert.deepEqual([r.hsn[0].qty, r.hsn[0].taxable, r.hsn[0].cgst], [8, 800, 72]);
  assert.deepEqual([r.totals.taxable, r.totals.tax], [800, 144]);
  assert.deepEqual([r.documentsIssued.invoices.count, r.documentsIssued.creditNotes.count], [1, 1]);
});

test("GSTR-1: an unregistered buyer's small return reduces the B2CS summary", () => {
  const r = gstr1([L({ docId: "a", docNo: "SO-1" }), L({ docId: "n", docNo: "SR-1", docType: "sales_return", sign: -1, taxable: 400, cgst: 36, sgst: 36, docValue: 472 })]);
  assert.deepEqual([r.b2cs[0].taxable, r.b2cs[0].cgst, r.b2cs[0].sgst], [600, 54, 54]);
  assert.equal(r.cdnur.length, 0);
});

test("GSTR-1: nil, exempt and non-GST supplies are tabulated by buyer and by crossing a state line; zero-rated are listed apart", () => {
  const r = gstr1([
    L({ docId: "x", docNo: "SO-5", kind: "exempt", rate: 0, cgst: 0, sgst: 0, taxable: 300 }),
    L({ docId: "y", docNo: "SO-6", kind: "exempt", rate: 0, cgst: 0, sgst: 0, taxable: 100, party: REG, gstType: "inter", placeOfSupply: "29" }),
    L({ docId: "z", docNo: "SO-7", kind: "out_of_scope", rate: 0, cgst: 0, sgst: 0, taxable: 50 }),
    L({ docId: "e", docNo: "SO-8", kind: "zero_rated", rate: 0, cgst: 0, sgst: 0, igst: 0, taxable: 5000, gstType: "inter", placeOfSupply: "97" }),
  ]);
  assert.equal(r.nil.intraUnregistered.taxable, 300);
  assert.equal(r.nil.interRegistered.taxable, 100);
  assert.equal(r.nonGst.intraUnregistered.taxable, 50);
  assert.deepEqual(r.zeroRated.map((x) => [x.docNo, x.taxable]), [["SO-8", 5000]]);
  assert.equal(r.b2b.length + r.b2cs.length, 0, "none of those is a taxable supply");
});

test("GSTR-1: lines with no HSN code are shown under a blank code and flagged", () => {
  const r = gstr1([L({ hsnCode: "" })]);
  assert.equal(r.hsnMissing, true);
  assert.equal(gstr1([L({})]).hsnMissing, false);
});

test("credit is used in the order the Act allows: IGST credit across all three, CGST and SGST credit only on their own and IGST", () => {
  // liability: IGST 100, CGST 50, SGST 50; credit: IGST 120, CGST 80, SGST 10
  const u = utilise({ igst: 100, cgst: 50, sgst: 50 }, { igst: 120, cgst: 80, sgst: 10 });
  // IGST credit pays IGST 100, then 20 of CGST; CGST credit pays the remaining 30 of CGST, 50 is left;
  // SGST credit pays 10 of SGST, the remaining 40 of SGST is paid by what is left of IGST credit (0) -> 40 cash
  assert.deepEqual(u.cash, { igst: 0, cgst: 0, sgst: 40 });
  assert.deepEqual(u.carryForward, { igst: 0, cgst: 50, sgst: 0 }, "CGST credit can never pay SGST, so it carries forward");
  assert.equal(u.used.igst.igst, 100);
  assert.equal(u.used.igst.cgst, 20);
  assert.equal(u.used.cgst.cgst, 30);
});

test("GSTR-3B: outward supplies, credit, and what is paid in cash", () => {
  const r = gstr3b([
    L({ docId: "s1", cgst: 90, sgst: 90 }), // output 180
    L({ docId: "s2", gstType: "inter", cgst: 0, sgst: 0, igst: 180 }),
    L({ docId: "n1", docType: "sales_return", sign: -1, taxable: 100, cgst: 9, sgst: 9 }),
    L({ docId: "p1", direction: "input", docType: "purchase_order", gstType: "inter", cgst: 0, sgst: 0, igst: 100, taxable: 555.56 }),
    L({ docId: "p2", direction: "input", docType: "purchase_order", cgst: 20, sgst: 20, igst: 0, taxable: 222.22 }),
  ]);
  assert.deepEqual([r.outward.taxable.taxable, r.outward.taxable.cgst, r.outward.taxable.sgst, r.outward.taxable.igst], [1900, 81, 81, 180]);
  assert.deepEqual(r.itc.total, { igst: 100, cgst: 20, sgst: 20 });
  assert.deepEqual(r.liability.ordinary, { igst: 180, cgst: 81, sgst: 81 });
  // IGST credit 100 pays IGST; CGST credit 20 pays CGST; SGST credit 20 pays SGST
  assert.deepEqual(r.payableInCash, { igst: 80, cgst: 61, sgst: 61 });
});

test("GSTR-3B: tax on a reverse charge is paid in cash and then claimed as credit in the same return", () => {
  const r = gstr3b([
    L({ docId: "s1", cgst: 90, sgst: 90 }),
    L({ docId: "p1", direction: "input", docType: "purchase_order", kind: "reverse_charge", rate: 18, taxable: 1000, cgst: 0, sgst: 0, igst: 0, rcmCgst: 90, rcmSgst: 90, rcmIgst: 0 }),
  ]);
  assert.deepEqual(r.outward.reverseCharge, { taxable: 1000, cgst: 90, sgst: 90, igst: 0, tax: 180 });
  assert.deepEqual(r.itc.reverseCharge, { igst: 0, cgst: 90, sgst: 90 });
  // the ordinary liability (90 / 90) is paid by the credit just claimed; the reverse-charge tax itself (90 / 90) is cash
  assert.deepEqual(r.payableInCash, { igst: 0, cgst: 90, sgst: 90 });
  assert.deepEqual(r.creditCarriedForward, { igst: 0, cgst: 0, sgst: 0 });
});
