// How much of the muster one read returns, against a throwaway database.
//
// This exists because of a real, silent defect: `muster` used to end in a flat `.limit(2000)` while sorting
// `{ day: -1 }`, and the month matrix asks for a WHOLE month of every employee at once. At about 65 active
// employees x 31 days the cap bit, and because the sort is newest-day-first the rows it threw away were the
// EARLIEST days of the month being looked at - which the screen then drew as "Not marked" for people who
// had in fact been marked. The cases below pin both halves of the fix: a caller may ask for what it needs,
// and what it asks for is clamped rather than trusted.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_muster_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Staff: require("../staff/staffService"),
    Attendance: require("../hr/attendanceService"),
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
const DAYS = ["2026-03-01", "2026-03-02", "2026-03-03"];
let staff = [];

test("setup: three employees, each marked present on three days", { skip }, async () => {
  for (const n of [1, 2, 3]) {
    staff.push(await svc.Staff.createStaff(
      { name: `Muster ${n}`, designation: "Fabricator", contactNo: `05055500${n}0`, idNo: `784MUS000${n}`, joiningDate: "2026-01-01" },
      {}, admin
    ));
  }
  for (const s of staff) {
    for (const day of DAYS) await svc.Attendance.markDay({ staffId: s._id, day, status: "present" }, "tester");
  }
  const all = await svc.Attendance.muster({ from: DAYS[0], to: DAYS[2] });
  assert.equal(all.length, 9, "three employees x three days, all of it, well under the default cap");
});

// THE DEFECT ITSELF, reproduced: more rows in one range than the default cap allows. Written with real
// volume on purpose - asserting "limit: 5000 gives me my 9 rows" would have passed just as happily against
// the broken code, and a test that cannot fail is worth nothing.
const BULK_FROM = "2026-05-01";
let bulkTo;

test("setup: one range holding more rows than the default cap returns", { skip }, async () => {
  const AttendanceDay = require("../../models/modules/hr/attendanceDayModel");
  const docs = [];
  let d = new Date(`${BULK_FROM}T00:00:00Z`);
  // 3 employees x 700 days = 2100 rows, comfortably past the 2000 default.
  for (let i = 0; i < 700; i++) {
    const day = d.toISOString().slice(0, 10);
    for (const s of staff) docs.push({ staffId: s._id, day, status: "present", source: "manual", createdBy: "bulk" });
    d = new Date(d.getTime() + 86400000);
  }
  bulkTo = new Date(d.getTime() - 86400000).toISOString().slice(0, 10);
  await AttendanceDay.insertMany(docs);
  assert.equal(docs.length, 2100);
});

test("without a limit the default still cuts, and what it loses is the EARLIEST days of the range", { skip }, async () => {
  const capped = await svc.Attendance.muster({ from: BULK_FROM, to: bulkTo });
  assert.equal(capped.length, svc.Attendance.DEFAULT_MUSTER_ROWS, "the default is what an unasking caller gets");
  assert.equal(capped.some((r) => r.day === BULK_FROM), false, "the first day of the range is gone - this is the defect the month matrix hit");
});

test("a caller that says how many rows it needs gets the whole range - the fix", { skip }, async () => {
  const whole = await svc.Attendance.muster({ from: BULK_FROM, to: bulkTo, limit: 5000 });
  assert.equal(whole.length, 2100);
  assert.ok(whole.some((r) => r.day === BULK_FROM), "the earliest day is there now, which is the point");
  assert.ok(whole.some((r) => r.day === bulkTo));
});

test("the limit really does cut, and it cuts the EARLIEST days - the mechanism of the old defect", { skip }, async () => {
  // Three rows is one day's worth here. Sorted newest first, so what survives is the LAST day and what is
  // lost is the first - exactly how the old flat cap made a marked day read as "Not marked". If the sort or
  // the limit ever changes, this is the test that explains why it mattered.
  const cut = await svc.Attendance.muster({ from: DAYS[0], to: DAYS[2], limit: 3 });
  assert.equal(cut.length, 3);
  assert.deepEqual([...new Set(cut.map((r) => r.day))], ["2026-03-03"], "the newest day survived");
  assert.equal(cut.some((r) => r.day === DAYS[0]), false, "the earliest day is what a too-small read loses");
});

test("a limit above the ceiling is clamped, not obeyed - no caller can ask for an unbounded read", { skip }, async () => {
  assert.equal(svc.Attendance.MAX_MUSTER_ROWS, 20000);
  assert.equal(svc.Attendance.DEFAULT_MUSTER_ROWS, 2000);
  // Observable proof the clamp does not simply throw or empty the result; the ceiling itself is asserted
  // above, because proving it by inserting twenty thousand rows would buy nothing but minutes.
  const huge = await svc.Attendance.muster({ from: DAYS[0], to: DAYS[2], limit: 10 ** 9 });
  assert.equal(huge.length, 9);
});

test("a junk limit falls back to the default instead of throwing or returning nothing", { skip }, async () => {
  // These arrive from a query string (`GET /hr/attendance?limit=...`), so they are whatever somebody typed.
  for (const limit of ["abc", "", -5, 0, null, {}, [], NaN, Infinity]) {
    const rows = await svc.Attendance.muster({ from: DAYS[0], to: DAYS[2], limit });
    assert.equal(rows.length, 9, `a limit of ${JSON.stringify(limit)} should read as "no limit given"`);
  }
});

test("one day, and one employee's own day, are unaffected by any of it", { skip }, async () => {
  const oneDay = await svc.Attendance.forDay(DAYS[1]);
  assert.equal(oneDay.length, 3);
  const onePerson = await svc.Attendance.muster({ from: DAYS[0], to: DAYS[2], staffId: staff[0]._id });
  assert.equal(onePerson.length, 3);
});
