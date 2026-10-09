// Pure rules for foreign-currency amounts and the organisation's calendar days. No I/O, no Mongoose.
//
// A rate is "base units per 1 foreign unit" (USD 1 = AED 3.6725), kept to at most 6 decimal places.
// The base-currency equivalent of a foreign amount is the exact product, rounded half-up to
// the base currency's cents. It is computed on integers (BigInt) so 0.1 + 0.2 style float noise can
// never move a cent: the browser (src/lib/currencyForms.js) uses the same method and gets the same
// answer.

const orgLocale = require("./orgLocale");

const RATE_DECIMALS = 6;
const BASE_DECIMALS = 2;

// How many decimal places a number is written with (3.6725 -> 4, 1e-7 -> 7). NaN if it is not a number.
function decimalPlaces(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  const m = /^-?(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(n));
  if (!m) return NaN;
  return Math.max(0, (m[2] || "").length - Number(m[3] || 0));
}

const scaled = (value, dp) => BigInt(Math.round(Number(value) * 10 ** dp));

// Base-currency amount of a foreign amount: round_half_up(foreign x rate, 2 dp).
function convertToBase(foreignAmount, rate, { decimals = 2 } = {}) {
  const f = scaled(foreignAmount, decimals); // foreign amount in minor units
  const r = scaled(rate, RATE_DECIMALS); // rate in millionths
  const num = f * r * 100n; // base cents x (10^decimals x 10^6)
  const den = BigInt(10 ** decimals) * 10n ** BigInt(RATE_DECIMALS);
  const cents = (2n * num + den) / (2n * den); // half up (amounts here are positive)
  return Number(cents) / 100;
}

const roundTo = (value, dp) => {
  const f = 10 ** dp;
  return Math.round((Number(value) + Number.EPSILON) * f) / f;
};

// How far `rate` is from the master rate, in percent of the master rate.
const deviationPercent = (rate, masterRate) => (masterRate > 0 ? (Math.abs(rate - masterRate) / masterRate) * 100 : 0);

// Splits a foreign amount over legs in proportion to their base amounts, to the currency's minor
// unit; the last leg takes the remainder so the legs always add back to the foreign amount.
function splitForeign(foreignAmount, baseAmounts, { decimals = 2 } = {}) {
  const total = baseAmounts.reduce((t, a) => t + a, 0);
  const minor = 10 ** decimals;
  const whole = Math.round(foreignAmount * minor);
  let left = whole;
  return baseAmounts.map((a, i) => {
    const part = i === baseAmounts.length - 1 ? left : Math.round(total > 0 ? (whole * a) / total : 0);
    left -= part;
    return part / minor;
  });
}

// ----------------------------------------------------------------------------------- the organisation's days
// "YYYY-MM-DD" of an instant as seen in the organisation's time zone (utils/orgLocale.js; Asia/Dubai until an organisation
// says otherwise). A plain "YYYY-MM-DD" string is already a calendar day and is returned as it is.
function orgDay(input = new Date()) {
  return orgLocale.dayOf(input);
}

// True for a real calendar day written YYYY-MM-DD (no 31 February).
function isCalendarDay(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ""));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return y >= 1900 && y <= 2200 && probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

// The instant a calendar day begins on the organisation's wall clock (00:00 there). This is what an effective date is stored as.
const orgDayStart = (ymd) => orgLocale.dayStart(ymd);
// The instant after that day ends (the next day's start).
const orgDayEnd = (ymd) => orgLocale.dayEnd(ymd);

// "04/10/2026" for messages the server writes (day first).
const displayDay = (ymd) => (ymd ? ymd.split("-").reverse().join("/") : "");

module.exports = {
  RATE_DECIMALS, BASE_DECIMALS,
  decimalPlaces, convertToBase, roundTo, deviationPercent, splitForeign,
  orgDay, isCalendarDay, orgDayStart, orgDayEnd, displayDay,
};
