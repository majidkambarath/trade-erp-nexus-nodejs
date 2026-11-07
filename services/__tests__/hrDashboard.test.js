// The HR MIS dashboard against a throwaway database.
//
// The assertion that matters most is the LAST one: the dashboard's payroll figures must equal what
// PayrollService itself reports for the same month. A management screen whose headline disagrees with the
// page it links to is worse than no screen, so the two are pinned to each other rather than to a literal.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_hrdash_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Staff: require("../staff/staffService"),
    Contract: require("../hr/contractService"),
    Payroll: require("../hr/payrollService"),
    Attendance: require("../hr/attendanceService"),
    Leave: require("../hr/leaveRequestService"),
    LeaveType: require("../hr/timeSetupService").LeaveTypeService,
    Dept: require("../hr/timeSetupService").DepartmentService,
    Dash: require("../hr/hrDashboardService"),
    Doc: require("../hr/employeeDocumentService"),
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
let month, fabrication, ravi, anya, leaver;

test("setup: three employees in two departments, one of whom has left", { skip }, async () => {
  month = today().slice(0, 7);
  fabrication = await svc.Dept.create({ name: "Fabrication" }, admin);

  ravi = await svc.Staff.createStaff(
    { name: "Ravi Dash", designation: "Fabricator", contactNo: "0506660001", idNo: "784DSH0001", joiningDate: svc.days.addDays(today(), -400), departmentId: fabrication._id },
    {}, admin
  );
  await svc.Contract.create({ staffId: ravi._id, effectiveFrom: svc.days.addDays(today(), -400), basicPay: 6000, allowances: 1000 }, admin);

  // No department at all - must land in the Unassigned bucket, never be dropped.
  anya = await svc.Staff.createStaff(
    { name: "Anya Dash", designation: "Clerk", contactNo: "0506660002", idNo: "784DSH0002", joiningDate: svc.days.addDays(today(), -200) },
    {}, admin
  );
  await svc.Contract.create({ staffId: anya._id, effectiveFrom: svc.days.addDays(today(), -200), basicPay: 4000 }, admin);

  leaver = await svc.Staff.createStaff(
    { name: "Omar Gone", designation: "Helper", contactNo: "0506660003", idNo: "784DSH0003", joiningDate: svc.days.addDays(today(), -300) },
    {}, admin
  );
  await svc.Staff.updateStaff(leaver._id, { exitDate: svc.days.addDays(today(), -10), status: "Inactive" }, {}, admin);
});

test("headcount counts the people on the books, and nobody is lost to a missing department", { skip }, async () => {
  const d = await svc.Dash.overview();
  assert.equal(d.headcount.active, 2, "the leaver is Inactive, so not active headcount");
  assert.equal(d.headcount.total, 3, "a leaver is kept, never deleted");
  assert.equal(d.headcount.costed, 2, "both active employees have a contract");
  assert.equal(d.headcount.missingCostRate, 0);

  const names = d.headcount.byDepartment.map((b) => b.name);
  assert.ok(names.includes("Fabrication"), "a department known by its id is named, never shown as a raw id");
  assert.ok(names.includes("Unassigned"), JSON.stringify(names));
  assert.equal(d.headcount.byDepartment.reduce((t, b) => t + b.people, 0), 2, "every active employee is in exactly one bucket");
});

test("the month's attendance is split, and its rate ignores holidays", { skip }, async () => {
  const day = `${month}-02`;
  await svc.Attendance.markDay({ staffId: ravi._id, day, status: "present" }, "tester");
  await svc.Attendance.markDay({ staffId: anya._id, day, status: "absent" }, "tester");
  await svc.Attendance.markDay({ staffId: ravi._id, day: `${month}-03`, status: "holiday" }, "tester");

  const d = await svc.Dash.overview();
  assert.equal(d.attendance.counts.present, 1);
  assert.equal(d.attendance.counts.absent, 1);
  assert.equal(d.attendance.counts.holiday, 1);
  assert.equal(d.attendance.expected, 2, "the holiday is not a day anybody was expected");
  assert.equal(d.attendance.rate, 50);
});

test("leave reports who is out today and what is still waiting", { skip }, async () => {
  const type = await svc.LeaveType.create({ name: "Annual", accrualPerMonth: 2.5 }, admin);
  await svc.Leave.submit({ staffId: ravi._id, leaveTypeId: type._id, fromDay: today(), toDay: today(), reason: "today" }, admin);

  const d = await svc.Dash.overview();
  assert.equal(d.leave.pending, 1, "submitted and not yet decided");
  assert.equal(d.leave.onLeaveToday, 0, "pending is not approved - nobody is out on an undecided request");
});

test("a month with no payroll run reads as nothing ran, not as a cost of zero", { skip }, async () => {
  const d = await svc.Dash.overview();
  assert.equal(d.cost.ran, false);
  assert.equal(d.cost.perEmployee, null, "no run means unknown, and null is how the screen tells that from 0");
  assert.equal(d.cost.byDepartment.length, 0);
});

test("THE FIGURE THAT MATTERS: the dashboard's cost equals what payroll itself reports", { skip }, async () => {
  const plan = await svc.Payroll.plan(month);
  await svc.Payroll.post(month, {}, "tester");

  const d = await svc.Dash.overview();
  assert.equal(d.cost.ran, true);
  assert.equal(d.cost.thisMonth, plan.totals.gross, "the headline is payroll's own gross, not a second sum of it");
  assert.equal(d.cost.employees, plan.totals.employeeCount);
  assert.equal(d.cost.perEmployee, plan.totals.gross / plan.totals.employeeCount);

  const thisMonth = d.cost.byMonth.at(-1);
  assert.equal(thisMonth.month, month);
  assert.equal(thisMonth.gross, plan.totals.gross);
  assert.equal(thisMonth.net, plan.totals.net);

  // And the department split adds back up to the same total, so no payslip fell out of the Staff join.
  const split = d.cost.byDepartment.reduce((t, b) => t + b.value, 0);
  assert.equal(split, plan.totals.gross, "every payslip is in exactly one department bucket");
});

test("the month trend is dense and a REVERSED run is not counted", { skip }, async () => {
  const before = await svc.Dash.overview();
  assert.equal(before.cost.byMonth.length, 6, "six months by default, dense");
  assert.equal(before.cost.byMonth.filter((m) => m.ran).length, 1);

  const runs = await svc.Payroll.list();
  await svc.Payroll.reverse(runs[0]._id, "testing the dashboard", "tester");

  const after = await svc.Dash.overview();
  assert.equal(after.cost.thisMonth, 0, "a reversed run leaves the month with no cost, not with its old one");
  assert.equal(after.cost.byMonth.at(-1).ran, false);
});

test("the reader split: without hr.confidential no money survives, and nothing withheld reads as zero", { skip }, async () => {
  const full = await svc.Dash.overview();
  const shut = svc.Dash.forReader(full, false);

  assert.equal(shut.headcount.active, full.headcount.active, "headcount is nobody's pay");
  assert.equal(shut.attendance.rate, full.attendance.rate);
  assert.equal(shut.cost.perEmployee, undefined);
  assert.equal(shut.cost.byDepartment, undefined);
  assert.notEqual(shut.cost.perEmployee, 0, "undefined is 'hidden'; 0 would be a lie");

  // HEADCOUNT by department stays: it is a count of people, not a split of anybody's pay. The two
  // byDepartment figures are deliberately different things, which is why this is asserted rather than
  // left to a search for the key name (a search that matched this one is what caught the sloppy version).
  assert.ok(Array.isArray(shut.headcount.byDepartment) && shut.headcount.byDepartment.length > 0);

  // Nothing withheld may be serialised at all - JSON.stringify drops an undefined, so the cost subtree
  // must come out carrying only the aggregates a non-confidential reader is allowed.
  const costKeys = Object.keys(JSON.parse(JSON.stringify(shut.cost))).sort();
  assert.deepEqual(costKeys, ["byMonth", "changePct", "previousMonth", "thisMonth"], JSON.stringify(costKeys));

  // And no money FIGURE survives anywhere, planted-and-searched the way purchaseFlow.test.js does.
  const serialised = JSON.stringify(shut);
  for (const secret of [full.cost.perEmployee, ...full.cost.byDepartment.map((b) => b.value)]) {
    if (!Number.isFinite(secret) || secret === full.cost.thisMonth) continue; // the org total is allowed
    assert.equal(serialised.includes(String(secret)), false, `the figure ${secret} must not reach this reader`);
  }
});

// A silent zero is the worst shape of wrong on a compliance figure, and this one really happened:
// DocumentExpiryService resolves EmployeeDocument through mongoose.models and skips the whole staff branch
// when it is not registered, so the card reported 0 expiring for an organisation that had six.
test("expiring documents are COUNTED, never reported as a confident zero", { skip }, async () => {
  const today = svc.days.todayInOrg();
  await svc.Doc.create({ staffId: ravi._id, name: "Labour card", number: "LC-1", expiryDate: svc.days.addDays(today, -5) }, "tester");
  await svc.Doc.create({ staffId: anya._id, name: "Residence visa", number: "VS-1", expiryDate: svc.days.addDays(today, 12) }, "tester");
  await svc.Doc.create({ staffId: ravi._id, name: "Passport", number: "P-1", expiryDate: svc.days.addDays(today, 300) }, "tester");

  const d = await svc.Dash.overview();
  assert.equal(d.documents.expired, 1, "the one already gone");
  assert.equal(d.documents.expiringSoon, 1, "the one inside 30 days - and NOT the one 300 days out");
  assert.equal(d.documents.total, 2);
});

test("the period can be asked for by month, and a past month is read whole", { skip }, async () => {
  const last = svc.Dash.resolvePeriod({}, "2026-03-11").previousMonth;
  const d = await svc.Dash.overview({ month: last });
  assert.equal(d.period.month, last);
  assert.equal(d.period.to, require("../../utils/hrDashboard").lastDayOf(last));
  assert.equal(d.period.months.at(-1), last);
});
