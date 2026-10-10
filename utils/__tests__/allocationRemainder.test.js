// Receipts and payments allocate several invoices and compare what they allocated with the voucher's total. Plain
// floating-point addition of two-decimal amounts can differ from the rounded total by dust, which used to refuse a
// fully-allocated voucher with "Allocated amount cannot exceed total amount" (found loading a year of trading: every
// receipt to the customer with the largest invoices was refused, every day, for months).
const test = require("node:test");
const assert = require("node:assert/strict");
const { remainderAfterAllocation, round2 } = require("../accounting");

// the four invoices that were refused
const INVOICES = [125056.44, 52481.89, 37187.33, 102540.53];
const floatSum = INVOICES.reduce((t, v) => t + v, 0);

test("the figures that were refused really do differ by dust in plain arithmetic", () => {
  // if this ever stops being true on some engine the helper is merely not needed; it must not start failing silently
  assert.notEqual(floatSum, 317266.19, "plain addition is not exactly the rounded total (this is the bug's cause)");
  assert.ok(floatSum - 317266.19 > 0 && floatSum - 317266.19 < 1e-6);
});

test("a voucher whose total equals its allocations to the fils has nothing left over - and is not negative", () => {
  assert.equal(remainderAfterAllocation(317266.19, floatSum), 0);
  assert.ok(!Object.is(remainderAfterAllocation(317266.19, floatSum), -0), "never negative zero");
  assert.ok(remainderAfterAllocation(317266.19, floatSum) >= 0);
});

test("money left on account is what is left, to the fils", () => {
  assert.equal(remainderAfterAllocation(1000, 750.25), 249.75);
  assert.equal(remainderAfterAllocation(0.3, 0.1 + 0.2), 0); // the classic 0.30000000000000004
  assert.equal(remainderAfterAllocation(100, 0), 100);
});

test("a real over-allocation is still refused: one fils over is negative", () => {
  assert.equal(remainderAfterAllocation(100, 100.01), -0.01);
  assert.ok(remainderAfterAllocation(317266.19, floatSum + 0.01) < 0);
  assert.ok(remainderAfterAllocation(50, 75) < 0);
});

test("it agrees with round2 and never invents a fraction of a fils", () => {
  for (const [t, a] of [[10, 3.333], [999.995, 0], [1e6, 999999.99]]) {
    const r = remainderAfterAllocation(t, a);
    assert.equal(r, round2(r));
  }
});
