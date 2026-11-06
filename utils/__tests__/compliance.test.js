const test = require("node:test");
const assert = require("node:assert/strict");
const { ruleOn, rulesOn, gratuityOwed, emiratisationStatus } = require("../compliance");

// Two rules are mutation checked here, the same way utils/hr.js's three were - break the line in a scratch
// copy and the test named after it fails:
//
//   RULE A (a missing statutory figure refuses the calculation, never computes with a silent zero rate)
//   RULE B (below the minimum service, gratuity is a known zero - a CLIFF for India, a floor for the UAE -
//           never a partial, pro-rated amount)

// ---- the generic dated-rule lookup --------------------------------------------------------------------

const AE_RULES_2026 = [
  { key: "ae.gratuity.firstBandDaysPerYear", value: 21, effectiveFrom: "2022-02-02" },
  { key: "ae.gratuity.firstBandYears", value: 5, effectiveFrom: "2022-02-02" },
  { key: "ae.gratuity.secondBandDaysPerYear", value: 30, effectiveFrom: "2022-02-02" },
  { key: "ae.gratuity.capYears", value: 2, effectiveFrom: "2022-02-02" },
  { key: "ae.gratuity.minServiceDaysForEntitlement", value: 365, effectiveFrom: "2022-02-02" },
];
const IN_RULES_2026 = [
  { key: "in.gratuity.daysPerYear", value: 15, effectiveFrom: "2020-01-01" },
  { key: "in.gratuity.monthDivisor", value: 26, effectiveFrom: "2020-01-01" },
  { key: "in.gratuity.minServiceYears", value: 5, effectiveFrom: "2020-01-01" },
  { key: "in.gratuity.capAmount", value: 2000000, effectiveFrom: "2020-01-01" },
];

test("ruleOn finds the row in force on a day, the same way a cost rate does", () => {
  assert.equal(ruleOn(AE_RULES_2026, "ae.gratuity.capYears", "2026-06-15"), 2);
  assert.equal(ruleOn(AE_RULES_2026, "ae.gratuity.capYears", "2020-01-01"), null, "before any rule, nothing is in force");
});

test("rulesOn reads several keys in one pass", () => {
  const r = rulesOn(AE_RULES_2026, ["ae.gratuity.capYears", "ae.gratuity.firstBandYears"], "2026-06-15");
  assert.deepEqual(r, { "ae.gratuity.capYears": 2, "ae.gratuity.firstBandYears": 5 });
});

test("a key nobody set a row for is null, not a wrong key's value leaking in", () => {
  const r = rulesOn(AE_RULES_2026, ["ae.gratuity.capYears", "ae.gratuity.secondBandDaysPerYear"], "2020-06-01");
  assert.equal(r["ae.gratuity.capYears"], null);
});

// ---- UAE gratuity ----------------------------------------------------------------------------------------

test("UAE gratuity: 21 days a year for the first five, 30 days a year after, on basic pay only", () => {
  // six years exactly, AED 6,000 basic a month
  const owed = gratuityOwed({ serviceDays: 6 * 365, basicPay: 6000, country: "AE", day: "2026-06-15", rules: AE_RULES_2026 });
  // daily rate 200; 5 years x 21 days + 1 year x 30 days = 105 + 30 = 135 days x 200 = 27,000
  assert.equal(owed, 27000);
});

test("UAE gratuity is capped at two years' WAGE, not two years of the daily rate times 365", () => {
  // thirty years' service, a dearer package - the uncapped figure must exceed the cap for this to prove anything
  const owed = gratuityOwed({ serviceDays: 30 * 365, basicPay: 100000, country: "AE", day: "2026-06-15", rules: AE_RULES_2026 });
  const uncapped = 5 * 21 * (100000 / 30) + 25 * 30 * (100000 / 30);
  assert.ok(uncapped > 2 * 100000 * 12, "the uncapped figure really is larger, or the cap proves nothing");
  assert.equal(owed, 2 * 100000 * 12);
});

// RULE B - mutation: remove the minimum-service floor and this fails
test("RULE B: below a year of UAE service, gratuity is a known zero - never a fraction of one", () => {
  const owed = gratuityOwed({ serviceDays: 200, basicPay: 6000, country: "AE", day: "2026-06-15", rules: AE_RULES_2026 });
  assert.equal(owed, 0);
  assert.notEqual(owed, null, "entitlement is KNOWN (not yet due), which is different from a figure we cannot compute");
});

// RULE A - mutation: have ruleOn return 0 instead of null for a missing key, and this fails
test("RULE A: a statutory figure nobody has set refuses the calculation, never computes at a silent zero rate", () => {
  const incomplete = AE_RULES_2026.filter((r) => r.key !== "ae.gratuity.capYears"); // the cap rule is simply missing
  const owed = gratuityOwed({ serviceDays: 6 * 365, basicPay: 6000, country: "AE", day: "2026-06-15", rules: incomplete });
  assert.equal(owed, null, "not 27000 computed with a missing cap, and not 0 either");
});

// ---- India gratuity ---------------------------------------------------------------------------------------

test("India gratuity: 15 days of a 26-day month per completed year, after five full years", () => {
  // seven completed years, INR 20,000 basic a month
  const owed = gratuityOwed({ serviceDays: 7 * 365, basicPay: 20000, country: "IN", day: "2026-06-15", rules: IN_RULES_2026 });
  assert.equal(owed, Math.round(((7 * 15 * 20000) / 26) * 100) / 100);
  assert.equal(owed, 80769.23);
});

test("India gratuity is capped", () => {
  const owed = gratuityOwed({ serviceDays: 10 * 365, basicPay: 1000000, country: "IN", day: "2026-06-15", rules: IN_RULES_2026 });
  assert.equal(owed, 2000000);
});

// RULE B again, the other country's shape: a CLIFF, not a ramp
test("RULE B: below five years in India, nothing has accrued at all - a cliff, not a ramp", () => {
  const owed = gratuityOwed({ serviceDays: 3 * 365, basicPay: 20000, country: "IN", day: "2026-06-15", rules: IN_RULES_2026 });
  assert.equal(owed, 0);
});

test("a country with no formula, or bad input, is refused rather than guessed at", () => {
  assert.equal(gratuityOwed({ serviceDays: 2000, basicPay: 5000, country: "SA", day: "2026-06-15", rules: [] }), null);
  assert.equal(gratuityOwed({ serviceDays: null, basicPay: 5000, country: "AE", day: "2026-06-15", rules: AE_RULES_2026 }), null);
  assert.equal(gratuityOwed({ serviceDays: 2000, basicPay: null, country: "AE", day: "2026-06-15", rules: AE_RULES_2026 }), null);
  assert.equal(gratuityOwed({ serviceDays: -5, basicPay: 5000, country: "AE", day: "2026-06-15", rules: AE_RULES_2026 }), null);
});

// ---- Emiratisation ----------------------------------------------------------------------------------------

test("the Emiratisation shortfall and its monthly exposure, from the quota and the fine alone", () => {
  const s = emiratisationStatus({ headcount: 60, nationals: 2, requiredPercent: 10, finePerPosition: 9000 });
  assert.equal(s.required, 6); // ceil(60 * 0.10)
  assert.equal(s.shortfall, 4);
  assert.equal(s.compliant, false);
  assert.equal(s.monthlyExposure, 36000);
});

test("meeting or beating the quota reads as compliant, with no exposure", () => {
  const s = emiratisationStatus({ headcount: 60, nationals: 10, requiredPercent: 10, finePerPosition: 9000 });
  assert.equal(s.shortfall, 0);
  assert.equal(s.compliant, true);
  assert.equal(s.monthlyExposure, 0);
});

test("a fractional requirement rounds UP, never down - MOHRE is not owed less than it is owed", () => {
  const s = emiratisationStatus({ headcount: 25, nationals: 2, requiredPercent: 10, finePerPosition: 9000 });
  assert.equal(s.required, 3, "ceil(2.5), not floor(2.5)");
});

test("bad input is refused, not computed as a confident-looking wrong number", () => {
  assert.equal(emiratisationStatus({ headcount: -1, nationals: 2, requiredPercent: 10, finePerPosition: 9000 }), null);
  assert.equal(emiratisationStatus({ headcount: 60, nationals: 2, requiredPercent: null, finePerPosition: 9000 }), null);
});
