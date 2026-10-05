// Pure foreign-currency rules: exact AED conversion, rate checks, splitting a foreign amount over
// ledger legs, and Dubai calendar days. No database.
const test = require("node:test");
const assert = require("node:assert/strict");
const { convertToBase, decimalPlaces, deviationPercent, splitForeign, dubaiDay, dubaiDayStart, dubaiDayEnd, isCalendarDay, displayDay } = require("../fx");

test("convertToBase is exact and rounds half up to the cent", () => {
  assert.equal(convertToBase(1000, 3.6725), 3672.5);
  assert.equal(convertToBase(1000.5, 3.6725), 3674.34, "3674.33625");
  assert.equal(convertToBase(0.01, 3.6725), 0.04, "0.036725");
  assert.equal(convertToBase(0.1 + 0.2, 10), 3, "float noise in the input cannot move a cent");
  assert.equal(convertToBase(10.5, 11.95, { decimals: 3 }), 125.48, "125.475 is a half: up");
  assert.equal(convertToBase(100, 0.000001), 0);
  assert.equal(convertToBase(5000, 1.234567), 6172.84, "six-decimal rates");
  assert.equal(convertToBase(123456789.12, 3.6725), 453395058.04, "large amounts stay exact");
  assert.equal(convertToBase(100, 0.004, { decimals: 0 }), 0.4);
});

test("decimalPlaces reads how a number is written", () => {
  assert.equal(decimalPlaces(3.6725), 4);
  assert.equal(decimalPlaces(100), 0);
  assert.equal(decimalPlaces(1e-7), 7);
  assert.equal(decimalPlaces(1.5e-7), 8);
  assert.equal(decimalPlaces(2.5e3), 0);
  assert.ok(Number.isNaN(decimalPlaces("x")));
  assert.ok(Number.isNaN(decimalPlaces(Infinity)));
});

test("deviationPercent is measured against the master rate", () => {
  assert.equal(Math.round(deviationPercent(3.9, 3.6725) * 100) / 100, 6.19);
  assert.equal(deviationPercent(3.6725, 3.6725), 0);
  assert.equal(deviationPercent(3.5, 4), 12.5);
  assert.equal(deviationPercent(1, 0), 0, "no master rate, nothing to compare");
});

test("splitForeign shares a foreign amount over legs and always adds back", () => {
  assert.deepEqual(splitForeign(200, [716.14, 18.36]), [195, 5]);
  assert.deepEqual(splitForeign(100, [100]), [100]);
  const thirds = splitForeign(100, [1, 1, 1]);
  assert.equal(Math.round(thirds.reduce((t, x) => t + x, 0) * 100), 10000);
  const kwd = splitForeign(10.5, [60, 40], { decimals: 3 });
  assert.deepEqual(kwd, [6.3, 4.2]);
  assert.deepEqual(splitForeign(50, []), []);
});

test("Dubai calendar days", () => {
  assert.equal(dubaiDay(new Date("2026-10-03T19:59:00Z")), "2026-10-03", "23:59 Dubai");
  assert.equal(dubaiDay(new Date("2026-10-03T20:00:00Z")), "2026-10-04", "midnight Dubai");
  assert.equal(dubaiDay("2026-10-04"), "2026-10-04", "a plain day is that day");
  assert.equal(dubaiDay(new Date("2026-12-31T21:30:00Z")), "2027-01-01", "across New Year");
  assert.equal(dubaiDay("garbage"), null);
  assert.equal(dubaiDayStart("2026-10-04").toISOString(), "2026-10-03T20:00:00.000Z");
  assert.equal(dubaiDayEnd("2026-10-04").toISOString(), "2026-10-04T20:00:00.000Z");
  assert.equal(isCalendarDay("2026-02-29"), false);
  assert.equal(isCalendarDay("2028-02-29"), true);
  assert.equal(isCalendarDay("26-10-04"), false);
  assert.equal(displayDay("2026-10-04"), "04/10/2026");
});
