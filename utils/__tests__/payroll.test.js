const test = require("node:test");
const assert = require("node:assert/strict");
const {
  periodDays, prorationFactor, grossPay, componentAmount, payslipFor, assessPayroll, validateComponent,
} = require("../payroll");

// ---- the period -----------------------------------------------------------------------------

test("a period's days, including a leap February", () => {
  assert.deepEqual(periodDays("2026-11"), { firstDay: "2026-11-01", lastDay: "2026-11-30", totalDays: 30 });
  assert.deepEqual(periodDays("2024-02"), { firstDay: "2024-02-01", lastDay: "2024-02-29", totalDays: 29 });
  assert.equal(periodDays("nonsense"), null);
  assert.equal(periodDays("2026-13"), null);
});

test("proration is 1 for the whole period worked, less for a joiner or a leaver, null for neither", () => {
  assert.equal(prorationFactor({ period: "2026-11", joiningDay: "2020-01-01" }), 1);
  assert.equal(prorationFactor({ period: "2026-11", joiningDay: "2026-11-16" }), 0.5, "15 of 30 days");
  assert.equal(prorationFactor({ period: "2026-11", exitDay: "2026-11-15" }), 0.5, "15 of 30 days");
  assert.equal(prorationFactor({ period: "2026-11", joiningDay: "2026-12-01" }), null, "joined after the period ended");
  assert.equal(prorationFactor({ period: "2026-11", exitDay: "2026-10-15" }), null, "left before the period began");
});

// ---- gross pay --------------------------------------------------------------------------------

test("gross pay is basic plus allowances - and NEVER otherMonthlyCost, which is a costing input, not cash paid", () => {
  assert.equal(grossPay({ basicPay: 4000, allowances: 1000, otherMonthlyCost: 9999 }), 5000);
  assert.equal(grossPay({ basicPay: 4000 }), 4000, "allowances default to nothing, not null");
  assert.equal(grossPay(null), null);
  assert.equal(grossPay({ allowances: 500 }), null, "no basic pay at all means nothing to pay");
});

// ---- one component -------------------------------------------------------------------------

test("fixed, percentOfBasic and percentOfGross each compute off the right base", () => {
  assert.equal(componentAmount({ computation: "fixed", rate: 200 }, {}), 200);
  assert.equal(componentAmount({ computation: "percentOfBasic", rate: 12 }, { basicPay: 10000, grossPay: 15000 }), 1200);
  assert.equal(componentAmount({ computation: "percentOfGross", rate: 5 }, { basicPay: 10000, grossPay: 15000 }), 750);
});

test("a statutory override's rate wins over the component's own stored default", () => {
  const c = { computation: "percentOfBasic", rate: 12, override: { rate: 10 } };
  assert.equal(componentAmount(c, { basicPay: 10000 }), 1000, "10%, not the stored 12%");
});

test("capBase caps the BASE before the percentage - a PF-shaped wage ceiling", () => {
  // 12% of min(20000, 15000) = 1800, not 12% of the real 20000 basic (2400)
  assert.equal(componentAmount({ computation: "percentOfBasic", rate: 12, capBase: 15000 }, { basicPay: 20000 }), 1800);
});

test("eligibleUpTo is a CLIFF, not a taper - an ESI-shaped eligibility ceiling", () => {
  const esi = { computation: "percentOfGross", rate: 0.75, eligibleUpTo: 21000 };
  assert.equal(componentAmount(esi, { grossPay: 20000 }), 150, "0.75% of 20,000");
  assert.equal(componentAmount(esi, { grossPay: 21001 }), null, "one rupee over the ceiling and it does not apply AT ALL, not a smaller figure");
});

test("an unreadable computation or a missing rate gives null, never a silent zero", () => {
  assert.equal(componentAmount({ computation: "percentOfBasic" }, { basicPay: 10000 }), null, "no rate at all");
  assert.equal(componentAmount({ computation: "invented" }, { basicPay: 10000 }), null);
});

// ---- a full payslip -------------------------------------------------------------------------

const PF = { kind: "deduction", computation: "percentOfBasic", rate: 12, capBase: 15000, name: "PF" };
const ESI = { kind: "deduction", computation: "percentOfGross", rate: 0.75, eligibleUpTo: 21000, name: "ESI" };
const OVERTIME = { kind: "earning", computation: "fixed", rate: 300, name: "Overtime" };

test("a payslip adds earnings, subtracts deductions, and nets correctly", () => {
  const slip = payslipFor({ contract: { basicPay: 10000, allowances: 2000 }, components: [PF, ESI, OVERTIME] });
  assert.equal(slip.grossPay, 12000);
  assert.deepEqual(slip.earnings, [{ componentId: null, name: "Overtime", amount: 300 }]);
  assert.deepEqual(slip.deductions, [
    { componentId: null, name: "PF", amount: 1200 },
    { componentId: null, name: "ESI", amount: 90 },
  ]);
  assert.equal(slip.totalEarnings, 12300, "gross plus overtime");
  assert.equal(slip.totalDeductions, 1290);
  assert.equal(slip.netPay, 11010);
});

test("ESI genuinely applies under its own ceiling, ruled out only above it", () => {
  const slip = payslipFor({ contract: { basicPay: 10000, allowances: 2000 }, components: [ESI] });
  assert.deepEqual(slip.deductions, [{ componentId: null, name: "ESI", amount: 90 }], "0.75% of the 12,000 gross");
  const tooHigh = payslipFor({ contract: { basicPay: 20000, allowances: 5000 }, components: [ESI] });
  assert.deepEqual(tooHigh.deductions, [], "25,000 gross is over the 21,000 ceiling - ESI drops out entirely");
});

test("an inactive component is skipped, and a null-amount component never appears on the slip", () => {
  const slip = payslipFor({ contract: { basicPay: 10000 }, components: [{ ...PF, isActive: false }] });
  assert.deepEqual(slip.deductions, []);
});

test("no contract at all means no slip - never a slip paid at zero", () => {
  assert.equal(payslipFor({ contract: null, components: [] }), null);
});

test("proration scales both basic and gross before any component is applied", () => {
  const slip = payslipFor({ contract: { basicPay: 10000, allowances: 2000 }, components: [PF], factor: 0.5 });
  assert.equal(slip.basicPay, 5000);
  assert.equal(slip.grossPay, 6000);
  assert.equal(slip.deductions[0].amount, 600, "12% of the PRORATED 5,000 basic, not the full 10,000");
});

test("each of a component's three figures can independently read its own statutory key", () => {
  const rulesByKey = new Map([
    ["in.pf.employeeRate", 10],
    ["in.pf.wageCeiling", 18000],
  ]);
  const slip = payslipFor({
    contract: { basicPay: 20000 },
    components: [{ ...PF, statutoryKey: "in.pf.employeeRate", capBaseKey: "in.pf.wageCeiling" }],
    rulesByKey,
  });
  assert.equal(slip.deductions[0].amount, 1800, "10% of min(20000, 18000) = 1800, from the two overrides, not the stored 12%/15000");
});

test("a key with nothing in force leaves the component's own stored figure untouched", () => {
  const slip = payslipFor({
    contract: { basicPay: 20000 },
    components: [{ ...PF, statutoryKey: "in.pf.employeeRate" }], // no row for this key in rulesByKey
    rulesByKey: new Map(),
  });
  assert.equal(slip.deductions[0].amount, 1800, "12% of min(20000, 15000) = 1800, the component's own stored rate and cap");
});

// ---- the run's own exceptions -----------------------------------------------------------------

test("a period already posted is the one blocker nothing else is even checked against", () => {
  const a = assessPayroll({ period: "2026-11", alreadyPosted: true, employees: [{ name: "X", hasContract: true, netPay: 100 }] });
  assert.equal(a.canClose, false);
  assert.deepEqual(a.blockers.map((b) => b.code), ["ALREADY_POSTED"]);
});

test("nobody to pay is a blocker on its own", () => {
  const a = assessPayroll({ period: "2026-11", employees: [] });
  assert.deepEqual(a.blockers.map((b) => b.code), ["NO_EMPLOYEES"]);
});

test("a negative net pay is a BLOCKER, never a warning somebody could tick past", () => {
  const a = assessPayroll({ period: "2026-11", employees: [{ name: "Ravi", hasContract: true, netPay: -50 }] });
  assert.equal(a.canClose, false);
  assert.ok(a.blockers.some((b) => b.code === "NEGATIVE_NET"));
});

test("no contract, a mid-period joiner and a mid-period leaver are warnings, not blockers - the run still proceeds", () => {
  const a = assessPayroll({
    period: "2026-11",
    employees: [
      { name: "Ghost", hasContract: false, netPay: null },
      { name: "NewHire", hasContract: true, joinedMidPeriod: true, netPay: 2000 },
      { name: "Leaver", hasContract: true, exitedMidPeriod: true, netPay: 1500 },
    ],
  });
  assert.equal(a.canClose, true);
  assert.deepEqual(a.warnings.map((w) => w.code).sort(), ["MID_PERIOD_EXIT", "MID_PERIOD_JOINER", "NO_CONTRACT"]);
});

// ---- validation -----------------------------------------------------------------------------

test("a component needs a name, a kind, a computation, and a rate unless it reads one from a statutory key", () => {
  assert.ok(validateComponent({}).length > 0);
  assert.deepEqual(validateComponent({ name: "PF", kind: "deduction", computation: "percentOfBasic", rate: 12 }), []);
  assert.deepEqual(validateComponent({ name: "PF", kind: "deduction", computation: "percentOfBasic", statutoryKey: "in.pf.employeeRate" }), [], "a statutory key supplies the rate at run time, so none is required here");
});
