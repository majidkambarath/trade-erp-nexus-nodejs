// HRMS > Reports' two derived reports, against a throwaway database.
//
// The assertions that matter most are the two that pin these reports TO SOMETHING ELSE: the attendance
// totals must equal what the Overview dashboard reports for the same month, and a leave balance must
// equal what LeaveRequestService.balance answers for that employee. A report that disagrees with the
// screen it summarises is worse than no report.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_hrrep_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Staff: require("../staff/staffService"),
    Attendance: require("../hr/attendanceService"),
    Leave: require("../hr/leaveRequestService"),
    LeaveType: require("../hr/timeSetupService").LeaveTypeService,
    Dash: require("../hr/hrDashboardService"),
    Reports: require("../hr/hrReportService"),
    days: require("../../utils/documentExpiry"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const admin = new mongoose.Types.ObjectId();
const today = () => svc.days.todayInOrg();
let month, from, to, ravi, asha, unmarked;

test("setup: three employees, one of whom nobody ever marks", { skip }, async () => {
  month = today().slice(0, 7);
  from = `${month}-01`;
  to = svc.days.addDays(`${month}-01`, 27); // inside every month, so the fixture never falls off a short one

  const make = (name, id, backDays) => svc.Staff.createStaff(
    { name, designation: "Fabricator", contactNo: `050777000${id}`, idNo: `784REP000${id}`, joiningDate: svc.days.addDays(today(), -backDays) },
    {}, admin
  );
  ravi = await make("Ravi Report", 1, 400);
  asha = await make("Asha Report", 2, 200);
  unmarked = await make("Never Marked", 3, 100);
});

test("every active employee gets a row, and the one nobody marked reads UNKNOWN, not 0%", { skip }, async () => {
  await svc.Attendance.markDay({ staffId: ravi._id, day: `${month}-02`, status: "present", hoursWorked: 9 }, "tester");
  await svc.Attendance.markDay({ staffId: ravi._id, day: `${month}-03`, status: "absent" }, "tester");
  await svc.Attendance.markDay({ staffId: ravi._id, day: `${month}-04`, status: "holiday" }, "tester");
  await svc.Attendance.markDay({ staffId: asha._id, day: `${month}-02`, status: "present", hoursWorked: 8 }, "tester");

  const r = await svc.Reports.attendance({ from, to });
  assert.equal(r.employees.length, 3, "the person nobody marked is still a row - that is the point of the report");

  const never = r.employees.find((e) => String(e._id) === String(unmarked._id));
  assert.equal(never.marked, 0);
  assert.equal(never.rate, null, "unknown, never 0%: there is nothing to divide by");
  assert.deepEqual(r.neverMarked.map((p) => String(p._id)), [String(unmarked._id)]);

  const one = r.employees.find((e) => String(e._id) === String(ravi._id));
  assert.equal(one.present, 1);
  assert.equal(one.absent, 1);
  assert.equal(one.holiday, 1);
  assert.equal(one.expected, 2, "a holiday is not a day anybody was expected");
  assert.equal(one.rate, 50);
});

test("the report's totals EQUAL the Overview dashboard's figures for the same month", { skip }, async () => {
  // Two screens, one truth. Both go through utils/hrDashboard.js attendanceSplit, which is the whole
  // reason the report aggregates rather than counting again.
  const [r, d] = await Promise.all([svc.Reports.attendance({ from: `${month}-01`, to: svc.days.addDays(`${month}-01`, 30) }), svc.Dash.overview()]);
  assert.equal(r.totals.worked, d.attendance.worked);
  assert.equal(r.totals.expected, d.attendance.expected);
  assert.equal(r.totals.rate, d.attendance.rate);
  assert.equal(r.totals.hours, d.attendance.hours);
  assert.equal(r.totals.present, d.attendance.counts.present);
});

test("a range longer than the raw muster's own cap is still counted in full", { skip }, async () => {
  // AttendanceService.muster caps its read and drops the EARLIEST days, which is exactly what a report
  // must not do. This one counts in the database, so the cap cannot reach it.
  const wide = await svc.Reports.attendance({ from: svc.days.addDays(today(), -300), to: today() });
  const inner = await svc.Reports.attendance({ from, to });
  assert.ok(wide.totals.marked >= inner.totals.marked, "a wider window can never hold fewer marked days");
  assert.equal(wide.totals.marked, 4, "every row written above, none dropped");
});

test("a backwards or unreadable range is refused, and so is one nobody could want", { skip }, async () => {
  await assert.rejects(() => svc.Reports.attendance({ from: `${month}-28`, to: `${month}-01` }), /cannot be before/);
  await assert.rejects(() => svc.Reports.attendance({ from: "rubbish", to }), /YYYY-MM-DD/);
  await assert.rejects(() => svc.Reports.attendance({ from: "2020-01-01", to: "2026-01-01" }), /400 days or fewer/);
});

test("every employee's leave balance, in every active type, and NEVER a one-at-a-time read", { skip }, async () => {
  const annual = await svc.LeaveType.create({ name: "Annual Rep", accrualPerMonth: 2.5 }, admin);
  const sick = await svc.LeaveType.create({ name: "Sick Rep", accrualPerMonth: 1 }, admin);
  // Deactivated AFTER creation on purpose: LeaveTypeService.create never reads `isActive` (it is not in
  // the field list at timeSetupService.js:71), so a type can only be switched off by an update - which is
  // the real flow on the Setup screen too.
  const unpaid = await svc.LeaveType.create({ name: "Unpaid Rep", accrualPerMonth: 0 }, admin);
  await svc.LeaveType.update(unpaid._id, { isActive: false }, admin);

  const r = await svc.Reports.leaveBalances({});
  // 3 employees x 2 ACTIVE types. The switched-off type is not a row.
  assert.equal(r.rows.length, 6, JSON.stringify(r.rows.map((x) => `${x.name}/${x.leaveTypeName}`)));
  assert.ok(!r.rows.some((x) => x.leaveTypeName === "Unpaid Rep"), "an inactive leave type is not reported");
  assert.equal(r.totals.employees, 3);
  assert.deepEqual([annual, sick].map((t) => r.rows.some((x) => String(x.leaveTypeId) === String(t._id))), [true, true]);
});

test("a figure here is the SAME figure the employee's own screen shows", { skip }, async () => {
  const types = await svc.LeaveType.list();
  const annual = types.find((t) => t.name === "Annual Rep");
  // An approved request must come off the balance; a pending one must not.
  const req = await svc.Leave.submit({ staffId: ravi._id, leaveTypeId: annual._id, fromDay: `${month}-10`, toDay: `${month}-12`, reason: "three days" }, admin);
  await svc.Leave.decide(req._id, { action: "approve" }, { admin: { id: String(admin), name: "tester", grants: ["hr.approve"] } });

  const [report, direct] = await Promise.all([
    svc.Reports.leaveBalances({}),
    svc.Leave.balance(ravi._id, annual._id),
  ]);
  const row = report.rows.find((x) => String(x.staffId) === String(ravi._id) && String(x.leaveTypeId) === String(annual._id));
  assert.deepEqual({ accrued: row.accrued, consumed: row.consumed, available: row.available }, direct,
    "the report and LeaveRequestService.balance must agree - they share utils/leave.js leaveBalance");
  assert.equal(row.consumed, 3, "the approved request, counted inclusively");
});

test("an employee the balance cannot be worked out for is NAMED, never shown as owing nothing", { skip }, async () => {
  const r = await svc.Reports.leaveBalances({});
  // Everybody here has a joining date, so nothing is missing - the shape is what is pinned, so a future
  // change that starts silently dropping such a person fails here.
  assert.ok(Array.isArray(r.missing));
  assert.ok(r.rows.every((x) => x.accrued !== null && x.available !== null));
});

test("a day that cannot be read is refused rather than answered for today", { skip }, async () => {
  await assert.rejects(() => svc.Reports.leaveBalances({ day: "not-a-day" }), /YYYY-MM-DD/);
  const r = await svc.Reports.leaveBalances({ day: today() });
  assert.equal(r.day, today());
});
