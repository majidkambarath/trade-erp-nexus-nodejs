// Pure rules of payroll (no Mongoose, no clock): a gross figure turned into earnings and deductions, and
// the exceptions a run must show BEFORE anybody is paid - assessClose's own shape (check/finish/
// unacknowledged, reused rather than reinvented, the same way utils/periodClose.js already reuses them).
//
// THE RULE THIS WHOLE FILE RESTS ON: a SalaryComponent never hardcodes a country's tax law. PF, ESI and
// professional tax are each an INSTANCE of a generic shape (a percentage of basic or gross, optionally
// capped before the percentage applies, optionally skipped above an eligibility ceiling) with its rate
// and ceiling read from utils/compliance.js's dated StatutoryRule rows - exactly the reasoning that
// already keeps VAT and gratuity out of hardcoded constants. This file does not claim to encode Indian or
// UAE tax law; it gives the organisation the tool to configure its own deductions, correctly and dated,
// the way Accounting setup already lets a client add their own tax codes. TDS (income tax withholding) is
// NOT seeded as a starter component - its slabs, regimes, cess and surcharge are beyond what a flat-rate
// generic shape can responsibly approximate; an organisation that needs it adds its own component, or
// handles it outside the system.
const { check, finish, unacknowledged, money, plural } = require("./yearEnd");
const { isCalendarDay, diffDays } = require("./documentExpiry");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const notNegative = (v) => {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
};

const COMPUTATIONS = Object.freeze(["fixed", "percentOfBasic", "percentOfGross"]);
const KINDS = Object.freeze(["earning", "deduction"]);

// ---- the period ("YYYY-MM") ------------------------------------------------------------------------------

/** The first and last calendar day of a "YYYY-MM" period, and how many days it runs. */
function periodDays(period) {
  if (!/^\d{4}-\d{2}$/.test(String(period || ""))) return null;
  const [y, m] = period.split("-").map(Number);
  if (m < 1 || m > 12) return null;
  const firstDay = `${period}-01`;
  const lastDate = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this one
  const lastDay = lastDate.toISOString().slice(0, 10);
  return { firstDay, lastDay, totalDays: lastDate.getUTCDate() };
}

/**
 * The fraction of a period actually worked, for an employee who joined or left mid-period. 1 when the
 * whole period is worked (the ordinary case, so nothing changes for anyone who neither joined nor left
 * inside it). Null when the period itself cannot be read, or the employee was not with the organisation
 * for any of it at all (joined after it ended, or left before it began) - never 0 presented as a figure
 * that was computed, because "not employed that period" is a different fact from "worked no days of it".
 */
function prorationFactor({ period, joiningDay, exitDay }) {
  const p = periodDays(period);
  if (!p) return null;
  const from = isCalendarDay(joiningDay) && joiningDay > p.firstDay ? joiningDay : p.firstDay;
  const to = isCalendarDay(exitDay) && exitDay < p.lastDay ? exitDay : p.lastDay;
  if (to < from) return null; // joined after the period ended, or left before it began
  const worked = diffDays(from, to) + 1;
  return worked >= p.totalDays ? 1 : round2(worked / p.totalDays);
}

// ---- gross pay --------------------------------------------------------------------------------------------

/**
 * What an employee is actually PAID in cash - basic pay plus allowances. Deliberately NOT the same figure
 * as utils/hr.js monthlyCost: that one also adds `otherMonthlyCost` (insurance, visa cost, anything the
 * employer carries that never reaches the employee's bank account) because it exists to COST a product's
 * labour, not to pay anybody. Payroll pays only what is actually due to the person.
 */
function grossPay(contract) {
  if (!contract || typeof contract !== "object") return null;
  const basic = notNegative(contract.basicPay);
  const allowances = notNegative(contract.allowances) || 0;
  if (basic === null) return null;
  return round2(basic + allowances);
}

// ---- one salary component, for one employee ---------------------------------------------------------------

/**
 * What one component comes to for one employee. `override` is the dated StatutoryRule figure for this
 * component's key, if it names one (`{rate, capBase, eligibleUpTo}`, each optional) - a rule's own value
 * always wins over the component's stored default, which is the point of naming a statutory key at all:
 * a client corrects the FIGURE in Setup without touching the component.
 *
 * Returns null when the component is skipped for this employee (above its eligibility ceiling), never 0
 * presented as a computed amount - ESI's actual behaviour is a cliff, not a taper, and a payslip reading
 * "ESI: 0.00" for somebody who earns too much to qualify is a different claim from "ESI does not apply".
 */
function componentAmount(component, { basicPay, grossPay: gross } = {}) {
  const c = component || {};
  if (!COMPUTATIONS.includes(c.computation)) return null;
  const rate = num(c.override?.rate ?? c.rate);
  if (rate === null) return null;

  if (c.computation === "fixed") return round2(rate);

  const base = c.computation === "percentOfBasic" ? notNegative(basicPay) : notNegative(gross);
  if (base === null) return null;

  const eligibleUpTo = num(c.override?.eligibleUpTo ?? c.eligibleUpTo);
  if (eligibleUpTo !== null && base > eligibleUpTo) return null; // above the cliff - the component does not apply at all

  const capBase = num(c.override?.capBase ?? c.capBase);
  const appliedBase = capBase !== null ? Math.min(base, capBase) : base;
  return round2((appliedBase * rate) / 100);
}

/**
 * A full payslip breakdown for one employee: gross (prorated if they joined or left mid-period), every
 * active component applied, and the net. `components` is the organisation's own list (already filtered to
 * this country and `isActive`); `rulesByKey` is a plain Map of StatutoryRule key -> number (utils/
 * compliance.js ruleOn, read once for the whole run, not once per employee) - each of a component's three
 * figures (rate, capBase, eligibleUpTo) can independently name its own key, so the override object is
 * assembled HERE from up to three separate lookups rather than one combined row.
 *
 * Returns null when there is no basic pay to start from at all (no contract) - the caller turns that into
 * the NO_CONTRACT warning, it is never silently paid as zero.
 */
function payslipFor({ contract, components = [], rulesByKey, factor = 1 }) {
  const gross = grossPay(contract);
  if (gross === null) return null;
  const f = num(factor);
  const proratedGross = round2(gross * (f !== null && f >= 0 && f <= 1 ? f : 1));
  const basicPay = round2(notNegative(contract.basicPay) * (f !== null && f >= 0 && f <= 1 ? f : 1));

  const lookup = (key) => (key && rulesByKey?.get ? rulesByKey.get(key) : undefined);
  const earnings = [];
  const deductions = [];
  for (const c of components) {
    if (c.isActive === false) continue;
    const override = { rate: lookup(c.statutoryKey), capBase: lookup(c.capBaseKey), eligibleUpTo: lookup(c.eligibleUpToKey) };
    const amount = componentAmount({ ...c, override }, { basicPay, grossPay: proratedGross });
    if (amount === null || amount === 0) continue;
    const row = { componentId: c._id ? String(c._id) : null, name: c.name, amount };
    (c.kind === "deduction" ? deductions : earnings).push(row);
  }

  const totalEarnings = round2(proratedGross + earnings.reduce((t, e) => t + e.amount, 0));
  const totalDeductions = round2(deductions.reduce((t, d) => t + d.amount, 0));
  return {
    basicPay, grossPay: proratedGross, earnings, deductions,
    totalEarnings, totalDeductions,
    netPay: round2(totalEarnings - totalDeductions),
  };
}

// ---- the run's own exceptions, shown before anybody is paid (assessClose's shape) --------------------------

/**
 * BLOCKERS stop the run outright; WARNINGS the person ticks by name (`acknowledge`, the same contract
 * assessClose already uses). `facts`:
 *   period, alreadyPosted (bool), employees [{ name, hasContract, joinedMidPeriod, exitedMidPeriod, netPay }]
 */
function assessPayroll(facts) {
  const f = facts || {};
  const checks = [];

  if (f.alreadyPosted) {
    return finish([check("ALREADY_POSTED", "blocker", `${f.period} has already been paid`, "Reverse that run first if it was wrong, then post again.")]);
  }

  const employees = Array.isArray(f.employees) ? f.employees : [];
  if (!employees.length) {
    checks.push(check("NO_EMPLOYEES", "blocker", "There is nobody to pay this period", "Add an employee with a contract, or check the branch you are working in."));
    return finish(checks);
  }

  const negative = employees.filter((e) => e.hasContract && num(e.netPay) !== null && e.netPay < 0);
  if (negative.length) {
    checks.push(check(
      "NEGATIVE_NET", "blocker",
      `${plural(negative.length, "person would", "people would")} be paid a negative amount`,
      negative.map((e) => `${e.name}: ${money(e.netPay)}`).join("; "),
      { names: negative.map((e) => e.name) }
    ));
  } else {
    checks.push(check("NET_POSITIVE", "ok", "Nobody is paid a negative amount"));
  }

  const noContract = employees.filter((e) => !e.hasContract);
  if (noContract.length) {
    checks.push(check(
      "NO_CONTRACT", "warning",
      `${plural(noContract.length, "person has", "people have")} no contract on file`,
      `${noContract.map((e) => e.name).join(", ")} will not be paid this run.`,
      { names: noContract.map((e) => e.name) }
    ));
  }

  const joiners = employees.filter((e) => e.joinedMidPeriod);
  if (joiners.length) {
    checks.push(check(
      "MID_PERIOD_JOINER", "warning",
      `${plural(joiners.length, "person joined", "people joined")} during ${f.period}`,
      `${joiners.map((e) => e.name).join(", ")} ${joiners.length === 1 ? "is" : "are"} paid for the days actually worked, not the whole period.`,
      { names: joiners.map((e) => e.name) }
    ));
  }

  const leavers = employees.filter((e) => e.exitedMidPeriod);
  if (leavers.length) {
    checks.push(check(
      "MID_PERIOD_EXIT", "warning",
      `${plural(leavers.length, "person left", "people left")} during ${f.period}`,
      `${leavers.map((e) => e.name).join(", ")} ${leavers.length === 1 ? "is" : "are"} paid only for the days actually worked.`,
      { names: leavers.map((e) => e.name) }
    ));
  }

  return finish(checks);
}

// ---- validation ---------------------------------------------------------------------------------------------

function validateComponent(data) {
  const errors = [];
  const add = (code, message, field) => errors.push({ code, message, field });
  const d = data && typeof data === "object" ? data : {};
  if (!String(d.name || "").trim()) add("NAME_REQUIRED", "Name the component", "name");
  if (!KINDS.includes(d.kind)) add("INVALID_KIND", "Choose earning or deduction", "kind");
  if (!COMPUTATIONS.includes(d.computation)) add("INVALID_COMPUTATION", "Choose how it is computed", "computation");
  if (!d.statutoryKey) {
    const r = num(d.rate);
    if (r === null || r < 0) add("INVALID_RATE", "Enter the rate or amount", "rate");
  }
  return errors;
}

module.exports = {
  COMPUTATIONS, KINDS,
  periodDays, prorationFactor,
  grossPay, componentAmount, payslipFor,
  assessPayroll, unacknowledged,
  validateComponent,
};
