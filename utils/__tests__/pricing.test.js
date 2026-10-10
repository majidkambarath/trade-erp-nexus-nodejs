const test = require("node:test");
const assert = require("node:assert/strict");
const { priceLine, priceCharge, priceDocument } = require("../pricing");

test("a percentage discount reduces the taxable base, and VAT follows the discounted base", () => {
  const l = priceLine({ qty: 10, price: 100, discountPercent: 10, vatPercent: 5 });
  assert.equal(l.gross, 1000);
  assert.equal(l.discount, 100);
  assert.equal(l.taxable, 900);
  assert.equal(l.vat, 45); // 5% of 900, not of 1000
  assert.equal(l.lineTotal, 945);
});

test("a fixed discount wins over a percentage and can never exceed the line", () => {
  assert.equal(priceLine({ qty: 1, price: 50, discountAmount: 20, discountPercent: 90 }).discount, 20);
  assert.equal(priceLine({ qty: 1, price: 50, discountAmount: 999 }).discount, 50);
});

test("each column is rounded before summing, so the total equals the sum of the columns", () => {
  // 3 x 0.335 = 1.005 -> 1.01 ; vat 5% of 1.01 = 0.0505 -> 0.05
  const a = priceLine({ qty: 3, price: 0.335, vatPercent: 5 });
  assert.equal(a.gross, 1.01);
  assert.equal(a.vat, 0.05);
  assert.equal(a.lineTotal, 1.06);
});

test("price falls back to rate, then to zero", () => {
  assert.equal(priceLine({ qty: 2, rate: 7 }).gross, 14);
  assert.equal(priceLine({ qty: 2 }).gross, 0);
});

test("document totals: lines + charges (with their own VAT) - header discount", () => {
  const lines = [priceLine({ qty: 10, price: 100, discountPercent: 10, vatPercent: 5 })];
  const charges = [priceCharge({ amount: 40, vatPercent: 5 })];
  const d = priceDocument(lines, charges, { headerDiscount: 15 });
  assert.equal(d.net, 900);
  assert.equal(d.lineVat, 45);
  assert.equal(d.chargesNet, 40);
  assert.equal(d.chargesVat, 2);
  assert.equal(d.grandTotal, 972); // 900 + 45 + 40 + 2 - 15
  assert.equal(d.roundOff, 0);
});

test("a small difference from the client's total is kept as an explicit round-off", () => {
  const lines = [priceLine({ qty: 1, price: 100.4, vatPercent: 0 })];
  const d = priceDocument(lines, [], { incomingTotal: 100 });
  assert.equal(d.roundOff, -0.4);
  assert.equal(d.grandTotal, 100);
});

test("a large mismatch (a return form posting 0) is overridden by the computed total", () => {
  const lines = [priceLine({ qty: 5, price: 20, vatPercent: 5 })];
  const d = priceDocument(lines, [], { incomingTotal: 0 });
  assert.equal(d.roundOff, 0);
  assert.equal(d.grandTotal, 105);
});

test("a header discount cannot push the total below zero", () => {
  const d = priceDocument([priceLine({ qty: 1, price: 10 })], [], { headerDiscount: 500 });
  assert.equal(d.grandTotal, 0);
});

// ================================= reverse charge =================================
// The supplier charges no VAT; the recipient assesses it. So a reverse-charge line carries NO vat and its total is its net, while the
// assessed amount is a separate figure that is never inside the line total, the document total or what the party is owed.
const RC = { taxKind: "reverse_charge" };

test("a reverse-charge line has no VAT in its total and carries the assessed VAT beside it", () => {
  const l = priceLine({ qty: 4, price: 100, vatPercent: 5, ...RC });
  assert.equal(l.taxable, 400);
  assert.equal(l.vat, 0);
  assert.equal(l.lineTotal, 400, "what the supplier is owed: the net");
  assert.equal(l.rcmVat, 20);
  assert.equal(l.reverseCharge, true);
  assert.equal(l.vatPercent, 5);
});

test("the assessed VAT follows the discounted base, rounded per line like any VAT", () => {
  assert.equal(priceLine({ qty: 10, price: 100, discountPercent: 10, vatPercent: 5, ...RC }).rcmVat, 45, "5% of 900, not of 1000");
  assert.equal(priceLine({ qty: 3, price: 0.335, vatPercent: 5, ...RC }).rcmVat, 0.05);
  assert.equal(priceLine({ qty: 1, price: 1.1, discountAmount: 5, vatPercent: 5, ...RC }).rcmVat, 0, "a discount cannot take the base below zero");
});

test("the rate is the line's own (a code's), with 5 only when none is given", () => {
  assert.equal(priceLine({ qty: 1, price: 200, vatPercent: 10, ...RC }).rcmVat, 20);
  assert.equal(priceLine({ qty: 1, price: 200, ...RC }).rcmVat, 10, "no rate given: the standard 5%");
  assert.equal(priceLine({ qty: 1, price: 200, vatPercent: null, ...RC }).vatPercent, 5);
  const zero = priceLine({ qty: 1, price: 200, vatPercent: 0, ...RC });
  assert.equal(zero.rcmVat, 0, "an explicit 0% (a zero-rated service from abroad) is declared with nil VAT, not turned into 5%");
  assert.equal(zero.reverseCharge, true);
});

test("any other kind is priced exactly as before and has no assessed VAT", () => {
  for (const taxKind of ["standard", "zero_rated", "exempt", "out_of_scope", undefined, null]) {
    const l = priceLine({ qty: 4, price: 100, vatPercent: taxKind === "standard" ? 5 : 0, taxKind });
    assert.equal(l.rcmVat, undefined, String(taxKind));
    assert.equal(l.reverseCharge, undefined);
  }
  const std = priceLine({ qty: 4, price: 100, vatPercent: 5, taxKind: "standard" });
  assert.deepEqual([std.vat, std.lineTotal], [20, 420]);
});

test("a document sums the assessed VAT apart from its total; freight is untouched", () => {
  const lines = [
    priceLine({ qty: 4, price: 100, vatPercent: 5, ...RC }), // 400, assessed 20
    priceLine({ qty: 2, price: 100, vatPercent: 5 }), // 200 + 10
  ].map((l) => ({ gross: l.gross, discount: l.discount, taxable: l.taxable, vat: l.vat, rcmVat: l.rcmVat }));
  const d = priceDocument(lines, [priceCharge({ amount: 40, vatPercent: 5 })]);
  assert.equal(d.rcmVat, 20);
  assert.equal(d.lineVat, 10, "only the VAT the supplier charged");
  assert.equal(d.chargesVat, 2);
  assert.equal(d.grandTotal, 652, "400 + 200 + 10 + 40 + 2: the assessed 20 is not owed to anyone");
});

test("a document with no reverse-charge line reports 0 assessed", () => {
  assert.equal(priceDocument([priceLine({ qty: 5, price: 20, vatPercent: 5 })]).rcmVat, 0);
});
