const test = require("node:test");
const assert = require("node:assert/strict");
const { hoursWorked, dayStatus, overtimeHours, validateAttendanceRow } = require("../attendance");

// RULE: a holiday or a weekly off is the day's status WHATEVER else is true of it - checked first, so a
// short day on a public holiday is never marked "half day". Mutation checked: move the checks after the
// punch-based ones and this fails.

test("hours worked is the span between two punches", () => {
  assert.equal(hoursWorked("2026-03-02T08:00:00Z", "2026-03-02T16:30:00Z"), 8.5);
});

test("missing or backwards punches give no hours at all", () => {
  assert.equal(hoursWorked(null, "2026-03-02T16:00:00Z"), null);
  assert.equal(hoursWorked("2026-03-02T16:00:00Z", "2026-03-02T08:00:00Z"), null);
});

// RULE - mutation: check punches before isHoliday/isWeeklyOff and this fails
test("RULE: a holiday or weekly off is the status whatever the punches say", () => {
  assert.equal(dayStatus({ isHoliday: true, checkIn: "2026-03-02T08:00:00Z", checkOut: "2026-03-02T09:00:00Z" }), "holiday");
  assert.equal(dayStatus({ isWeeklyOff: true }), "weekly_off");
  assert.equal(dayStatus({ isHoliday: true }), "holiday", "a holiday with no punches at all is still a holiday, not absent");
});

test("approved leave is the status even with no punches", () => {
  assert.equal(dayStatus({ approvedLeave: true }), "on_leave");
});

test("no punches at all, on an ordinary day, is absent", () => {
  assert.equal(dayStatus({}), "absent");
});

test("a short day below the shift's own half-day cutoff reads as half day", () => {
  assert.equal(dayStatus({ checkIn: "2026-03-02T08:00:00Z", checkOut: "2026-03-02T10:00:00Z", halfDayBelowHours: 4 }), "half_day");
  assert.equal(dayStatus({ checkIn: "2026-03-02T08:00:00Z", checkOut: "2026-03-02T16:00:00Z", halfDayBelowHours: 4 }), "present");
});

test("with no half-day cutoff set, any real punch pair is simply present", () => {
  assert.equal(dayStatus({ checkIn: "2026-03-02T08:00:00Z", checkOut: "2026-03-02T09:00:00Z" }), "present");
});

test("overtime is hours past the shift's own length, defaulting to 8", () => {
  assert.equal(overtimeHours(9.5), 1.5);
  assert.equal(overtimeHours(7, 8), 0, "short of a full shift is not negative overtime");
  assert.equal(overtimeHours(13, 12), 1, "a 12-hour shift's own length, not the 8-hour default");
});

test("overtime is null - never 0 - for a day with no hours to measure at all", () => {
  assert.equal(overtimeHours(null), null);
  assert.notEqual(overtimeHours(null), 0);
});

test("a muster row needs an employee and a day", () => {
  assert.deepEqual(validateAttendanceRow({}).map((e) => e.field).sort(), ["day", "staffId"]);
  assert.deepEqual(validateAttendanceRow({ staffId: "s1", day: "2026-03-02" }), []);
});

test("a check-out before check-in is refused on the row, not silently swapped", () => {
  const errs = validateAttendanceRow({ staffId: "s1", day: "2026-03-02", checkIn: "2026-03-02T16:00:00Z", checkOut: "2026-03-02T08:00:00Z" });
  assert.equal(errs[0].code, "INVALID_PUNCHES");
});
