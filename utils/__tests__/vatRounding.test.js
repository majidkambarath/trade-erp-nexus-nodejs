const test = require("node:test");
const assert = require("node:assert/strict");
const { roundVatByRate } = require("../vatRounding");

const line = (net, vat, extra = {}) => ({ taxableAmount: net, vatAmount: vat, lineTotal: net + vat, vatPercent: 5, taxKind: "standard", ...extra });
const sum = (rows, k) => Math.round(rows.reduce((t, r) => t + r[k], 0) * 100) / 100;

test("three lines of 0.10 at 5% carry 0.02 VAT as a group, not 0.03", () => {
  const r = roundVatByRate([line(0.1, 0.01), line(0.1, 0.01), line(0.1, 0.01)]);
  assert.equal(sum(r.lines, "vatAmount"), 0.02);
  assert.equal(r.changed, true);
  assert.equal(sum(r.lines, "taxableAmount"), 0.3);
});

test("an already-agreeing document is returned unchanged", () => {
  const input = [line(100, 5), line(200, 10)];
  const r = roundVatByRate(input);
  assert.equal(r.changed, false);
  assert.deepEqual(r.lines, input);
});

test("applying it twice gives the same answer", () => {
  const once = roundVatByRate([line(0.1, 0.01), line(0.1, 0.01), line(0.1, 0.01)]);
  const twice = roundVatByRate(once.lines, once.charges);
  assert.deepEqual(twice.lines, once.lines);
  assert.equal(twice.changed, false);
});

test("the difference goes on the largest line and its total follows", () => {
  const r = roundVatByRate([line(0.1, 0.01), line(0.3, 0.02), line(0.1, 0.01)]);
  // group net 0.50 -> 0.025 rounds to 0.03 (half up); lines carried 0.04
  assert.equal(sum(r.lines, "vatAmount"), 0.03);
  assert.equal(r.lines[1].vatAmount, 0.01);
  assert.equal(r.lines[1].lineTotal, 0.31);
});

test("a charge counts with the lines of its rate", () => {
  const r = roundVatByRate([line(0.1, 0.01)], [{ amount: 0.1, vatPercent: 5, vatAmount: 0.01 }]);
  assert.equal(Math.round((r.lines[0].vatAmount + r.charges[0].vatAmount) * 100) / 100, 0.01);
});

test("mixed rates are grouped apart", () => {
  const r = roundVatByRate([line(0.1, 0.01), line(0.1, 0.01), line(0.1, 0.01, { vatPercent: 10 })]);
  assert.equal(sum(r.lines.slice(0, 2), "vatAmount"), 0.01);
  assert.equal(r.lines[2].vatAmount, 0.01);
});

test("reverse-charge, zero-rated and exempt rows are left alone", () => {
  const rows = [
    line(0.1, 0, { taxKind: "reverse_charge", vatPercent: 5 }),
    line(0.1, 0, { taxKind: "zero_rated", vatPercent: 0 }),
    line(0.1, 0, { taxKind: "exempt", vatPercent: 0 }),
  ];
  const r = roundVatByRate(rows);
  assert.equal(r.changed, false);
  assert.deepEqual(r.lines, rows);
});
