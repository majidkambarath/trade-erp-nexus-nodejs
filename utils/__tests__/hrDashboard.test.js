// The HR MIS dashboard's arithmetic, with no database and no clock.
const test = require("node:test");
const assert = require("node:assert/strict");
const d = require("../hrDashboard");

// Stands in for orgDay: the rows carry real Dates, and which calendar day one falls on is the
// organisation's business, so the shaping takes it as an argument.
const dayOf = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);

test("shiftMonth steps across a year end both ways, and leaves nonsense alone", () => {
  assert.equal(d.shiftMonth("2026-12", 1), "2027-01");
  assert.equal(d.shiftMonth("2027-01", -1), "2026-12");
  assert.equal(d.shiftMonth("2026-01", -13), "2024-12");
  assert.equal(d.shiftMonth("not-a-month", 1), "not-a-month");
});

test("monthRange ends with the month asked for, oldest first", () => {
  assert.deepEqual(d.monthRange("2026-03", 4), ["2025-12", "2026-01", "2026-02", "2026-03"]);
  assert.deepEqual(d.monthRange("2026-03", 1), ["2026-03"]);
  assert.deepEqual(d.monthRange("2026-03", 0), ["2026-03"], "a count of nothing still means this month");
});

test("lastDayOf knows a short month and a leap February", () => {
  assert.equal(d.lastDayOf("2026-02"), "2026-02-28");
  assert.equal(d.lastDayOf("2024-02"), "2024-02-29");
  assert.equal(d.lastDayOf("2026-04"), "2026-04-30");
  assert.equal(d.lastDayOf("rubbish"), null);
});

test("the month in progress stops at today; a past month is read whole", () => {
  const now = d.resolvePeriod({}, "2026-03-11");
  assert.equal(now.month, "2026-03");
  assert.equal(now.from, "2026-03-01");
  assert.equal(now.to, "2026-03-11", "a part month must not be compared as though it were a whole one");

  const past = d.resolvePeriod({ month: "2026-01" }, "2026-03-11");
  assert.equal(past.to, "2026-01-31");
  assert.equal(past.previousMonth, "2025-12");
  assert.equal(past.months.length, d.MONTHS);
  assert.equal(past.months.at(-1), "2026-01");
});

test("a share of nothing is null, never zero", () => {
  assert.equal(d.share(3, 4), 75);
  assert.equal(d.share(0, 4), 0);
  assert.equal(d.share(3, 0), null, "nothing to divide by is unknown, not 'none of it'");
  assert.equal(d.change(110, 100), 10);
  assert.equal(d.change(110, 0), null);
});

test("headcount counts joiners, leavers and who was actually on the books each month end", () => {
  const staff = [
    { joiningDate: "2026-01-10", exitDate: null },      // stays throughout
    { joiningDate: "2026-02-05", exitDate: "2026-03-20" }, // joins Feb, leaves Mar
    { joiningDate: "2026-03-01", exitDate: null },      // joins Mar
    { joiningDate: null, exitDate: null },               // no joining date at all - not countable
  ];
  const flow = d.headcountFlow(staff, ["2026-01", "2026-02", "2026-03"], { dayOf });
  assert.deepEqual(flow[0], { month: "2026-01", joiners: 1, leavers: 0, net: 1, headcount: 1 });
  assert.deepEqual(flow[1], { month: "2026-02", joiners: 1, leavers: 0, net: 1, headcount: 2 });
  // The March leaver is out by the month end, so the closing headcount is the two who remain.
  assert.deepEqual(flow[2], { month: "2026-03", joiners: 1, leavers: 1, net: 0, headcount: 2 });
});

test("a month with no movement still reports the right headcount", () => {
  const flow = d.headcountFlow([{ joiningDate: "2025-06-01", exitDate: null }], ["2026-02"], { dayOf });
  assert.deepEqual(flow[0], { month: "2026-02", joiners: 0, leavers: 0, net: 0, headcount: 1 });
});

test("departments roll up by id, fall back to the typed name, and keep one honest Unassigned bucket", () => {
  const rows = [
    { departmentId: "d1", department: "Fabrication", pay: 5000 },
    { departmentId: "d1", department: "Fabrication", pay: 4000 },
    { departmentId: null, department: "Coating", pay: 3000 },   // older row: text, no ref
    { departmentId: null, department: "", pay: 1000 },           // neither
    { departmentId: null, pay: 500 },                            // neither, field absent
  ];
  const out = d.byDepartment(rows, { amountOf: (r) => r.pay });
  assert.deepEqual(out.map((b) => [b.name, b.value, b.people]), [
    ["Fabrication", 9000, 2],
    ["Coating", 3000, 1],
    [d.UNASSIGNED, 1500, 2],
  ]);
});

test("a department known only by its id never shows a raw id once any row names it", () => {
  const out = d.byDepartment([{ departmentId: "d9" }, { departmentId: "d9", department: "Paint" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Paint");
  assert.equal(out[0].value, 2, "counting one each by default");
});

test("the attendance rate measures the days somebody was expected, so a holiday cannot flatter it", () => {
  const split = d.attendanceSplit([
    { status: "present", count: 18, hours: 144 },
    { status: "half_day", count: 2, hours: 8 },
    { status: "absent", count: 3 },
    { status: "on_leave", count: 2 },
    { status: "holiday", count: 3 },
    { status: "weekly_off", count: 4 },
  ]);
  assert.equal(split.worked, 20);
  assert.equal(split.expected, 25, "holidays and weekly offs are not days anybody was expected");
  assert.equal(split.rate, 80);
  assert.equal(split.hours, 152);
});

test("a month nobody has marked has an unknown rate, not nought per cent", () => {
  assert.equal(d.attendanceSplit([]).rate, null);
  assert.equal(d.attendanceSplit([{ status: "holiday", count: 2 }]).rate, null);
});

test("cost by month is dense, and a REVERSED run is never counted", () => {
  const runs = [
    { period: "2026-02", status: "POSTED", totalGross: 100000, totalNet: 92000, employeeCount: 10 },
    { period: "2026-03", status: "REVERSED", totalGross: 999999, totalNet: 999999, employeeCount: 99 },
  ];
  const out = d.costByMonth(runs, ["2026-01", "2026-02", "2026-03"]);
  assert.deepEqual(out.map((m) => [m.month, m.ran, m.gross]), [
    ["2026-01", false, 0],
    ["2026-02", true, 100000],
    ["2026-03", false, 0],
  ]);
});

test("labour reports whether there was any work at all, rather than a flattering zero", () => {
  const none = d.labourFlow({});
  assert.equal(none.hasWork, false, "an organisation running neither production nor garage has nothing here");
  assert.equal(none.idleShare, null);

  const some = d.labourFlow({ bookedCost: 1700, idleCost: 300, bookedHours: 170, idleHours: 30, orders: 4 });
  assert.equal(some.hasWork, true);
  assert.equal(some.total, 2000);
  assert.equal(some.idleShare, 15);
  // The waterfall reads paid -> less what was not booked -> what reached the work.
  assert.deepEqual(some.steps.map((s) => [s.key, s.value, s.kind]), [
    ["paid", 2000, "total"],
    ["idle", -300, "change"],
    ["booked", 1700, "total"],
  ]);
});

test("a reader without hr.confidential keeps the totals and loses anything divisible or nameable", () => {
  const full = {
    headcount: { active: 12 },
    cost: { byMonth: [{ month: "2026-03", gross: 100000 }], thisMonth: 100000, previousMonth: 90000, changePct: 11.1, perEmployee: 8333, byDepartment: [{ name: "Fabrication", value: 60000 }] },
    labour: { hasWork: true, orders: 3, bookedCost: 1700, idleCost: 300, bookedHours: 170, idleHours: 30, idleShare: 15 },
    gratuity: { liability: 54000, month: "2026-03", employeeCount: 12, missingCount: 1, employees: [{ name: "Ravi", owed: 4500 }] },
  };

  const open = d.forReader(full, true);
  assert.equal(open.cost.perEmployee, 8333, "a confidential reader sees everything, untouched");
  assert.ok(open.gratuity.employees);

  const shut = d.forReader(full, false);
  assert.equal(shut.confidential, false);
  assert.equal(shut.headcount.active, 12, "headcount is nobody's pay");
  assert.equal(shut.cost.thisMonth, 100000, "an organisation-wide total is an aggregate and stays");
  assert.deepEqual(shut.cost.byMonth, full.cost.byMonth);
  assert.equal(shut.cost.perEmployee, undefined, "an average beside a headcount is a salary with extra steps");
  assert.equal(shut.cost.byDepartment, undefined, "a department of one names that one person's pay");
  assert.equal(shut.labour.bookedCost, undefined, "the money on a job is pay; the HOURS are not");
  assert.equal(shut.labour.idleHours, 30);
  assert.equal(shut.gratuity.liability, 54000);
  assert.equal(shut.gratuity.employees, undefined);
  // Nothing withheld may come back as a zero: the screen tells "hidden" from "none" by undefined.
  for (const v of [shut.cost.perEmployee, shut.cost.byDepartment, shut.labour.bookedCost, shut.gratuity.employees]) {
    assert.equal(v, undefined);
    assert.notEqual(v, 0);
  }
});

test("forReader does not mutate what it was handed", () => {
  const full = { cost: { thisMonth: 1, perEmployee: 2 } };
  d.forReader(full, false);
  assert.equal(full.cost.perEmployee, 2, "a second reader on the same object must still see everything");
});
