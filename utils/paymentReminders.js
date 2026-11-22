// Payment reminders: which reminder, if any, an invoice is owed TODAY. Pure (no Mongoose, no clock of its own): every day is
// "YYYY-MM-DD" on the organisation's calendar, handed in.
//
// THE RULE EVERYTHING ELSE RESTS ON: an invoice is sent at most ONE reminder at a time, and never one that has gone stale.
//   - A step is a number of days from the due date: -3 is three days before, 0 the day itself, 7 a week late.
//   - Today's step is the LATEST one reached (the largest step <= days since due). Earlier steps that were never sent are not made up:
//     an invoice that is 20 days late gets the 14-day reminder, never the 7-day one as well. After the server slept, a pause, or the
//     day reminders were first switched on, that is exactly one reminder per invoice, not a flood of old ones.
//   - A step older than `catchUpDays` is stale and is NOT sent (the person can still chase by hand): nobody wants "3 days overdue"
//     in an email that arrives 3 weeks later.
//   - A step already used (sent, or claimed by a send in flight) is never sent twice. `used` is the set of step keys already on the invoice.
const { diffDays } = require("./documentExpiry");

const MODES = ["off", "review", "automatic"];
const DEFAULT_STEPS = [-3, 0, 7, 14, 30];
const MIN_STEP = -30;
const MAX_STEP = 120;
const MAX_STEPS = 8;
const DEFAULTS = { mode: "off", steps: DEFAULT_STEPS, sendHour: 9, catchUpDays: 7 };

/** -3 -> "before3", 0 -> "due", 7 -> "late7": the part of an invoice's reminder key that names the step. */
const stepKey = (step) => (step < 0 ? `before${-step}` : step === 0 ? "due" : `late${step}`);
const stageOf = (step) => (step < 0 ? "before" : step === 0 ? "due" : "overdue");

/** The key a reminder is claimed under: one per invoice and step, which is what makes a send safe to repeat. */
const claimKey = (invoiceId, step) => `reminder:${invoiceId}:${stepKey(step)}`;

/** Days since the due date: negative before it, 0 on the day, positive when late. */
const offsetOf = (today, dueDay) => (today && dueDay ? diffDays(dueDay, today) : null);

/**
 * The reminder an invoice is owed, or null. `used` is a Set of step keys already sent for it; `daysSinceIssue` (optional) is how old the
 * invoice is, so that nothing is sent on the day it was made.
 * -> { step, key, stage, offset, age } where `age` is how many days after the step's own day it is now.
 */
function planStep({ offset, steps = DEFAULT_STEPS, catchUpDays = DEFAULTS.catchUpDays, used = new Set(), daysSinceIssue } = {}) {
  if (!Number.isFinite(offset)) return null;
  // never on the day the invoice was made: a cash sale is "due" that very day, and a customer at the counter is not chased
  if (Number.isFinite(daysSinceIssue) && daysSinceIssue < 1) return null;
  const reached = [...steps].filter((s) => Number.isInteger(s) && s <= offset).sort((a, b) => a - b);
  if (!reached.length) return null;
  const step = reached[reached.length - 1];
  const age = offset - step;
  if (age > catchUpDays) return null; // stale
  if (used.has(stepKey(step))) return null; // already sent (an earlier step being used does not matter: only today's)
  return { step, key: stepKey(step), stage: stageOf(step), offset, age };
}

// A number as a person or a form may send it: a number, or text that is a number. Never [] / null / true, which Number() turns into 0 or 1.
const asNumber = (v) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN);

const bad = (message, field) => Object.assign(new Error(message), { field, code: "INVALID_REMINDER_SETTINGS" });

/**
 * What a person may save, checked: `{ mode, steps, sendHour, catchUpDays }`, each optional (a missing one keeps what is held).
 * Throws an Error with `.field` and `.code`. Steps are whole days, 1 to 8 of them, from 30 before to 120 after, no repeats, sorted.
 */
function validateSettings(input = {}) {
  const out = {};
  if (input.mode !== undefined) {
    if (!MODES.includes(input.mode)) throw bad("Choose off, review first, or automatic", "mode");
    out.mode = input.mode;
  }
  if (input.steps !== undefined) {
    if (!Array.isArray(input.steps)) throw bad("The reminder days must be a list of whole numbers", "steps");
    const steps = input.steps.map(asNumber);
    if (steps.some((s) => !Number.isInteger(s) || s < MIN_STEP || s > MAX_STEP)) throw bad(`Each reminder day is a whole number from ${MIN_STEP} (before the due date) to ${MAX_STEP} (after it)`, "steps");
    const unique = [...new Set(steps)].sort((a, b) => a - b);
    if (!unique.length) throw bad("Choose at least one reminder day", "steps");
    if (unique.length > MAX_STEPS) throw bad(`Choose at most ${MAX_STEPS} reminder days`, "steps");
    out.steps = unique;
  }
  if (input.sendHour !== undefined) {
    const n = asNumber(input.sendHour);
    if (!Number.isInteger(n) || n < 0 || n > 23) throw bad("The sending hour is a whole number from 0 to 23", "sendHour");
    out.sendHour = n;
  }
  if (input.catchUpDays !== undefined) {
    const n = asNumber(input.catchUpDays);
    if (!Number.isInteger(n) || n < 0 || n > 30) throw bad("Catch-up days is a whole number from 0 to 30", "catchUpDays");
    out.catchUpDays = n;
  }
  return out;
}

/** Settings as held (with no row, or a row with gaps) -> a complete object. */
const settingsOf = (held = {}) => ({
  mode: MODES.includes(held?.mode) ? held.mode : DEFAULTS.mode,
  steps: Array.isArray(held?.steps) && held.steps.length ? [...held.steps].sort((a, b) => a - b) : [...DEFAULT_STEPS],
  sendHour: Number.isInteger(held?.sendHour) ? held.sendHour : DEFAULTS.sendHour,
  catchUpDays: Number.isInteger(held?.catchUpDays) ? held.catchUpDays : DEFAULTS.catchUpDays,
  lastAutoRunDay: held?.lastAutoRunDay || null,
});

/** The hour of the day (0-23) in a time zone, for "send after 9". */
function hourIn(zone, now = new Date()) {
  const h = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: zone }).formatToParts(now).find((p) => p.type === "hour")?.value;
  return Number(h);
}

/**
 * May an automatic pass run now? Only in automatic mode, only from the chosen hour, and only once a calendar day: the day is claimed
 * by the caller with a compare-and-set on `lastAutoRunDay`, so two servers cannot both run it.
 */
const automaticDue = ({ settings, today, hour }) => settings.mode === "automatic" && hour >= settings.sendHour && settings.lastAutoRunDay !== today;

/**
 * How many reminders may still go today. Reminders share the daily email allowance with everything else but never take the last
 * `reserve` share of it (a person sending an invoice by hand must never find the allowance spent by a robot).
 */
function room({ dailyLimit, used, reserve = 0.2, cap = Infinity }) {
  const ceiling = Math.floor(dailyLimit * (1 - reserve));
  return Math.max(0, Math.min(ceiling - used, cap));
}

/** Provider answers that mean EVERY send will fail the same way: stop the pass, and give the claim back so it can be tried again. */
const ORG_WIDE_ERRORS = new Set(["PROVIDER_AUTH", "SECRET_UNREADABLE", "FROM_NOT_VERIFIED", "PROVIDER_QUOTA", "FROM_DOMAIN_MISMATCH"]);
const isOrgWide = (code) => ORG_WIDE_ERRORS.has(code);

module.exports = {
  MODES, DEFAULTS, DEFAULT_STEPS, MAX_STEPS, ORG_WIDE_ERRORS,
  stepKey, stageOf, claimKey, offsetOf, planStep, validateSettings, settingsOf, hourIn, automaticDue, room, isOrgWide,
};
