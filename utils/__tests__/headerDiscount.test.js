const test = require("node:test");
const assert = require("node:assert/strict");
const { spreadHeaderDiscount } = require("../headerDiscount");
const { priceLine } = require("../pricing");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
// a line the way calculateItems stores it
const line = (qty, price, vatPercent = 5, extra = {}) => {
  const p = priceLine({ qty, price, vatPercent, ...extra });
  return { qty, price, vatPercent, grossAmount: p.gross, discountAmount: p.discount, taxableAmount: p.taxable, vatAmount: p.vat, lineTotal: p.lineTotal, grandTotal: p.lineTotal, rate: p.taxable, ...extra.keep };
};
const sum = (lines, k) => round2(lines.reduce((t, l) => t + l[k], 0));

test("a discount of 105 on one 5% line of 1000 takes 100 off the taxable amount and 5 off the tax: the total falls by exactly 105", () => {
  const r = spreadHeaderDiscount([line(10, 100)], 105);
  assert.equal(r.applied, 105);
  assert.deepEqual([r.lines[0].taxableAmount, r.lines[0].vatAmount, r.lines[0].lineTotal], [900, 45, 945]);
  assert.equal(r.lines[0].discountAmount, 100, "it is an ordinary line discount now");
  assert.equal(r.lines[0].rate, 900);
  assert.deepEqual([r.net, r.vat], [100, 5]);
});

test("it is shared over the lines by what each costs the customer, and the shares add up to the amount", () => {
  const lines = [line(1, 100, 5), line(1, 300, 5), line(1, 100, 0)]; // 105 + 315 + 100 = 520
  const r = spreadHeaderDiscount(lines, 52);
  assert.equal(r.applied, 52);
  assert.equal(sum(r.lines, "lineTotal"), round2(520 - 52));
  assert.deepEqual(r.lines.map((l) => l.lineTotal), [94.5, 283.5, 90]); // a tenth off each
  assert.equal(r.lines[2].vatAmount, 0, "a zero-rated line stays at no tax");
  assert.equal(round2(r.net + r.vat), 52);
});

test("the total never moves, whatever the amounts: 2,000 random invoices, exact to the fils", () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let n = 0; n < 2000; n++) {
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => line(1 + Math.floor(rnd() * 20), round2(rnd() * 500), [0, 5, 5, 12, 18][Math.floor(rnd() * 5)]));
    const total = sum(lines, "lineTotal");
    const typed = round2(rnd() * total * 0.9);
    const r = spreadHeaderDiscount(lines, typed);
    assert.equal(sum(r.lines, "lineTotal"), round2(total - r.applied), JSON.stringify({ typed, lines }));
    assert.equal(r.applied, typed);
    for (const l of r.lines) {
      assert.ok(l.taxableAmount >= 0 && l.vatAmount >= 0, "no negative line");
      assert.equal(round2(l.taxableAmount + l.vatAmount), l.lineTotal, "every line adds up");
    }
  }
});

test("a discount larger than the lines cost is held to what they cost", () => {
  const r = spreadHeaderDiscount([line(1, 100, 5)], 500);
  assert.equal(r.applied, 105);
  assert.equal(r.lines[0].lineTotal, 0);
});

test("nothing to spread leaves the lines exactly as they were", () => {
  const lines = [line(1, 100, 5)];
  assert.equal(spreadHeaderDiscount(lines, 0).lines, lines);
  assert.equal(spreadHeaderDiscount(lines, -5).applied, 0);
  assert.equal(spreadHeaderDiscount([], 10).applied, 0);
  assert.equal(spreadHeaderDiscount([line(0, 100)], 10).applied, 0, "a line that costs nothing takes none");
});

test("a line that already has a discount keeps it and adds the share", () => {
  const l = line(10, 100, 5, { discountPercent: 10 }); // 1000 less 100 = 900 taxable, 45 tax
  assert.deepEqual([l.taxableAmount, l.vatAmount, l.discountAmount], [900, 45, 100]);
  const r = spreadHeaderDiscount([l], 94.5);
  assert.deepEqual([r.lines[0].taxableAmount, r.lines[0].vatAmount, r.lines[0].discountAmount], [810, 40.5, 190]);
});

test("a reverse-charge line (no tax charged) takes its share off the value and its assessed tax follows", () => {
  const l = { qty: 1, taxableAmount: 1000, vatAmount: 0, discountAmount: 0, lineTotal: 1000, grandTotal: 1000, rate: 1000, rcmVat: 50, vatPercent: 5 };
  const r = spreadHeaderDiscount([l], 100);
  assert.deepEqual([r.lines[0].taxableAmount, r.lines[0].vatAmount, r.lines[0].rcmVat], [900, 0, 45]);
});

test("the original lines are not changed", () => {
  const l = line(10, 100);
  const copy = { ...l };
  spreadHeaderDiscount([l], 50);
  assert.deepEqual(l, copy);
});
