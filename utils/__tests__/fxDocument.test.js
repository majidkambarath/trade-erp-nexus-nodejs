const test = require("node:test");
const assert = require("node:assert/strict");
const { convertLinesToBase, convertChargesToBase, foreignView, carryingFor, exchangeDifference } = require("../fxDocument");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
// a priced foreign line, the way calculateItems stores it
const line = (qty, price, vatPercent = 5, discountPercent = 0) => {
  const gross = round2(qty * price);
  const discount = round2((gross * discountPercent) / 100);
  const taxable = round2(gross - discount);
  const vat = round2((taxable * vatPercent) / 100);
  return { qty, price, grossAmount: gross, discountAmount: discount, taxableAmount: taxable, vatAmount: vat, lineTotal: round2(taxable + vat), grandTotal: round2(taxable + vat), rate: taxable, vatPercent };
};

test("1,000 USD of goods at 3.6725 with 5% VAT: 3,672.50 and 183.63 in base, and the foreign figures are kept", () => {
  const [l] = convertLinesToBase([line(10, 100)], 3.6725);
  assert.equal(l.grossAmount, 3672.5);
  assert.equal(l.taxableAmount, 3672.5);
  assert.equal(l.vatAmount, 183.63, "50 USD x 3.6725 = 183.625, half up");
  assert.equal(l.lineTotal, 3856.13);
  assert.equal(l.discountAmount, 0);
  assert.equal(l.rate, 3672.5);
  assert.equal(l.price, 367.25);
  assert.deepEqual(l.fx, { price: 100, grossAmount: 1000, discountAmount: 0, taxableAmount: 1000, vatAmount: 50, lineTotal: 1050 });
});

test("a line always adds up in base, whatever the rate: discount = gross - taxable and total = taxable + tax", () => {
  let seed = 3;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let n = 0; n < 3000; n++) {
    const rate = Math.round((0.01 + rnd() * 90) * 1e6) / 1e6;
    const l = line(1 + Math.floor(rnd() * 30), Math.round(rnd() * 99999) / 100, [0, 5, 18][Math.floor(rnd() * 3)], [0, 0, 10, 25][Math.floor(rnd() * 4)]);
    const [b] = convertLinesToBase([l], rate);
    assert.equal(round2(b.grossAmount - b.discountAmount), b.taxableAmount, JSON.stringify({ rate, l }));
    assert.equal(round2(b.taxableAmount + b.vatAmount), b.lineTotal, JSON.stringify({ rate, l }));
    assert.ok(b.discountAmount >= 0 && b.vatAmount >= 0 && b.taxableAmount >= 0);
  }
});

test("the base total is within a cent a line of the foreign total converted in one go", () => {
  const lines = [line(3, 19.99), line(7, 4.5, 5, 10), line(1, 1234.56, 0)];
  const base = convertLinesToBase(lines, 3.6725);
  const foreignTotal = lines.reduce((t, l) => t + l.lineTotal, 0);
  const baseTotal = base.reduce((t, l) => t + l.lineTotal, 0);
  assert.ok(Math.abs(baseTotal - foreignTotal * 3.6725) <= 0.01 * lines.length, `${baseTotal} vs ${foreignTotal * 3.6725}`);
});

test("a reverse-charge line converts its assessed tax too, and a header-discount share cannot exceed the line's discount", () => {
  const rc = { ...line(1, 1000, 0), rcmVat: 50, headerDiscountNet: 100, discountAmount: 100, grossAmount: 1100, taxableAmount: 1000, lineTotal: 1000, rate: 1000 };
  const [b] = convertLinesToBase([rc], 2);
  assert.equal(b.rcmVat, 100);
  assert.equal(b.vatAmount, 0);
  assert.equal(b.discountAmount, 200);
  assert.ok(b.headerDiscountNet <= b.discountAmount);
});

test("zero stays zero, nothing is invented, and the input is not changed", () => {
  const l = line(1, 100, 0);
  const copy = JSON.parse(JSON.stringify(l));
  const [b] = convertLinesToBase([l], 3.6725);
  assert.equal(b.vatAmount, 0);
  assert.equal("rcmVat" in b, false);
  assert.equal("headerDiscountNet" in b, false);
  assert.deepEqual(l, copy);
});

test("charges: the net and its tax are converted, the foreign figures kept", () => {
  const [c] = convertChargesToBase([{ code: "FRT", description: "Freight", amount: 40, vatPercent: 5, vatAmount: 2 }], 3.6725);
  assert.deepEqual([c.amount, c.vatAmount], [146.9, 7.35]);
  assert.deepEqual(c.fx, { amount: 40, vatAmount: 2 });
  assert.equal(c.description, "Freight");
});

test("the foreign view keeps the header figures and only the spread when there is one", () => {
  const p = { gross: 1000, lineDiscount: 0, net: 1000, lineVat: 50, rcmVat: 0, chargesNet: 0, chargesVat: 0, headerDiscount: 0, roundOff: 0, grandTotal: 1050, extra: "x" };
  assert.deepEqual(foreignView(p), { gross: 1000, lineDiscount: 0, net: 1000, lineVat: 50, rcmVat: 0, chargesNet: 0, chargesVat: 0, headerDiscount: 0, roundOff: 0, grandTotal: 1050 });
  assert.equal(foreignView({ ...p, headerDiscountSpread: 105 }).headerDiscountSpread, 105);
});

test("settling all of what is owed clears all of what the ledger carries; settling part clears the same share", () => {
  assert.equal(carryingFor(1000, 1000, 3672.5), 3672.5);
  assert.equal(carryingFor(400, 1000, 3672.5), 1469);
  assert.equal(carryingFor(600, 600, 2203.5), 2203.5, "the last part takes whatever is left, so nothing is stranded by rounding");
  assert.equal(carryingFor(0, 1000, 3672.5), 0);
  assert.equal(carryingFor(1500, 1000, 3672.5), 3672.5, "never more than is carried");
});

test("the exchange difference is the money's worth less the carrying value", () => {
  assert.equal(exchangeDifference(3680, 3672.5), 7.5);
  assert.equal(exchangeDifference(3660, 3672.5), -12.5);
  assert.equal(exchangeDifference(3672.5, 3672.5), 0);
});
