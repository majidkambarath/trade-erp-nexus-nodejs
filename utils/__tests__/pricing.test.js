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
