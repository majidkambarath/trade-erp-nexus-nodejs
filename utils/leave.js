// Pure rules of leave (no Mongoose): a balance is DERIVED - accrual to date, plus whatever was carried
// forward, less what approved requests have actually consumed - never a number written to a row and read
// back, because a stored balance drifts the moment anything is corrected after the fact. The same
// "derive it, do not store it" decision utils/jobWork.js already made for "how much is with the job worker".

const { isCalendarDay, diffDays } = require("./documentExpiry");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Whole calendar months between two days (never negative) - the accrual clock, deliberately not a day
 * count divided by 30, so "two months" means two months on the calendar, not 60 days of something. */
function monthsBetween(fromDay, toDay) {
  if (!isCalendarDay(fromDay) || !isCalendarDay(toDay) || toDay < fromDay) return 0;
  const [fy, fm, fd] = fromDay.split("-").map(Number);
  const [ty, tm, td] = toDay.split("-").map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1; // the day of the month has not come round yet this month
  return Math.max(0, months);
}

/** Inclusive days a leave request covers - the day it starts counts, same convention utils/hr.js
 * serviceDays uses for a joining day. Null for a backwards or unreadable range. */
function requestDays(fromDay, toDay) {
  const d = diffDays(fromDay, toDay);
  return d === null || d < 0 ? null : d + 1;
}

/**
 * The balance today: accrued since joining, plus whatever was carried forward from before this leave type
 * existed or from a prior year, less what is actually consumed. `requests` is the WHOLE history for this
 * employee and this leave type - the function does its own filtering to APPROVED, non-cancelled rows,
 * rather than trusting a caller to have pre-filtered correctly (the same "the pure function owns its own
 * correctness" instinct utils/hr.js already holds). A request that was approved and later cancelled must
 * NOT still count against the balance, and a rejected or still-pending one never did.
 */
function leaveBalance({ joiningDay, today, accrualPerMonth, carriedForward = 0, requests = [] }) {
  const accrualRate = num(accrualPerMonth);
  if (accrualRate === null || !isCalendarDay(joiningDay) || !isCalendarDay(today)) return null;
  const months = monthsBetween(joiningDay, today);
  const accrued = round2(months * accrualRate + (num(carriedForward) || 0));
  const consumed = round2(
    (Array.isArray(requests) ? requests : [])
      .filter((r) => r && r.status === "APPROVED" && !r.cancelledAt)
      .reduce((total, r) => total + (requestDays(r.fromDay, r.toDay) || 0), 0)
  );
  return { accrued, consumed, available: round2(accrued - consumed) };
}

/** Whether a request can be saved at all - not whether there is enough balance, which is the approver's
 * own judgement (the same "a warning, not a block" instinct credit control already uses for a sale). */
function validateLeaveRequest(data) {
  const errors = [];
  const add = (code, message, field) => errors.push({ code, message, field });
  if (!data?.staffId) add("STAFF_REQUIRED", "Choose who this leave is for", "staffId");
  if (!data?.leaveTypeId) add("LEAVE_TYPE_REQUIRED", "Choose the leave type", "leaveTypeId");
  if (!isCalendarDay(data?.fromDay)) add("INVALID_FROM", "Enter the first day", "fromDay");
  if (!isCalendarDay(data?.toDay)) add("INVALID_TO", "Enter the last day", "toDay");
  if (isCalendarDay(data?.fromDay) && isCalendarDay(data?.toDay) && data.toDay < data.fromDay) {
    add("RANGE_BACKWARDS", "The last day cannot be before the first day", "toDay");
  }
  return errors;
}

module.exports = { monthsBetween, requestDays, leaveBalance, validateLeaveRequest };
