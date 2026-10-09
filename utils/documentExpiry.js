// Document expiry rules, as pure functions (no Mongoose, no clock except the `today` you pass in).
//
// The business runs on its organisation's calendar (its own time zone: utils/orgLocale.js, Asia/Dubai until an organisation
// says otherwise), so "expired" means the expiry DAY is before today's DAY there, whatever hour the server thinks it is.
// Calendar days travel as "YYYY-MM-DD" strings: comparing two of them is comparing the dates.
//
//   classify("2026-11-04", { today: "2026-10-05" })
//     -> { status: "EXPIRING_SOON" | "VALID" | "EXPIRED" | "NO_EXPIRY" | "INVALID_DATE", expiryDay, daysLeft }
//
//   a document is EXPIRING_SOON from today (0 days left) up to and including `warningDays` days
//   ahead (default 30); EXPIRED from the day after its expiry day.

const orgLocale = require("./orgLocale");

const DEFAULT_WARNING_DAYS = 30;
const MAX_WARNING_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const STATUS = Object.freeze({
  VALID: "VALID",
  EXPIRING_SOON: "EXPIRING_SOON",
  EXPIRED: "EXPIRED",
  NO_EXPIRY: "NO_EXPIRY",
  INVALID_DATE: "INVALID_DATE",
});

const pad = (n, len = 2) => String(n).padStart(len, "0");

// "YYYY-MM-DD" for a real calendar date, else null (2026-02-30 is not one).
function calendarDay(y, m, d) {
  const [year, month, day] = [Number(y), Number(m), Number(d)];
  if (![year, month, day].every(Number.isInteger)) return null;
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function isCalendarDay(value) {
  if (typeof value !== "string") return false;
  const m = DAY_RE.exec(value);
  return Boolean(m && calendarDay(m[1], m[2], m[3]));
}

const dayMs = (day) => {
  const [, y, m, d] = DAY_RE.exec(day);
  return Date.UTC(Number(y), Number(m) - 1, Number(d));
};

// The calendar day an instant falls on, in the organisation's zone.
function orgDay(instant) {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  return orgLocale.dayOf(date);
}

// Today in the organisation's zone. `now` is a Date, a timestamp, or already a "YYYY-MM-DD" day.
function todayInOrg(now = new Date()) {
  if (typeof now === "string" && isCalendarDay(now)) return now;
  return orgDay(now);
}

function addDays(day, days) {
  if (!isCalendarDay(day)) return null;
  const t = new Date(dayMs(day) + Number(days) * DAY_MS);
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// Whole days from `fromDay` to `toDay` (positive when `toDay` is later).
function diffDays(fromDay, toDay) {
  if (!isCalendarDay(fromDay) || !isCalendarDay(toDay)) return null;
  return Math.round((dayMs(toDay) - dayMs(fromDay)) / DAY_MS);
}

const isUtcMidnight = (d) => d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;

// What calendar day does a stored or submitted expiry value mean?
//   { day: null,  invalid: false }  nothing was given
//   { day: "...", invalid: false }  a real day
//   { day: null,  invalid: true }   something was given that is not a date
//
// A bare "YYYY-MM-DD" (what a date field sends) is that day. A Date at exactly UTC midnight is how
// Mongoose stores such a day, so it is read by its UTC parts; any other instant is read on the
// organisation's calendar.
function parseExpiry(value) {
  if (value === null || value === undefined) return { day: null, invalid: false };
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return { day: null, invalid: false };
    if (DAY_RE.test(text)) return isCalendarDay(text) ? { day: text, invalid: false } : { day: null, invalid: true };
    if (!/^\d{4}-\d{2}-\d{2}T/.test(text)) return { day: null, invalid: true }; // only full ISO timestamps beyond a bare day
    value = new Date(text);
  }
  if (typeof value === "number") value = new Date(value);
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return { day: null, invalid: true };
  const day = isUtcMidnight(value) ? calendarDay(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()) : orgDay(value);
  return day ? { day, invalid: false } : { day: null, invalid: true };
}

const toExpiryDay = (value) => parseExpiry(value).day;

function warningDaysOf(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_WARNING_DAYS ? n : DEFAULT_WARNING_DAYS;
}

// Where an expiry stands today. `today` defaults to the current day in the organisation's zone.
function classify(expiry, { today = new Date(), warningDays = DEFAULT_WARNING_DAYS } = {}) {
  const parsed = parseExpiry(expiry);
  if (parsed.invalid) return { status: STATUS.INVALID_DATE, expiryDay: null, daysLeft: null };
  if (!parsed.day) return { status: STATUS.NO_EXPIRY, expiryDay: null, daysLeft: null };
  const todayDay = todayInOrg(today);
  const daysLeft = diffDays(todayDay, parsed.day);
  let status = STATUS.VALID;
  if (daysLeft < 0) status = STATUS.EXPIRED;
  else if (daysLeft <= warningDaysOf(warningDays)) status = STATUS.EXPIRING_SOON;
  return { status, expiryDay: parsed.day, daysLeft };
}

// "Expires today", "12 days left", "Expired 3 days ago" - for messages.
function daysLeftLabel(daysLeft) {
  if (daysLeft === null || daysLeft === undefined || !Number.isFinite(daysLeft)) return "";
  const plural = (n) => `${n} day${n === 1 ? "" : "s"}`;
  if (daysLeft === 0) return "Expires today";
  return daysLeft > 0 ? `${plural(daysLeft)} left` : `Expired ${plural(-daysLeft)} ago`;
}

module.exports = {
  DEFAULT_WARNING_DAYS, MAX_WARNING_DAYS, STATUS,
  isCalendarDay, calendarDay, orgDay, todayInOrg, addDays, diffDays, parseExpiry, toExpiryDay, warningDaysOf,
  classify, daysLeftLabel,
};
