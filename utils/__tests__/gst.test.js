const test = require("node:test");
const assert = require("node:assert/strict");
const { placeOfSupply, splitGst, stampGst, partyState, addGst, totalGst } = require("../gst");
const { stateCodeOfGstin, normaliseState, isStateCode, stateName, secondHalfName, stateList } = require("../gstStates");

test("a GSTIN names its state by its first two digits, when they are a real code", () => {
  assert.equal(stateCodeOfGstin("27AAPFU0939F1ZV"), "27");
  assert.equal(stateCodeOfGstin("  29ABCDE1234F1Z5 "), "29");
  assert.equal(stateCodeOfGstin("25ABCDE1234F1Z5"), null, "25 was merged into 26 and is no longer a code");
  assert.equal(stateCodeOfGstin("XX27"), null);
  assert.equal(stateCodeOfGstin(null), null);
});

test("a state can be typed as a code, a number or a name", () => {
  assert.equal(normaliseState("27"), "27");
  assert.equal(normaliseState(7), "07");
  assert.equal(normaliseState("maharashtra"), "27");
  assert.equal(normaliseState("Jammu & Kashmir"), "01");
  assert.equal(normaliseState(""), null);
  assert.equal(normaliseState("Atlantis"), undefined);
  assert.ok(isStateCode("97") && isStateCode("99") && !isStateCode("25") && !isStateCode("00"));
  assert.equal(stateName("32"), "Kerala");
  assert.ok(stateList().length >= 37);
});

test("a union territory without a legislature charges UTGST, a state SGST", () => {
  assert.equal(secondHalfName("04"), "UTGST");
  assert.equal(secondHalfName("27"), "SGST");
  assert.equal(secondHalfName("07"), "SGST", "Delhi has a legislature");
});

test("the party's state is the stored code, else the GSTIN's", () => {
  assert.equal(partyState({ stateCode: "29" }), "29");
  assert.equal(partyState({ vat: { trn: "27AAPFU0939F1ZV" } }), "27");
  assert.equal(partyState({ trnNumber: "33AAPFU0939F1ZV" }), "33");
  assert.equal(partyState({ stateCode: "bad", vat: { trn: "07AAPFU0939F1ZV" } }), "07");
  assert.equal(partyState({}), null);
});

test("a sale to the same state is intra-state, to another it is inter-state, with no customer state it is intra-state", () => {
  assert.deepEqual(placeOfSupply({ companyState: "27", party: { stateCode: "27" }, side: "sales" }), { gstType: "intra", supplierState: "27", placeOfSupply: "27" });
  assert.deepEqual(placeOfSupply({ companyState: "27", party: { stateCode: "29" }, side: "sales" }), { gstType: "inter", supplierState: "27", placeOfSupply: "29" });
  assert.equal(placeOfSupply({ companyState: "27", party: {}, side: "sales" }).gstType, "intra");
});

test("a purchase is judged by the vendor's state against the company's", () => {
  assert.deepEqual(placeOfSupply({ companyState: "27", party: { stateCode: "24" }, side: "purchase" }), { gstType: "inter", supplierState: "24", placeOfSupply: "27" });
  assert.equal(placeOfSupply({ companyState: "27", party: { stateCode: "27" }, side: "purchase" }).gstType, "intra");
  assert.equal(placeOfSupply({ companyState: "27", party: {}, side: "purchase" }).gstType, "intra");
});

test("with no company state on file nothing is split", () => {
  assert.deepEqual(placeOfSupply({ companyState: null, party: { stateCode: "27" }, side: "sales" }), { gstType: null, supplierState: null, placeOfSupply: null });
  assert.equal(splitGst(100, null), null);
});

test("the split always adds back to the tax, an odd fil going to CGST", () => {
  assert.deepEqual(splitGst(18, "intra"), { cgst: 9, sgst: 9, igst: 0 });
  assert.deepEqual(splitGst(0.05, "intra"), { cgst: 0.03, sgst: 0.02, igst: 0 });
  assert.deepEqual(splitGst(0.01, "intra"), { cgst: 0.01, sgst: 0, igst: 0 });
  assert.deepEqual(splitGst(18, "inter"), { cgst: 0, sgst: 0, igst: 18 });
  for (let i = 0; i < 2000; i++) {
    const tax = Math.round(Math.random() * 1e7) / 100;
    for (const type of ["intra", "inter"]) {
      const s = splitGst(tax, type);
      assert.equal(totalGst(s), Math.round(tax * 100) / 100, `${tax} ${type}`);
      assert.ok(s.cgst >= 0 && s.sgst >= 0 && s.igst >= 0);
    }
  }
});

test("a document is stamped line by line and its total is the sum of the lines", () => {
  const lines = [{ vatAmount: 0.05 }, { vatAmount: 0.05 }, { vatAmount: 0, rcmVat: 5 }];
  const out = stampGst({ lines, charges: [{ vatAmount: 0.01 }], gstType: "intra" });
  assert.deepEqual(out.lines[0].gst, { cgst: 0.03, sgst: 0.02, igst: 0 });
  assert.deepEqual(out.gst, { cgst: 0.07, sgst: 0.04, igst: 0 }, "0.11 of tax in all, split per line, not once on the sum");
  assert.equal(totalGst(out.gst), 0.11);
  assert.deepEqual(out.rcmGst, { cgst: 2.5, sgst: 2.5, igst: 0 });
  assert.equal(out.lines[2].rcmGst.cgst, 2.5);
  assert.equal(stampGst({ lines, gstType: null }).gst, null);
});

test("addGst adds components", () => {
  assert.deepEqual(addGst({ cgst: 1, sgst: 1, igst: 0 }, { igst: 2.5 }), { cgst: 1, sgst: 1, igst: 2.5 });
});

const { routeGstLegs, gstKeysNeeded } = require("../gst");

test("routing replaces the single VAT leg by one leg per component, on the same side, and still balances", () => {
  const ids = { "gst-cgst-output": "C", "gst-sgst-output": "S", "gst-igst-output": "I" };
  const entries = [
    { accountId: "AR", debitAmount: 1180, creditAmount: 0, figure: "total" },
    { accountId: "REV", debitAmount: 0, creditAmount: 1000, figure: "gross" },
    { accountId: "VAT", debitAmount: 0, creditAmount: 180, figure: "vat" },
  ];
  const out = routeGstLegs(entries, "sales_order", { gst: { cgst: 90, sgst: 90, igst: 0 } }, (k) => ids[k]);
  assert.deepEqual(out.filter((e) => e.figure === "vat").map((e) => [e.accountId, e.creditAmount]), [["C", 90], ["S", 90]]);
  assert.equal(out.reduce((s, e) => s + e.debitAmount - e.creditAmount, 0), 0);
  // a return is the mirror: the legs come back on the debit side
  const back = routeGstLegs([{ accountId: "VAT", debitAmount: 18, creditAmount: 0, figure: "vat" }], "sales_return", { gst: { cgst: 0, sgst: 0, igst: 18 } }, (k) => ids[k]);
  assert.deepEqual(back.map((e) => [e.accountId, e.debitAmount, e.creditAmount]), [["I", 18, 0]]);
});

test("a leg whose components do not add back to its amount is left as it was, so a posting never fails over the split", () => {
  const entries = [{ accountId: "VAT", debitAmount: 0, creditAmount: 180, figure: "vat" }];
  assert.deepEqual(routeGstLegs(entries, "sales_order", { gst: { cgst: 50, sgst: 50, igst: 0 } }, () => "X"), entries);
  assert.deepEqual(routeGstLegs(entries, "sales_order", {}, () => "X"), entries, "no GST detail at all");
});

test("a reverse-charge purchase splits only its INPUT leg; the liability leg stays one", () => {
  const ids = { "gst-sgst-input": "SI", "gst-cgst-input": "CI", "gst-igst-input": "II" };
  const entries = [
    { accountId: "IN", debitAmount: 5, creditAmount: 0, figure: "rcmVat" },
    { accountId: "RCM", debitAmount: 0, creditAmount: 5, figure: "rcmVat" },
  ];
  const out = routeGstLegs(entries, "purchase_order", { rcmGst: { cgst: 2.5, sgst: 2.5, igst: 0 } }, (k) => ids[k], { inputAccountId: "IN" });
  assert.deepEqual(out.map((e) => [e.accountId, e.debitAmount, e.creditAmount]), [["CI", 2.5, 0], ["SI", 2.5, 0], ["RCM", 0, 5]]);
});

test("the posting keys a document needs are only those with an amount, by direction", () => {
  assert.deepEqual(gstKeysNeeded("sales_order", { gst: { cgst: 9, sgst: 9, igst: 0 } }).sort(), ["gst-cgst-output", "gst-sgst-output"]);
  assert.deepEqual(gstKeysNeeded("purchase_return", { gst: { cgst: 0, sgst: 0, igst: 3 } }), ["gst-igst-input"]);
  assert.deepEqual(gstKeysNeeded("sales_order", {}), []);
});
