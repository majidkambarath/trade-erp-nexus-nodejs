// Pure rules of attendance (no Mongoose, no clock): how many hours a day's punches come to, what that day's
// STATUS is, and how much of it was overtime. utils/hr.js already has the "elapsed span is not worked time"
// honesty for a process step's clock; this file is the same honesty for a punch, plus the one extra fact a
// shift adds - a day can be SHORT without anybody being late, if the shift itself was short.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const DEFAULT_SHIFT_HOURS = 8; // Federal Decree-Law No. 33 of 2021 Art. 17, and a fair default elsewhere

/** Hours between a check-in and a check-out, or null if either is missing or the pair runs backwards -
 * exactly utils/hr.js hoursBetween's own rule, named for its own domain here. */
function hoursWorked(checkIn, checkOut) {
  const a = checkIn instanceof Date ? checkIn.getTime() : checkIn ? new Date(checkIn).getTime() : NaN;
  const b = checkOut instanceof Date ? checkOut.getTime() : checkOut ? new Date(checkOut).getTime() : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return round2((b - a) / 3600000);
}

/**
 * What a day's STATUS is, from the few facts that decide it - checked in the order that actually matters:
 * a holiday or a weekly off is the day's status WHATEVER else is true of it (nobody is marked "half day"
 * for working less on a public holiday), approved leave comes next, and only then do real punches decide
 * present / half day / absent.
 *
 * `halfDayBelowHours` is the shift's own threshold (e.g. a 4-hour cutoff on an 8-hour shift) - a dated,
 * organisation-set figure, not a constant: an organisation that runs a 6-hour shift does not want "half day"
 * meaning something that never fits inside it.
 */
function dayStatus({ isHoliday, isWeeklyOff, approvedLeave, checkIn, checkOut, halfDayBelowHours }) {
  if (isHoliday) return "holiday";
  if (isWeeklyOff) return "weekly_off";
  if (approvedLeave) return "on_leave";
  const hours = hoursWorked(checkIn, checkOut);
  if (hours === null) return "absent"; // no punches at all, or punches that cannot be read
  const cutoff = num(halfDayBelowHours);
  if (cutoff !== null && hours < cutoff) return "half_day";
  return "present";
}

/**
 * Overtime past the shift's own length. Null - never 0 - when there is nothing to measure (no punches), the
 * same "a missing figure is not a known zero" rule utils/hr.js already holds for a missing cost rate: an
 * absent day is not a day worked for zero overtime, it is a day with no hours to ask the question of at all.
 */
function overtimeHours(hours, shiftHours = DEFAULT_SHIFT_HOURS) {
  const h = num(hours);
  if (h === null) return null;
  const shift = num(shiftHours) || DEFAULT_SHIFT_HOURS;
  return h > shift ? round2(h - shift) : 0;
}

/** Whether a row can be written at all - the muster import's own validation, one row at a time. */
function validateAttendanceRow(data) {
  const errors = [];
  const add = (code, message, field) => errors.push({ code, message, field });
  if (!data?.staffId) add("STAFF_REQUIRED", "Which employee this row is for", "staffId");
  if (!data?.day) add("DAY_REQUIRED", "Which day this row is for", "day");
  if (data?.checkIn && data?.checkOut) {
    const h = hoursWorked(data.checkIn, data.checkOut);
    if (h === null) add("INVALID_PUNCHES", "Check-out cannot be before check-in", "checkOut");
  }
  return errors;
}

module.exports = { DEFAULT_SHIFT_HOURS, hoursWorked, dayStatus, overtimeHours, validateAttendanceRow };
