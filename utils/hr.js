// Pure rules of the HR module's one job in wave 1: putting a COST on an hour of somebody's work, so the
// labour that went into a product or a job card can be costed (no Mongoose, no clock, no network - every
// "today" and every rate is passed in).
//
// WHY THIS FILE EXISTS AT ALL. Both halves of labour costing were already in the codebase and had never been
// joined:
//   - a garage task already stores `staffId`, `standardHours` and `actualHours` (models/modules/garage/jobCardModel.js)
//   - a process step already stores `assigneeId`, `startedAt` and `doneAt` (models/modules/processOrderModel.js)
//   - a process order's `costs[]` already names LABOUR as an intended line, and already flows into the
//     production's cost and from there into the item's cost through `production-absorbed`
// The only missing number was what an employee's hour costs. That is this file.
//
// THREE RULES THAT MATTER MORE THAN THE ARITHMETIC
//
// 1. A MISSING RATE IS null, NEVER ZERO. An employee with no contract cannot be costed, and costing their
//    work at nothing would quietly understate the product's cost and overstate its margin - the same trap
//    `lib/paymentStatus.js` names ("a missing outstandingAmount must not read as 0 and therefore paid").
//    Every function here returns null rather than 0 when it does not know, and the service turns that null
//    into a warning somebody has to see.
//
// 2. THE RATE IS STAMPED ON THE LINE, NEVER RECOMPUTED. `labourLine` takes the rate as an argument and keeps
//    it. A wage rise in March must not change what February's order cost: that is the same decision
//    `ProductionOrder.materials.unitCost` already made ("set when posted: the average it left at") and the
//    same reason the production recost replays at a FIXED stamped cost. Recomputing history would silently
//    rewrite the cost of stock in a closed period.
//
// 3. ELAPSED TIME IS NOT WORKED TIME. `doneAt - startedAt` on a process step is how long the step was OPEN.
//    A fabricator who starts a step at 16:00 on Friday and finishes at 09:00 on Monday leaves 65 elapsed
//    hours behind and worked perhaps three of them. So `suggestedHours` offers a figure and SAYS when it
//    cannot be trusted (`spansDays`, `capped`); it is never taken as fact. The person confirms or corrects
//    it, and the line records which it was (`HOURS_SOURCE`). Wave 3's attendance is what finally makes this
//    exact - and when it does, only the source changes, not the arithmetic.
//    A garage task needs none of this: `actualHours` is a number a service advisor typed, so it is already
//    the worked figure. That is why the workshop half of this feature is exact from the first day.

const { isCalendarDay, diffDays } = require("./documentExpiry");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

// A working day, used only to notice that an elapsed span is too long to be worked hours. 8 is the UAE's
// statutory day (Federal Decree-Law No. 33 of 2021 Art. 17: 8 hours a day, 48 a week) and a fair default
// elsewhere; an organisation that works a 9- or 12-hour shift passes its own.
const DEFAULT_HOURS_PER_DAY = 8;
// The usual divisor when a monthly package is turned into an hourly cost: 8 hours x 26 days. 26 is the
// convention Gulf and Indian payroll both use for a monthly-to-daily rate (and the 26 in India's own
// gratuity formula), not an invention here. An organisation that disagrees sets `hoursPerMonth` itself.
const DEFAULT_HOURS_PER_MONTH = 208;

// Where a line's hours came from. Stored on the line, so a report can say how much of its figure is
// confirmed and how much is still a guess from elapsed time.
const HOURS_SOURCE = Object.freeze({
  ELAPSED: "elapsed", // worked out from startedAt -> doneAt, unconfirmed
  TYPED: "typed", // a person entered or corrected it
  ATTENDANCE: "attendance", // wave 3: taken from the attendance record
});
const HOURS_SOURCES = Object.freeze(Object.values(HOURS_SOURCE));

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const positive = (v) => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
// A money or hours figure that may legitimately be zero, but never negative and never nonsense.
const notNegative = (v) => {
  const n = num(v);
  return n !== null && n >= 0 ? n : null;
};

const instantOf = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
};

// ---- what a person costs -----------------------------------------------------------------------------------

/**
 * The whole monthly cost of employing somebody, which is NOT their salary: an employer pays allowances and
 * carries insurance, the visa, and the end-of-service that accrues every month. Costing an hour at bare
 * basic pay understates every product that hour went into, which is the mistake the market's own job-costing
 * literature names ("payroll burden is often estimated inside job costing rather than pulled from real
 * payroll data - the result is job cost reports built on the wrong labour rate").
 *
 * Returns null when there is nothing to add up, so "we do not know" never arrives as 0.
 */
function monthlyCost(contract) {
  if (!contract || typeof contract !== "object") return null;
  const parts = [contract.basicPay, contract.allowances, contract.otherMonthlyCost].map(notNegative);
  if (parts.every((p) => p === null)) return null;
  return round2(parts.reduce((sum, p) => sum + (p || 0), 0));
}

/**
 * What one hour of this person costs. Either the contract states it outright (some owners simply know "he
 * costs me 25 an hour") or it is the monthly cost spread over the hours the contract is for. An explicit
 * rate wins, because somebody chose it - the same precedence `utils/pricing.js` gives a typed price over a
 * derived one.
 */
function hourlyCost(contract) {
  if (!contract || typeof contract !== "object") return null;
  const stated = positive(contract.costPerHour);
  if (stated !== null) return round3(stated);
  const monthly = monthlyCost(contract);
  if (monthly === null || monthly <= 0) return null;
  const hours = positive(contract.hoursPerMonth) || DEFAULT_HOURS_PER_MONTH;
  return round3(monthly / hours);
}

/**
 * The contract in force on a day. Contracts are a HISTORY, never overwritten: a raise is a new row with its
 * own `effectiveFrom`, which is what lets a past order keep the cost it was really built at (rule 2 above)
 * and what makes "the salary disagrees with the registered contract" a checkable thing later.
 *
 * `effectiveTo` empty means "still current". Overlapping rows are bad data rather than a crash: the latest
 * `effectiveFrom` wins, so the newest decision is the one that applies.
 */
function contractOn(contracts, day) {
  if (!Array.isArray(contracts) || !isCalendarDay(day)) return null;
  const inForce = contracts.filter((c) => {
    if (!c || !isCalendarDay(c.effectiveFrom)) return false;
    if (c.effectiveFrom > day) return false;
    if (c.effectiveTo === null || c.effectiveTo === undefined || c.effectiveTo === "") return true;
    return isCalendarDay(c.effectiveTo) ? c.effectiveTo >= day : false;
  });
  if (!inForce.length) return null;
  return inForce.reduce((best, c) => (c.effectiveFrom > best.effectiveFrom ? c : best));
}

/** The hourly cost in force on a day, or null when the person has no contract covering it. */
function rateOn(contracts, day) {
  return hourlyCost(contractOn(contracts, day));
}

// ---- how long the work took --------------------------------------------------------------------------------

/** Hours from one instant to another, or null if either is missing, unreadable, or the pair runs backwards. */
function hoursBetween(from, to) {
  const a = instantOf(from);
  const b = instantOf(to);
  if (a === null || b === null) return null;
  // Backwards means a clock out of step or a corrected record, not negative work. Refuse it rather than
  // credit the order with a negative cost.
  if (b < a) return null;
  return round2((b - a) / 3600000);
}

/**
 * The hours to OFFER for a process step, with the honesty that makes the offer usable (rule 3 above).
 *
 *   { hours, elapsedHours, source, spansDays, capped, confident }
 *
 * `hours` is capped at one working day because an open step spanning a weekend is the common case, not the
 * exception, and a 65-hour labour line on a two-hour job is the kind of number that makes somebody stop
 * trusting the whole report. `confident` is true only for a span that fits inside a single working day; the
 * screen asks the person to confirm anything else, and `capped`/`spansDays` tell it why.
 */
function suggestedHours(step, { hoursPerDay = DEFAULT_HOURS_PER_DAY } = {}) {
  const limit = positive(hoursPerDay) || DEFAULT_HOURS_PER_DAY;
  const elapsed = hoursBetween(step?.startedAt, step?.doneAt);
  if (elapsed === null) {
    return { hours: null, elapsedHours: null, source: HOURS_SOURCE.ELAPSED, spansDays: false, capped: false, confident: false };
  }
  const capped = elapsed > limit;
  return {
    hours: capped ? round2(limit) : elapsed,
    elapsedHours: elapsed,
    source: HOURS_SOURCE.ELAPSED,
    spansDays: elapsed > 24,
    capped,
    confident: !capped,
  };
}

// ---- what the work cost ------------------------------------------------------------------------------------

/** Hours x rate, to the fils. Null if either side is unknown - never 0 (rule 1). */
function labourCost(hours, rate) {
  const h = notNegative(hours);
  const r = notNegative(rate);
  if (h === null || r === null) return null;
  return round2(h * r);
}

/**
 * A stamped labour cost line. Everything needed to explain the figure for ever is kept ON the line - who,
 * how many hours, at what rate, where the hours came from - so the line can be read back years later
 * without the contract, and so no later wage change can move it (rule 2).
 *
 * Returns null when it cannot be costed, so a caller cannot accidentally write a zero-value labour line.
 */
function labourLine({ staffId, staffName, hours, rate, source = HOURS_SOURCE.ELAPSED, stepId, stepName, day } = {}) {
  const amount = labourCost(hours, rate);
  if (amount === null) return null;
  return {
    staffId: staffId ? String(staffId) : null,
    staffName: staffName ? String(staffName).slice(0, 120) : "",
    hours: round2(hours),
    rate: round3(rate),
    amount,
    source: HOURS_SOURCES.includes(source) ? source : HOURS_SOURCE.ELAPSED,
    stepId: stepId ? String(stepId) : null,
    stepName: stepName ? String(stepName).slice(0, 80) : "",
    day: isCalendarDay(day) ? day : null,
  };
}

/**
 * What a set of labour lines comes to, and how much of it is still a guess. `unconfirmed` is the point: a
 * total nobody has checked should not be presented as if it had been, so a report can say "4,210.00, of
 * which 1,180.00 from unconfirmed elapsed time".
 */
function labourTotal(lines) {
  const rows = Array.isArray(lines) ? lines.filter((l) => l && num(l.amount) !== null) : [];
  const sum = (xs) => round2(xs.reduce((t, n) => t + n, 0));
  const amounts = rows.map((l) => num(l.amount));
  const unconfirmed = rows.filter((l) => l.source === HOURS_SOURCE.ELAPSED).map((l) => num(l.amount));
  return {
    lines: rows.length,
    hours: round2(rows.reduce((t, l) => t + (num(l.hours) || 0), 0)),
    amount: sum(amounts),
    unconfirmedAmount: sum(unconfirmed),
    allConfirmed: unconfirmed.length === 0,
  };
}

// ---- who may see what a person's hour costs ----------------------------------------------------------------

/**
 * Labour lines as a given reader may see them.
 *
 * THE HOLE THIS CLOSES. A labour cost line on a process order is a PRODUCT cost, so whoever can see what the
 * materials cost has to be able to see what the labour cost - otherwise the feature's whole point is lost.
 * But a line reading "Ravi, 3 hours, 75.00" is a payslip in disguise: anybody holding `inventory.adjust`
 * could divide and learn a colleague's wage. That is exactly the leak `hr.confidential` exists to prevent,
 * and it would have been wide open on a screen nobody thinks of as an HR screen.
 *
 * So a reader without `hr.confidential` is given the AMOUNTS, grouped by step, with nobody named and no
 * hours or rate to divide by; a reader with it is given the lines as they are. The amounts are identical
 * either way - what changes is whether a person can be costed from them.
 */
function visibleLabour(lines, { confidential = false } = {}) {
  const rows = Array.isArray(lines) ? lines.filter((l) => l && num(l.amount) !== null) : [];
  if (confidential) return rows.map((l) => ({ ...l }));
  const byStep = new Map();
  for (const l of rows) {
    const key = l.stepId ? String(l.stepId) : l.stepName || "";
    const at = byStep.get(key) || { stepId: l.stepId || null, stepName: l.stepName || "", amount: 0, people: 0 };
    at.amount = round2(at.amount + num(l.amount));
    at.people += 1;
    byStep.set(key, at);
  }
  // `people` is a count, never a name: "2 people, 150.00" says enough to read the cost and not enough to
  // price anybody. Hours and rate are gone on purpose - they are the two numbers that give a wage away.
  return [...byStep.values()];
}

// ---- U2: is the workshop making money on labour? -----------------------------------------------------------

/**
 * Labour revenue against labour cost. `utils/garage.js` has always been able to say what an hour was SOLD
 * for (`effectiveLabourRate = revenue.labour / hours.actual`); it has never known what the hour COST, so the
 * one number a workshop actually lives on - the margin on its own labour - could not be worked out at all.
 *
 * `marginPct` is null when there is nothing to measure rather than 0: "a rate with nothing to measure is
 * null, never 0" is the rule the CRM's analysis already follows, and a 0% margin and an unknown margin are
 * very different things to show an owner.
 */
function labourMargin({ revenue, cost, hours } = {}) {
  const rev = notNegative(revenue);
  const cst = notNegative(cost);
  const hrs = notNegative(hours);
  const profit = rev !== null && cst !== null ? round2(rev - cst) : null;
  return {
    revenue: rev,
    cost: cst,
    profit,
    marginPct: profit !== null && rev !== null && rev > 0 ? round2((profit / rev) * 100) : null,
    costPerHour: cst !== null && hrs !== null && hrs > 0 ? round2(cst / hrs) : null,
    revenuePerHour: rev !== null && hrs !== null && hrs > 0 ? round2(rev / hrs) : null,
  };
}

// ---- validation --------------------------------------------------------------------------------------------

const MAX_RATE = 100000; // a sanity ceiling: a typo of 250000 an hour should not reach the books
const MAX_MONTHLY = 10000000;

/**
 * Whether a contract can be saved. Returns `[{ code, message, field }]`, the shape the other pure rule
 * modules use (`utils/processOrders.js` validateOrder), so the controller can answer with the first one and
 * the form can put each on its own field.
 */
function validateContract(data) {
  const errors = [];
  const add = (code, message, field) => errors.push({ code, message, field });
  const d = data && typeof data === "object" ? data : {};

  if (!d.staffId) add("STAFF_REQUIRED", "Choose the employee this contract is for", "staffId");
  if (!isCalendarDay(d.effectiveFrom)) add("INVALID_EFFECTIVE_FROM", "Enter the day this contract starts", "effectiveFrom");
  const hasTo = !(d.effectiveTo === null || d.effectiveTo === undefined || d.effectiveTo === "");
  if (hasTo && !isCalendarDay(d.effectiveTo)) add("INVALID_EFFECTIVE_TO", "Enter a valid last day, or leave it empty while it is current", "effectiveTo");
  if (isCalendarDay(d.effectiveFrom) && hasTo && isCalendarDay(d.effectiveTo) && d.effectiveTo < d.effectiveFrom) {
    add("EFFECTIVE_RANGE_BACKWARDS", "The last day cannot be before the first day", "effectiveTo");
  }

  for (const [field, label] of [["basicPay", "Basic pay"], ["allowances", "Allowances"], ["otherMonthlyCost", "Other monthly cost"]]) {
    if (d[field] === undefined || d[field] === null || d[field] === "") continue;
    const v = num(d[field]);
    if (v === null || v < 0) add("INVALID_AMOUNT", `${label} cannot be negative`, field);
    else if (v > MAX_MONTHLY) add("AMOUNT_TOO_LARGE", `${label} looks wrong - check the figure`, field);
  }
  if (d.costPerHour !== undefined && d.costPerHour !== null && d.costPerHour !== "") {
    const v = num(d.costPerHour);
    if (v === null || v < 0) add("INVALID_AMOUNT", "Cost per hour cannot be negative", "costPerHour");
    else if (v > MAX_RATE) add("AMOUNT_TOO_LARGE", "Cost per hour looks wrong - check the figure", "costPerHour");
  }
  if (d.hoursPerMonth !== undefined && d.hoursPerMonth !== null && d.hoursPerMonth !== "") {
    const v = num(d.hoursPerMonth);
    if (v === null || v <= 0) add("INVALID_HOURS", "Hours a month must be more than nothing", "hoursPerMonth");
    else if (v > 744) add("INVALID_HOURS", "Hours a month cannot be more than the hours in a month", "hoursPerMonth");
  }

  // The whole point of the record is to be able to cost an hour. A contract that cannot is accepted only if
  // it states no money at all (a record of the job alone); one that states money we cannot turn into a rate
  // is a mistake worth catching here rather than discovering as a silently uncosted order.
  const saysMoney = ["basicPay", "allowances", "otherMonthlyCost", "costPerHour"].some(
    (f) => d[f] !== undefined && d[f] !== null && d[f] !== "" && num(d[f]) !== null && num(d[f]) > 0
  );
  if (saysMoney && !errors.length && hourlyCost(d) === null) {
    add("NO_HOURLY_COST", "This contract cannot be turned into a cost per hour - give a cost per hour, or the hours a month", "costPerHour");
  }
  return errors;
}

/** Whole days of service, inclusive of the joining day, or null. Used by the gratuity accrual in wave 2. */
function serviceDays(joiningDay, asOnDay) {
  const d = diffDays(joiningDay, asOnDay);
  return d === null || d < 0 ? null : d + 1;
}

module.exports = {
  DEFAULT_HOURS_PER_DAY,
  DEFAULT_HOURS_PER_MONTH,
  HOURS_SOURCE,
  HOURS_SOURCES,
  monthlyCost,
  hourlyCost,
  contractOn,
  rateOn,
  hoursBetween,
  suggestedHours,
  labourCost,
  labourLine,
  labourTotal,
  visibleLabour,
  labourMargin,
  validateContract,
  serviceDays,
};
