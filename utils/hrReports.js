// Pure shaping for HRMS > Reports (no Mongoose, no clock): a month's muster per employee, and everybody's
// leave balance on a day. Both are read-only summaries of rows some other wave already wrote.
//
// Two rules decide everything in this file:
//
// 1. THE REPORT MUST AGREE WITH THE DASHBOARD. `attendanceSummary`'s totals go through
//    utils/hrDashboard.js `attendanceSplit`, the same function the Overview's attendance tile reads, so
//    "worked", "expected" and the rate cannot drift between the two screens - the same reason the daily
//    summary and the day book both read LedgerReportsService.voucherRow rather than counting vouchers
//    twice. Per employee it is the SAME function applied to that employee's own rows, so the column
//    headings mean one thing everywhere.
//
// 2. A STATUS IS READ, NEVER RE-DERIVED. AttendanceDay stamps `status`, `hoursWorked` and `overtimeHours`
//    at write time from utils/attendance.js, and its own comment says why: a half-day cutoff changed next
//    month must not rewrite last month's musters. So this file counts what was stamped and calls
//    dayStatus/overtimeHours on nothing.

const { attendanceSplit } = require("./hrDashboard");
const { leaveBalance } = require("./leave");
const { isCalendarDay, diffDays } = require("./documentExpiry");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const name = (s) => s?.name || "Unnamed";
const count = (r) => (Number.isFinite(Number(r?.count)) ? Number(r.count) : 0);

/** Calendar days in an inclusive range, or null if the range cannot be read. */
function daysInRange(from, to) {
  const d = diffDays(from, to);
  return d === null || d < 0 ? null : d + 1;
}

/**
 * A muster for a period, per employee and in total.
 *
 * `rows` are GROUPED rows - one per (employee, status) with a count, hours and overtime - which is the
 * shape hrDashboardService's own attendance aggregation already produces. Taking them grouped rather than
 * a day at a time is the point: the raw muster read is capped (AttendanceService.MAX_MUSTER_ROWS), and its
 * own comment says the rows it drops are the EARLIEST days of the month, which render as "not marked" for
 * people who were marked. A report that quietly loses a fortnight is worse than no report, so the counting
 * happens in the database and this function never sees a row limit.
 *
 * Every ACTIVE employee is listed, including one with no rows at all: a person nobody marked is the single
 * most important line on an attendance report, and dropping them is how a month reads complete when it is
 * not. Such a row carries `marked: 0` and a null `rate` - unknown, never 0%, which is attendanceSplit's
 * own rule (`share` returns null against a whole of nothing) and what `paidHoursOn` states for one day.
 *
 * `unmarked` is calendar days in the range less the days this person has a row for. It is deliberately NOT
 * "working days missed": that needs the shift calendar and the holiday table, and a figure this report
 * cannot stand behind is worse than one it does not offer.
 */
function attendanceSummary({ rows = [], staff = [], from, to } = {}) {
  const days = daysInRange(from, to);
  const byStaff = new Map((Array.isArray(staff) ? staff : []).map((s) => [String(s._id), []]));
  const orphans = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const key = String(r?.staffId);
    // A row whose employee is not in the list (switched off since, or in a branch this caller cannot see)
    // is still counted in the totals and named apart - never silently dropped, which would make these
    // totals disagree with the dashboard's own figure for the same month.
    if (byStaff.has(key)) byStaff.get(key).push(r);
    else orphans.push(r);
  }

  const employees = (Array.isArray(staff) ? staff : []).map((s) => {
    const own = byStaff.get(String(s._id)) || [];
    const split = attendanceSplit(own);
    return {
      _id: s._id,
      name: name(s),
      staffId: s.staffId,
      designation: s.designation || null,
      // Staff.department is the free-text name the form keeps in step with `departmentId`, so it reads
      // correctly whether or not the employee was pointed at a department master (staffModel.js:27).
      department: s.department || null,
      ...split.counts,
      marked: own.reduce((t, r) => t + count(r), 0),
      worked: split.worked,
      expected: split.expected,
      rate: split.rate,
      hours: round2(split.hours),
      overtime: round2(split.overtime),
    };
  }).map((e) => ({ ...e, unmarked: days === null ? null : Math.max(0, days - e.marked) }));

  // The totals are every row in the period, orphans included, through the one function the dashboard reads.
  const totals = attendanceSplit(Array.isArray(rows) ? rows : []);
  return {
    from, to, days,
    employees,
    totals: {
      ...totals.counts,
      employees: employees.length,
      marked: (Array.isArray(rows) ? rows : []).reduce((t, r) => t + count(r), 0),
      worked: totals.worked,
      expected: totals.expected,
      rate: totals.rate,
      hours: round2(totals.hours),
      overtime: round2(totals.overtime),
    },
    // Named so a reader can see the totals cover people the employee list does not.
    orphanRows: orphans.reduce((t, r) => t + count(r), 0),
    // Who cannot be reported on at all: nobody marked them once in the whole period.
    neverMarked: employees.filter((e) => e.marked === 0).map((e) => ({ _id: e._id, name: e.name, staffId: e.staffId })),
  };
}

/**
 * Every active employee's balance in every active leave type, on a day.
 *
 * Each figure goes through utils/leave.js `leaveBalance` - the same function the employee's own screen and
 * the portal read - so the report cannot say one thing and the employee's page another. `leaveBalance`
 * does its own filtering to APPROVED, non-cancelled requests, so this function must NOT pre-filter them.
 *
 * It returns null for an employee with no joining day (nothing to accrue from), and such a person is
 * listed in `missing` rather than shown with a balance of 0 - the same "a missing figure is not a known
 * zero" rule gratuity already applies to an employee with no basic pay.
 */
function leaveBalanceRows({ staff = [], leaveTypes = [], requests = [], day } = {}) {
  const types = (Array.isArray(leaveTypes) ? leaveTypes : []).filter((t) => t && t.isActive !== false);
  // Requests keyed by employee AND type, so each balance is handed only its own history.
  const byPair = new Map();
  for (const r of Array.isArray(requests) ? requests : []) {
    const key = `${r?.staffId}|${r?.leaveTypeId}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(r);
  }

  const rows = [];
  const missing = [];
  for (const s of Array.isArray(staff) ? staff : []) {
    // joiningDay is passed already converted by the service (orgDay), never a raw Date: String(date) is
    // "Fri Nov 06 2026", the mistake this codebase has now made three times in three different places.
    if (!isCalendarDay(s?.joiningDay)) {
      missing.push({ _id: s?._id, name: name(s), staffId: s?.staffId, reason: "NO_JOINING_DATE" });
      continue;
    }
    for (const t of types) {
      const balance = leaveBalance({
        joiningDay: s.joiningDay,
        today: day,
        accrualPerMonth: t.accrualPerMonth,
        requests: byPair.get(`${s._id}|${t._id}`) || [],
      });
      if (balance === null) {
        missing.push({ _id: s._id, name: name(s), staffId: s.staffId, reason: "NO_ACCRUAL_RATE", leaveTypeName: t.name });
        continue;
      }
      rows.push({
        _id: `${s._id}-${t._id}`,
        staffId: s._id, name: name(s), staffCode: s.staffId,
        leaveTypeId: t._id, leaveTypeName: t.name, isPaid: t.isPaid !== false,
        ...balance,
      });
    }
  }

  const totals = rows.reduce(
    (t, r) => ({ accrued: t.accrued + r.accrued, consumed: t.consumed + r.consumed, available: t.available + r.available }),
    { accrued: 0, consumed: 0, available: 0 }
  );
  return {
    day,
    rows,
    missing,
    totals: { accrued: round2(totals.accrued), consumed: round2(totals.consumed), available: round2(totals.available), employees: new Set(rows.map((r) => String(r.staffId))).size },
  };
}

module.exports = { daysInRange, attendanceSummary, leaveBalanceRows };
