const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_HOURS_PER_MONTH, HOURS_SOURCE,
  monthlyCost, hourlyCost, contractOn, rateOn,
  hoursBetween, suggestedHours,
  labourCost, labourLine, labourTotal, visibleLabour, labourMargin,
  validateContract, serviceDays,
} = require("../hr");

// The three rules named at the top of utils/hr.js are what these tests exist to hold down. Each is
// MUTATION CHECKED - break the rule in the source and the test named after it fails:
//
//   rule 1 (a missing rate is null, never 0)  -> make hourlyCost/labourCost return 0 instead of null
//   rule 2 (the rate is stamped, not recomputed) -> make labourLine look the rate up itself
//   rule 3 (elapsed time is not worked time)  -> remove the cap in suggestedHours

const RATE = { staffId: "s1", effectiveFrom: "2026-01-01", basicPay: 4000, allowances: 1000, otherMonthlyCost: 200, hoursPerMonth: 208 };

// ---- what a person costs --------------------------------------------------------------------

test("the monthly cost is the whole cost of employing somebody, not their basic pay", () => {
  assert.equal(monthlyCost(RATE), 5200);
  // allowances and the employer's own costs are part of it; leaving them out is the "wrong labour rate"
  // mistake the job-costing literature names
  assert.equal(monthlyCost({ basicPay: 4000 }), 4000);
  assert.equal(monthlyCost({ basicPay: 4000, allowances: 1000 }), 5000);
});

test("a contract that says nothing about money has no monthly cost - and that is null, not zero", () => {
  assert.equal(monthlyCost({}), null);
  assert.equal(monthlyCost(null), null);
  assert.equal(monthlyCost(undefined), null);
  assert.equal(monthlyCost("nonsense"), null);
});

test("an hourly cost stated outright wins over one worked out from the package", () => {
  assert.equal(hourlyCost({ ...RATE, costPerHour: 40 }), 40);
  // somebody chose 40; the package would have said 25
  assert.equal(hourlyCost(RATE), 25);
});

test("an hourly cost is the package spread over the contracted hours, with the usual divisor as a default", () => {
  assert.equal(hourlyCost({ basicPay: 5200, hoursPerMonth: 208 }), 25);
  assert.equal(hourlyCost({ basicPay: 5200 }), Math.round((5200 / DEFAULT_HOURS_PER_MONTH) * 1000) / 1000);
  // a shorter month means a dearer hour
  assert.equal(hourlyCost({ basicPay: 5200, hoursPerMonth: 104 }), 50);
});

// rule 1 - mutation: return 0 instead of null and this fails
test("RULE 1: a person we cannot cost has a null rate, never a zero rate", () => {
  assert.equal(hourlyCost({}), null);
  assert.equal(hourlyCost(null), null);
  assert.equal(hourlyCost({ basicPay: 0 }), null);
  assert.equal(hourlyCost({ basicPay: 5200, hoursPerMonth: 0 }), DEFAULT_HOURS_PER_MONTH ? 25 : null);
  // the distinction that matters: costing an uncontracted person's work at nothing would understate the
  // product's cost and overstate its margin, and nobody would ever see it happen
  assert.notEqual(hourlyCost({}), 0);
});

// ---- the contract in force ------------------------------------------------------------------

const HISTORY = [
  { effectiveFrom: "2025-01-01", effectiveTo: "2025-12-31", costPerHour: 20 },
  { effectiveFrom: "2026-01-01", costPerHour: 25 }, // current
];

test("the contract in force on a day is the one whose period covers it", () => {
  assert.equal(contractOn(HISTORY, "2025-06-15").costPerHour, 20);
  assert.equal(contractOn(HISTORY, "2026-06-15").costPerHour, 25);
  // the last day of a closed contract is still covered by it
  assert.equal(contractOn(HISTORY, "2025-12-31").costPerHour, 20);
  assert.equal(contractOn(HISTORY, "2026-01-01").costPerHour, 25);
});

test("an empty last day means the contract is still current", () => {
  assert.equal(contractOn([{ effectiveFrom: "2026-01-01", effectiveTo: null, costPerHour: 25 }], "2030-01-01").costPerHour, 25);
  assert.equal(contractOn([{ effectiveFrom: "2026-01-01", effectiveTo: "", costPerHour: 25 }], "2030-01-01").costPerHour, 25);
});

test("before the first contract, and on junk, there is nothing in force", () => {
  assert.equal(contractOn(HISTORY, "2024-12-31"), null);
  assert.equal(contractOn(HISTORY, "not-a-day"), null);
  assert.equal(contractOn([], "2026-06-15"), null);
  assert.equal(contractOn(null, "2026-06-15"), null);
  assert.equal(contractOn([{ effectiveFrom: "nonsense", costPerHour: 9 }], "2026-06-15"), null);
});

test("overlapping contracts are bad data, not a crash: the newest decision applies", () => {
  const overlap = [
    { effectiveFrom: "2026-01-01", costPerHour: 25 },
    { effectiveFrom: "2026-03-01", costPerHour: 30 },
  ];
  assert.equal(contractOn(overlap, "2026-06-15").costPerHour, 30);
  assert.equal(contractOn(overlap, "2026-02-01").costPerHour, 25);
});

// rule 2 - mutation: have labourLine resolve the rate itself and this fails
test("RULE 2: a later wage rise does not move what an earlier day's work cost", () => {
  const beforeRaise = rateOn(HISTORY, "2025-06-15");
  assert.equal(beforeRaise, 20);

  // February's work, stamped at February's rate
  const line = labourLine({ staffId: "s1", staffName: "Ravi", hours: 3, rate: beforeRaise, day: "2025-06-15" });
  assert.equal(line.rate, 20);
  assert.equal(line.amount, 60);

  // the raise arrives, and history does not move: neither the rate in force then, nor the stamped line
  const afterRaise = [...HISTORY, { effectiveFrom: "2026-07-01", costPerHour: 40 }];
  assert.equal(rateOn(afterRaise, "2025-06-15"), 20, "the rate in force on a past day is still the past rate");
  assert.equal(line.rate, 20, "a stamped line keeps its own rate");
  assert.equal(line.amount, 60, "so the cost of a posted order can never be rewritten by a pay rise");
  assert.equal(rateOn(afterRaise, "2026-08-01"), 40, "while today's work costs today's rate");
});

// ---- how long the work took -----------------------------------------------------------------

test("hours are the span between two instants", () => {
  assert.equal(hoursBetween("2026-03-02T08:00:00Z", "2026-03-02T11:30:00Z"), 3.5);
  assert.equal(hoursBetween(new Date("2026-03-02T08:00:00Z"), new Date("2026-03-02T09:00:00Z")), 1);
});

test("a span that is missing, unreadable or backwards gives no hours at all", () => {
  assert.equal(hoursBetween(null, "2026-03-02T11:00:00Z"), null);
  assert.equal(hoursBetween("2026-03-02T08:00:00Z", null), null);
  assert.equal(hoursBetween("rubbish", "2026-03-02T11:00:00Z"), null);
  // a clock out of step must not credit the order with a negative cost
  assert.equal(hoursBetween("2026-03-02T11:00:00Z", "2026-03-02T08:00:00Z"), null);
});

// rule 3 - mutation: remove the cap and this fails
test("RULE 3: a step left open over a weekend offers a working day, not 65 hours", () => {
  // started 16:00 Friday, finished 09:00 Monday - open for 65 hours, worked perhaps three
  const weekend = suggestedHours({ startedAt: "2026-03-06T16:00:00Z", doneAt: "2026-03-09T09:00:00Z" });
  assert.equal(weekend.elapsedHours, 65);
  assert.equal(weekend.hours, 8, "the offer is one working day, not the elapsed span");
  assert.equal(weekend.capped, true);
  assert.equal(weekend.spansDays, true);
  assert.equal(weekend.confident, false, "so the screen knows to ask somebody to confirm it");
});

test("a step that fits inside a working day is offered as it stands, and is trusted", () => {
  const sameDay = suggestedHours({ startedAt: "2026-03-02T08:00:00Z", doneAt: "2026-03-02T11:30:00Z" });
  assert.equal(sameDay.hours, 3.5);
  assert.equal(sameDay.elapsedHours, 3.5);
  assert.equal(sameDay.capped, false);
  assert.equal(sameDay.spansDays, false);
  assert.equal(sameDay.confident, true);
});

test("an organisation on a longer shift says so, and the cap follows it", () => {
  const twelve = suggestedHours({ startedAt: "2026-03-02T06:00:00Z", doneAt: "2026-03-02T20:00:00Z" }, { hoursPerDay: 12 });
  assert.equal(twelve.elapsedHours, 14);
  assert.equal(twelve.hours, 12);
  assert.equal(twelve.capped, true);
  assert.equal(twelve.spansDays, false, "14 hours is a long shift, not several days");
});

test("a step never started, or still running, offers nothing", () => {
  assert.equal(suggestedHours({}).hours, null);
  assert.equal(suggestedHours({ startedAt: "2026-03-02T08:00:00Z" }).hours, null);
  assert.equal(suggestedHours({ startedAt: "2026-03-02T08:00:00Z" }).confident, false);
});

// ---- what the work cost ---------------------------------------------------------------------

test("labour cost is hours times rate, to the fils", () => {
  assert.equal(labourCost(3.5, 25), 87.5);
  assert.equal(labourCost(1, 33.333), 33.33);
  assert.equal(labourCost(0, 25), 0, "no hours worked really is nothing, and that is a known zero");
});

test("labour cost is null when either side is unknown", () => {
  assert.equal(labourCost(null, 25), null);
  assert.equal(labourCost(3.5, null), null);
  assert.equal(labourCost(-1, 25), null);
});

test("a line that cannot be costed is refused, so no zero-value labour line can be written", () => {
  assert.equal(labourLine({ staffId: "s1", hours: 3, rate: null }), null);
  assert.equal(labourLine({ staffId: "s1", hours: null, rate: 25 }), null);
  assert.equal(labourLine({}), null);
});

test("a line carries everything needed to explain its figure years later", () => {
  const line = labourLine({
    staffId: "s1", staffName: "Ravi", hours: 3.5, rate: 25,
    source: HOURS_SOURCE.TYPED, stepId: "st1", stepName: "Powder coating", day: "2026-03-02",
  });
  assert.deepEqual(line, {
    staffId: "s1", staffName: "Ravi", hours: 3.5, rate: 25, amount: 87.5,
    source: "typed", stepId: "st1", stepName: "Powder coating", day: "2026-03-02",
  });
});

test("an unknown hours source falls back to elapsed rather than storing a word nothing understands", () => {
  assert.equal(labourLine({ hours: 1, rate: 10, source: "guesswork" }).source, HOURS_SOURCE.ELAPSED);
  assert.equal(labourLine({ hours: 1, rate: 10, day: "not-a-day" }).day, null);
});

test("a total says how much of itself has not been confirmed", () => {
  const total = labourTotal([
    labourLine({ hours: 2, rate: 25, source: HOURS_SOURCE.TYPED }),
    labourLine({ hours: 4, rate: 25, source: HOURS_SOURCE.ELAPSED }),
  ]);
  assert.equal(total.lines, 2);
  assert.equal(total.hours, 6);
  assert.equal(total.amount, 150);
  assert.equal(total.unconfirmedAmount, 100, "so a report can say 150, of which 100 from unconfirmed time");
  assert.equal(total.allConfirmed, false);
});

test("a total of confirmed lines says so, and an empty one is honest about being empty", () => {
  const confirmed = labourTotal([labourLine({ hours: 2, rate: 25, source: HOURS_SOURCE.ATTENDANCE })]);
  assert.equal(confirmed.allConfirmed, true);
  assert.equal(confirmed.unconfirmedAmount, 0);

  const none = labourTotal([]);
  assert.equal(none.lines, 0);
  assert.equal(none.amount, 0);
  assert.equal(none.allConfirmed, true);
  assert.equal(labourTotal(null).lines, 0);
  assert.equal(labourTotal([null, undefined, {}]).lines, 0);
});

// ---- who may see what a person's hour costs -------------------------------------------------

const LINES = [
  labourLine({ staffId: "s1", staffName: "Ravi", hours: 3, rate: 25, stepId: "st1", stepName: "Powder coating" }),
  labourLine({ staffId: "s2", staffName: "Anil", hours: 3, rate: 25, stepId: "st1", stepName: "Powder coating" }),
  labourLine({ staffId: "s1", staffName: "Ravi", hours: 2, rate: 25, stepId: "st2", stepName: "Packing" }),
];

test("a reader holding hr.confidential sees the labour lines as they are", () => {
  const seen = visibleLabour(LINES, { confidential: true });
  assert.equal(seen.length, 3);
  assert.equal(seen[0].staffName, "Ravi");
  assert.equal(seen[0].rate, 25);
  assert.equal(seen[0].hours, 3);
});

// the leak this closes: "Ravi, 3 hours, 75.00" on a process order is a payslip in disguise
test("a reader without hr.confidential sees the cost but cannot price a person from it", () => {
  const seen = visibleLabour(LINES, { confidential: false });
  const all = JSON.stringify(seen);
  assert.ok(!all.includes("Ravi") && !all.includes("Anil"), "nobody is named");
  for (const row of seen) {
    assert.equal(row.rate, undefined, "no rate to read");
    assert.equal(row.hours, undefined, "and no hours to divide the amount by");
    assert.equal(row.staffId, undefined);
  }
});

test("the cost is the same figure either way - only who can be identified changes", () => {
  const open = labourTotal(visibleLabour(LINES, { confidential: true })).amount;
  const closed = visibleLabour(LINES, { confidential: false }).reduce((t, r) => t + r.amount, 0);
  assert.equal(open, 200);
  assert.equal(closed, 200, "hiding who did the work must never change what the product cost");
});

test("the grouped view says how many people worked a step, which reads well and gives nothing away", () => {
  const seen = visibleLabour(LINES, { confidential: false });
  assert.equal(seen.length, 2, "one row per step, not per person");
  const coating = seen.find((r) => r.stepName === "Powder coating");
  assert.equal(coating.amount, 150);
  assert.equal(coating.people, 2);
  assert.equal(visibleLabour([], { confidential: false }).length, 0);
  assert.equal(visibleLabour(null, { confidential: false }).length, 0);
});

// ---- U2: the number a workshop lives on -----------------------------------------------------

test("labour margin is what the workshop sold the hour for, less what it cost", () => {
  const m = labourMargin({ revenue: 1200, cost: 450, hours: 18 });
  assert.equal(m.profit, 750);
  assert.equal(m.marginPct, 62.5);
  assert.equal(m.costPerHour, 25);
  assert.equal(m.revenuePerHour, 66.67, "the figure utils/garage.js already called the effective labour rate");
});

test("a margin with nothing to measure is null, never zero per cent", () => {
  assert.equal(labourMargin({ revenue: 0, cost: 0, hours: 0 }).marginPct, null);
  assert.equal(labourMargin({ revenue: 1200, cost: null }).marginPct, null, "unknown cost means unknown margin");
  assert.equal(labourMargin({}).marginPct, null);
  // a 0% margin and an unknown margin are very different things to show an owner
  assert.notEqual(labourMargin({ revenue: 1200, cost: null }).marginPct, 0);
});

test("labour can lose money, and the margin says so plainly", () => {
  const m = labourMargin({ revenue: 300, cost: 450, hours: 18 });
  assert.equal(m.profit, -150);
  assert.equal(m.marginPct, -50);
});

// ---- validation -----------------------------------------------------------------------------

const codes = (data) => validateContract(data).map((e) => e.code);

test("a contract needs an employee and a first day", () => {
  assert.deepEqual(validateContract({}).map((e) => e.field).sort(), ["effectiveFrom", "staffId"]);
  assert.ok(codes({ staffId: "s1" }).includes("INVALID_EFFECTIVE_FROM"));
  assert.deepEqual(codes({ staffId: "s1", effectiveFrom: "2026-01-01", costPerHour: 25 }), []);
});

test("a last day before the first day is refused", () => {
  assert.ok(codes({ staffId: "s1", effectiveFrom: "2026-06-01", effectiveTo: "2026-01-01" }).includes("EFFECTIVE_RANGE_BACKWARDS"));
  assert.deepEqual(codes({ staffId: "s1", effectiveFrom: "2026-01-01", effectiveTo: "", costPerHour: 25 }), []);
});

test("negative pay and typo-sized figures are refused", () => {
  assert.ok(codes({ staffId: "s1", effectiveFrom: "2026-01-01", basicPay: -1 }).includes("INVALID_AMOUNT"));
  assert.ok(codes({ staffId: "s1", effectiveFrom: "2026-01-01", costPerHour: -5 }).includes("INVALID_AMOUNT"));
  assert.ok(codes({ staffId: "s1", effectiveFrom: "2026-01-01", costPerHour: 250000 }).includes("AMOUNT_TOO_LARGE"));
  assert.ok(codes({ staffId: "s1", effectiveFrom: "2026-01-01", hoursPerMonth: 0 }).includes("INVALID_HOURS"));
  assert.ok(codes({ staffId: "s1", effectiveFrom: "2026-01-01", hoursPerMonth: 5000 }).includes("INVALID_HOURS"));
});

test("a contract that states money we cannot turn into an hourly cost is caught here, not discovered as an uncosted order", () => {
  // money, but a divisor that makes a rate impossible
  assert.ok(codes({ staffId: "s1", effectiveFrom: "2026-01-01", basicPay: 5000, hoursPerMonth: -1 }).length);
  // a record of the job alone, with no money at all, is allowed: not every employee is costed
  assert.deepEqual(codes({ staffId: "s1", effectiveFrom: "2026-01-01" }), []);
});

// ---- service length (wave 2's gratuity leans on this) ---------------------------------------

test("service days count the joining day itself", () => {
  assert.equal(serviceDays("2026-01-01", "2026-01-01"), 1);
  assert.equal(serviceDays("2026-01-01", "2026-01-31"), 31);
  assert.equal(serviceDays("2025-01-01", "2025-12-31"), 365);
});

test("service cannot run backwards, and junk gives nothing", () => {
  assert.equal(serviceDays("2026-06-01", "2026-01-01"), null);
  assert.equal(serviceDays("nonsense", "2026-01-01"), null);
  assert.equal(serviceDays("2026-01-01", null), null);
});
