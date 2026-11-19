// Recurring invoices: when the next one is due. Pure: days are "YYYY-MM-DD" strings in the organisation's calendar, no clock.
//
// A schedule is { frequency: weekly | monthly | quarterly | yearly, interval: 1-12, startDay, endDay?, maxCount? }.
// Monthly, quarterly and yearly runs keep the START's day of the month and clamp it to a short month: started on 31 January,
// the runs are 28 (or 29) February, 31 March, 30 April - never drifting to the 28th for good after February.
//
// Two counters: a SLOT is a date on the calendar (slot k is the k-th date from the start); `made` is how many invoices were
// actually made. A pause skips slots without making invoices, so "12 invoices" still means twelve.

const FREQUENCIES = ["weekly", "monthly", "quarterly", "yearly"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };
const NOUN = { weekly: "week", monthly: "month", quarterly: "quarter", yearly: "year" };

const pad = (n) => String(n).padStart(2, "0");
const isDay = (d) => typeof d === "string" && DAY.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12

function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The anchor's month moved on by `months`, with the anchor's day clamped to that month. */
function monthRun(anchorDay, months) {
  const [y, m, d] = anchorDay.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${pad(nm)}-${pad(Math.min(d, daysInMonth(ny, nm)))}`;
}

/** The day of slot k (k = 0 is the start). Computed from the start every time, so clamping never accumulates. */
function runDay(schedule, k) {
  const step = Math.max(1, Number(schedule.interval) || 1);
  if (schedule.frequency === "weekly") return addDays(schedule.startDay, 7 * step * k);
  return monthRun(schedule.startDay, MONTHS[schedule.frequency] * step * k);
}

/** Checks and cleans a schedule. Returns the cleaned schedule or throws an Error with code INVALID_SCHEDULE and `field`. */
function validateSchedule(input = {}) {
  const fail = (message, field) => Object.assign(new Error(message), { code: "INVALID_SCHEDULE", field });
  const frequency = String(input.frequency || "");
  if (!FREQUENCIES.includes(frequency)) throw fail("Choose how often: weekly, monthly, quarterly or yearly", "frequency");
  const interval = input.interval === undefined || input.interval === "" || input.interval === null ? 1 : Number(input.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 12) throw fail("Every 1 to 12 periods", "interval");
  const startDay = String(input.startDay || "").slice(0, 10);
  if (!isDay(startDay)) throw fail("Enter the date of the first invoice", "startDay");
  const out = { frequency, interval, startDay };
  if (input.endDay) {
    const endDay = String(input.endDay).slice(0, 10);
    if (!isDay(endDay)) throw fail("The end date is not a date", "endDay");
    if (endDay < startDay) throw fail("The end date is before the first invoice", "endDay");
    out.endDay = endDay;
  }
  if (input.maxCount !== undefined && input.maxCount !== null && input.maxCount !== "") {
    const maxCount = Number(input.maxCount);
    if (!Number.isInteger(maxCount) || maxCount < 1 || maxCount > 1000) throw fail("The number of invoices is 1 to 1,000", "maxCount");
    out.maxCount = maxCount;
  }
  return out;
}

/** Whether slot k is still inside the schedule, `made` invoices having been made before it. */
function withinSchedule(schedule, k, made = k) {
  if (schedule.maxCount && made >= schedule.maxCount) return false;
  if (schedule.endDay && runDay(schedule, k) > schedule.endDay) return false;
  return true;
}

/** The day of slot `cursor`, or null when the schedule has finished. */
function nextRun(schedule, cursor, made = cursor) {
  return withinSchedule(schedule, cursor, made) ? runDay(schedule, cursor) : null;
}

/**
 * The runs owed up to `today`: [{ day, k }] from slot `cursor`, at most `cap` of them (a server down for months must not make
 * years of invoices in one pass; the rest follow on the next pass).
 */
function dueRuns(schedule, cursor, today, cap = 12, made = cursor) {
  const out = [];
  for (let k = cursor; out.length < cap && withinSchedule(schedule, k, made + out.length); k += 1) {
    const day = runDay(schedule, k);
    if (day > today) break;
    out.push({ day, k });
  }
  return out;
}

/** Resuming after a pause: the first slot on or after `today` (the slots the pause skipped are passed, not invoiced), or null. */
function resumeFrom(schedule, cursor, today, made = cursor) {
  for (let k = cursor; withinSchedule(schedule, k, made); k += 1) {
    if (runDay(schedule, k) >= today) return k;
    if (k - cursor > 10000) break;
  }
  return null;
}

/** The next `n` run days from slot `cursor`, for the form's preview. */
function upcoming(schedule, cursor = 0, n = 3, made = cursor) {
  const out = [];
  for (let k = cursor; out.length < n && withinSchedule(schedule, k, made + out.length); k += 1) out.push(runDay(schedule, k));
  return out;
}

/** The first slot dated after `lastDay` (a schedule edited after some invoices were made carries on after the last one). */
function cursorAfter(schedule, lastDay) {
  if (!lastDay) return 0;
  let k = 0;
  while (runDay(schedule, k) <= lastDay && k < 100000) k += 1;
  return k;
}

/** "Every month", "Every 2 weeks", "Every quarter". */
function describe(schedule) {
  const noun = NOUN[schedule?.frequency];
  if (!noun) return "";
  const n = Number(schedule.interval) || 1;
  return n === 1 ? `Every ${noun}` : `Every ${n} ${noun}s`;
}

module.exports = { FREQUENCIES, isDay, addDays, runDay, validateSchedule, withinSchedule, nextRun, dueRuns, resumeFrom, cursorAfter, upcoming, describe };
