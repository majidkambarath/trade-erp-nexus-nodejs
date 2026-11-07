// HRMS > Reports' own shaping, with no database and no clock.
const test = require("node:test");
const assert = require("node:assert/strict");
const r = require("../hrReports");
const dash = require("../hrDashboard");
const leave = require("../leave");

// Three people; one of them nobody has marked at all, which is the row this report exists to show.
const STAFF = [
  { _id: "s1", name: "Ravi Kumar", staffId: "EMP-0001", designation: "Fabricator", department: "Fabrication" },
  { _id: "s2", name: "Asha Nair", staffId: "EMP-0002", designation: "Coater", department: "Coating" },
  { _id: "s3", name: "Bikash Tamang", staffId: "EMP-0003", designation: "Helper", department: null },
];
// Grouped rows, the shape the $group in hrReportService produces.
const g = (staffId, status, count, hours = 0, overtime = 0) => ({ staffId, status, count, hours, overtime });
const ROWS = [
  g("s1", "present", 20, 160, 6), g("s1", "absent", 2), g("s1", "weekly_off", 8),
  g("s2", "present", 18, 144, 0), g("s2", "half_day", 2, 8), g("s2", "on_leave", 3), g("s2", "weekly_off", 8),
];

test("daysInRange counts both ends, and refuses a range that runs backwards", () => {
  assert.equal(r.daysInRange("2026-10-01", "2026-10-31"), 31);
  assert.equal(r.daysInRange("2026-10-01", "2026-10-01"), 1, "one day is one day, not nothing");
  assert.equal(r.daysInRange("2026-10-31", "2026-10-01"), null);
  assert.equal(r.daysInRange("rubbish", "2026-10-01"), null);
});

test("every active employee gets a row, including one nobody marked", () => {
  const out = r.attendanceSummary({ rows: ROWS, staff: STAFF, from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(out.employees.map((e) => e.staffId), ["EMP-0001", "EMP-0002", "EMP-0003"]);
  const never = out.employees.find((e) => e.staffId === "EMP-0003");
  assert.equal(never.marked, 0);
  assert.equal(never.present, 0);
  // The whole point: unknown, never 0%. A person nobody marked has not got perfect attendance, and has
  // not got none either - there is nothing to divide by.
  assert.equal(never.rate, null, "a month nobody marked is unknown, not 0%");
  assert.equal(never.unmarked, 31);
  assert.deepEqual(out.neverMarked.map((p) => p.staffId), ["EMP-0003"]);
});

test("the rate is worked out the way the dashboard works it out, per employee and in total", () => {
  const out = r.attendanceSummary({ rows: ROWS, staff: STAFF, from: "2026-10-01", to: "2026-10-31" });
  const ravi = out.employees.find((e) => e.staffId === "EMP-0001");
  // worked = present + half_day; expected = worked + absent + on_leave. A weekly off is neither.
  assert.equal(ravi.worked, 20);
  assert.equal(ravi.expected, 22);
  assert.equal(ravi.rate, dash.attendanceSplit(ROWS.filter((x) => x.staffId === "s1")).rate);
  // And the totals are the SAME function over every row, so the report cannot disagree with the Overview
  // tile for the same month - the reason this goes through attendanceSplit rather than counting again.
  const expected = dash.attendanceSplit(ROWS);
  assert.equal(out.totals.rate, expected.rate);
  assert.equal(out.totals.worked, expected.worked);
  assert.equal(out.totals.hours, 312);
  assert.equal(out.totals.overtime, 6, "overtime is reported at last, having been computed since W3");
});

test("a row for somebody not in the employee list is counted in the totals and named, never dropped", () => {
  const rows = [...ROWS, g("gone", "present", 5, 40)];
  const out = r.attendanceSummary({ rows, staff: STAFF, from: "2026-10-01", to: "2026-10-31" });
  assert.equal(out.orphanRows, 5);
  // Dropping it would make these totals disagree with the dashboard's figure for the same month.
  assert.equal(out.totals.present, 43);
  assert.equal(out.totals.marked, 66);
});

test("an unreadable range leaves unmarked unknown rather than guessing at it", () => {
  const out = r.attendanceSummary({ rows: ROWS, staff: STAFF, from: "rubbish", to: "2026-10-31" });
  assert.equal(out.days, null);
  assert.ok(out.employees.every((e) => e.unmarked === null));
});

test("summarising nothing at all is an honest empty report, not a crash", () => {
  const out = r.attendanceSummary({});
  assert.deepEqual(out.employees, []);
  assert.equal(out.totals.employees, 0);
  assert.equal(out.totals.rate, null);
});

// ---- leaveBalanceRows ----

const TYPES = [
  { _id: "t1", name: "Annual", accrualPerMonth: 2.5, isPaid: true, isActive: true },
  { _id: "t2", name: "Sick", accrualPerMonth: 1, isPaid: true, isActive: true },
  { _id: "t3", name: "Unpaid", accrualPerMonth: 0, isPaid: false, isActive: false }, // switched off
];
const PEOPLE = [
  { _id: "s1", name: "Ravi Kumar", staffId: "EMP-0001", joiningDay: "2025-01-15" },
  { _id: "s2", name: "Asha Nair", staffId: "EMP-0002", joiningDay: "2026-07-01" },
];
const REQS = [
  { staffId: "s1", leaveTypeId: "t1", status: "APPROVED", fromDay: "2026-03-02", toDay: "2026-03-06", cancelledAt: null },
  { staffId: "s1", leaveTypeId: "t1", status: "PENDING", fromDay: "2026-11-02", toDay: "2026-11-06", cancelledAt: null },
  { staffId: "s1", leaveTypeId: "t1", status: "APPROVED", fromDay: "2026-05-04", toDay: "2026-05-05", cancelledAt: new Date("2026-04-01") },
  { staffId: "s1", leaveTypeId: "t2", status: "APPROVED", fromDay: "2026-02-10", toDay: "2026-02-10", cancelledAt: null },
];

test("a row per employee per ACTIVE leave type, the switched-off one left out", () => {
  const out = r.leaveBalanceRows({ staff: PEOPLE, leaveTypes: TYPES, requests: REQS, day: "2026-10-31" });
  assert.deepEqual(out.rows.map((x) => `${x.staffCode}/${x.leaveTypeName}`), [
    "EMP-0001/Annual", "EMP-0001/Sick", "EMP-0002/Annual", "EMP-0002/Sick",
  ]);
  assert.equal(out.totals.employees, 2);
});

test("each figure is utils/leave.js's own, so the report and the employee's screen cannot disagree", () => {
  const out = r.leaveBalanceRows({ staff: PEOPLE, leaveTypes: TYPES, requests: REQS, day: "2026-10-31" });
  const annual = out.rows.find((x) => x.staffCode === "EMP-0001" && x.leaveTypeName === "Annual");
  const direct = leave.leaveBalance({
    joiningDay: "2025-01-15", today: "2026-10-31", accrualPerMonth: 2.5,
    requests: REQS.filter((q) => q.staffId === "s1" && q.leaveTypeId === "t1"),
  });
  assert.deepEqual({ accrued: annual.accrued, consumed: annual.consumed, available: annual.available }, direct);
  // 21 whole months at 2.5, less the one five-day approved request: the cancelled one and the pending one
  // must not count, which is the filtering leaveBalance owns and this function deliberately does not redo.
  assert.equal(annual.accrued, 52.5);
  assert.equal(annual.consumed, 5);
  assert.equal(annual.available, 47.5);
});

test("an employee with no joining day is listed as uncostable, never shown a balance of nothing", () => {
  const out = r.leaveBalanceRows({
    staff: [...PEOPLE, { _id: "s9", name: "New Starter", staffId: "EMP-0009", joiningDay: null }],
    leaveTypes: TYPES, requests: REQS, day: "2026-10-31",
  });
  assert.ok(!out.rows.some((x) => x.staffCode === "EMP-0009"), "no invented zero balance");
  assert.deepEqual(out.missing.map((m) => [m.staffId, m.reason]), [["EMP-0009", "NO_JOINING_DATE"]]);
});

test("the totals add up the rows that exist, and nothing at all is an empty report", () => {
  const out = r.leaveBalanceRows({ staff: PEOPLE, leaveTypes: TYPES, requests: REQS, day: "2026-10-31" });
  const sum = (k) => Math.round(out.rows.reduce((t, x) => t + x[k], 0) * 100) / 100;
  assert.equal(out.totals.accrued, sum("accrued"));
  assert.equal(out.totals.available, sum("available"));
  const none = r.leaveBalanceRows({});
  assert.deepEqual(none.rows, []);
  assert.deepEqual(none.totals, { accrued: 0, consumed: 0, available: 0, employees: 0 });
});
