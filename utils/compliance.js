// Pure rules of the compliance pack (no Mongoose, no clock, no network): gratuity (end-of-service) and the
// Emiratisation tracker. Both read the SAME generic dated-rule lookup (`ruleOn`), because the research this
// module was built from found every number here genuinely contested:
//
//   - UAE gratuity: sources agree on 21 days/year for the first five years then 30 days/year, capped at two
//     years' wage - but several calculator sites still publish the ABOLISHED resignation reductions.
//   - India gratuity: 15 days (of a 26-day month) per completed year after five years - but the tax-free cap
//     is given as both ₹20 lakh and ₹25 lakh depending on the source.
//   - Emiratisation: the monthly fine per unfilled position is given as both AED 9,000 and AED 10,000, the
//     quota percentage and its checkpoint dates differ across guides.
//
// So NOTHING here is a constant. `ruleOn` is `utils/hr.js` `rateOn`'s own shape with a key added - the same
// "contract in force on a day" lookup, generalised from "this employee's pay" to "this country's rule" - and
// every figure below (21, 30, 2, 15, 26, 5, 9000, …) arrives as a `StatutoryRule` row an administrator can
// correct the week a number changes, never as a literal buried in a formula. The STRUCTURE of each formula
// (which band applies when, ramp vs cliff) is the law's own shape and is pure logic; the NUMBERS inside that
// shape are data.

const { isCalendarDay } = require("./documentExpiry");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ---- the generic dated-rule lookup (D10) --------------------------------------------------------------------

/**
 * The value of one statutory figure in force on a day, or null when none has been set for it.
 *
 * `rows` are `{ key, value, effectiveFrom, effectiveTo }` - the same shape and the same rule
 * `contractOn`/`rateOn` already use for a cost rate: the latest row whose `effectiveFrom` is on or before
 * `day`, among those not yet closed on `day`. Null is never 0 (the same rule 1 as `utils/hr.js`): a
 * statutory figure nobody has set is a reason to refuse the calculation, not to compute it as if it were nil.
 */
function ruleOn(rows, key, day) {
  if (!Array.isArray(rows) || !isCalendarDay(day)) return null;
  const inForce = rows.filter((r) => {
    if (!r || r.key !== key || !isCalendarDay(r.effectiveFrom)) return false;
    if (r.effectiveFrom > day) return false;
    if (r.effectiveTo === null || r.effectiveTo === undefined || r.effectiveTo === "") return true;
    return isCalendarDay(r.effectiveTo) ? r.effectiveTo >= day : false;
  });
  if (!inForce.length) return null;
  return num(inForce.reduce((best, r) => (r.effectiveFrom > best.effectiveFrom ? r : best)).value);
}

/** Every rule key a day needs, in one pass over the same rows - avoids filtering the array once per key. */
function rulesOn(rows, keys, day) {
  const out = {};
  for (const key of keys) out[key] = ruleOn(rows, key, day);
  return out;
}

// ---- gratuity (end-of-service) ------------------------------------------------------------------------------

const AE_KEYS = [
  "ae.gratuity.firstBandDaysPerYear", "ae.gratuity.firstBandYears", "ae.gratuity.secondBandDaysPerYear",
  "ae.gratuity.capYears", "ae.gratuity.minServiceDaysForEntitlement",
];
const IN_KEYS = ["in.gratuity.daysPerYear", "in.gratuity.monthDivisor", "in.gratuity.minServiceYears", "in.gratuity.capAmount"];

/**
 * What an employee's end-of-service gratuity is worth TODAY, if they left today, as an UNDISCOUNTED
 * obligation (the practical method a business this size uses - a full actuarial valuation needs an
 * actuary and is out of scope). This is also the IAS 19 "if settled now" figure the monthly accrual (W2's
 * service layer, `GratuityService.accrue`) reads each month: this month's answer minus last month's is the
 * incremental liability to post.
 *
 * `country` selects the formula's SHAPE; `rules` supplies its numbers for the day asked about. Returns null
 * - never 0 - when a rule the formula needs has not been set, so a missing figure refuses the calculation
 * rather than silently paying nobody anything.
 */
function gratuityOwed({ serviceDays, basicPay, country, day, rules }) {
  const days = num(serviceDays);
  const pay = num(basicPay);
  if (days === null || days <= 0 || pay === null || pay < 0) return null;
  const years = days / 365;
  const dailyRate = pay / 30; // a day of "basic pay" is always the monthly figure over 30, in both countries' own conventions

  if (country === "AE") {
    const r = rulesOn(rules, AE_KEYS, day);
    if (Object.values(r).some((v) => v === null)) return null;
    const minDays = r["ae.gratuity.minServiceDaysForEntitlement"];
    if (days < minDays) return 0; // not yet entitled - a known zero, not an unknown one
    const firstYears = Math.min(years, r["ae.gratuity.firstBandYears"]);
    const secondYears = Math.max(0, years - r["ae.gratuity.firstBandYears"]);
    const uncapped = firstYears * r["ae.gratuity.firstBandDaysPerYear"] * dailyRate + secondYears * r["ae.gratuity.secondBandDaysPerYear"] * dailyRate;
    const cap = r["ae.gratuity.capYears"] * pay * 12; // two years' WAGE, not two years of the daily rate x 365
    return round2(Math.min(uncapped, cap));
  }

  if (country === "IN") {
    const r = rulesOn(rules, IN_KEYS, day);
    if (Object.values(r).some((v) => v === null)) return null;
    if (years < r["in.gratuity.minServiceYears"]) return 0; // a CLIFF, not a ramp: nothing accrues before it
    // The completed-years convention: a part year counts as a full year once it passes six months, which
    // this module leaves as a documented simplification (rounding to the nearest whole year) rather than a
    // silent guess - services/hr/gratuityService.js states this plainly wherever the figure is shown.
    const completedYears = Math.round(years);
    const uncapped = (completedYears * r["in.gratuity.daysPerYear"] * pay) / r["in.gratuity.monthDivisor"];
    return round2(Math.min(uncapped, r["in.gratuity.capAmount"]));
  }

  return null; // a country with no formula built is refused, never guessed at
}

// ---- Emiratisation -------------------------------------------------------------------------------------------

/**
 * Where an organisation stands against the UAE Emiratisation quota, and what not meeting it is already
 * costing per month, as things stand today. Deliberately read-only: see services/hr/emiratisationService.js
 * for why this never posts a provision (IAS 37 - there is no present obligation for a fine that has not
 * happened).
 *
 * `requiredPercent` and `finePerPosition` come from `StatutoryRule`, never from this function. `headcount`
 * is the UAE-mainland skilled headcount the quota applies to; `nationals` is how many of them are UAE
 * nationals.
 */
function emiratisationStatus({ headcount, nationals, requiredPercent, finePerPosition }) {
  const head = num(headcount);
  const have = num(nationals);
  const pct = num(requiredPercent);
  const fine = num(finePerPosition);
  if (head === null || head < 0 || have === null || have < 0 || pct === null || fine === null) return null;
  const required = Math.ceil((head * pct) / 100);
  const shortfall = Math.max(0, required - have);
  return {
    headcount: head,
    nationals: have,
    required,
    shortfall,
    compliant: shortfall === 0,
    monthlyExposure: round2(shortfall * fine),
  };
}

module.exports = { ruleOn, rulesOn, gratuityOwed, emiratisationStatus, AE_KEYS, IN_KEYS };
