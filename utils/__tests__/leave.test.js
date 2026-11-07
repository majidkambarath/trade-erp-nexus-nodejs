const test = require("node:test");
const assert = require("node:assert/strict");
const { monthsBetween, requestDays, leaveBalance, validateLeaveRequest } = require("../leave");

test("months between two days counts whole calendar months, not days divided by 30", () => {
  assert.equal(monthsBetween("2026-01-15", "2026-03-15"), 2);
  assert.equal(monthsBetween("2026-01-15", "2026-03-10"), 1, "the day of the month has not come round yet");
  assert.equal(monthsBetween("2026-01-15", "2026-01-20"), 0);
});

test("a backwards range, or junk, is zero months, not negative", () => {
  assert.equal(monthsBetween("2026-03-15", "2026-01-15"), 0);
  assert.equal(monthsBetween("not-a-day", "2026-01-15"), 0);
});

test("a leave request's days are inclusive of its first day", () => {
  assert.equal(requestDays("2026-03-02", "2026-03-02"), 1);
  assert.equal(requestDays("2026-03-02", "2026-03-04"), 3);
});

test("a backwards request has no days at all", () => {
  assert.equal(requestDays("2026-03-04", "2026-03-02"), null);
});

const REQUESTS = [
  { status: "APPROVED", fromDay: "2026-02-01", toDay: "2026-02-03" }, // 3 days, consumed
  { status: "APPROVED", fromDay: "2026-03-01", toDay: "2026-03-01", cancelledAt: "2026-03-05" }, // approved then cancelled
  { status: "PENDING", fromDay: "2026-04-01", toDay: "2026-04-05" }, // not yet decided
  { status: "REJECTED", fromDay: "2026-05-01", toDay: "2026-05-05" },
];

test("balance is accrued since joining, less what is actually consumed", () => {
  const b = leaveBalance({ joiningDay: "2026-01-01", today: "2026-07-01", accrualPerMonth: 2.5, requests: REQUESTS });
  // 6 whole months x 2.5 = 15 accrued; only the 3-day APPROVED-and-not-cancelled request counts
  assert.equal(b.accrued, 15);
  assert.equal(b.consumed, 3);
  assert.equal(b.available, 12);
});

// RULE - mutation: drop the cancelledAt filter and this fails
test("RULE: a request approved then cancelled does not still count against the balance", () => {
  const withCancel = leaveBalance({ joiningDay: "2026-01-01", today: "2026-07-01", accrualPerMonth: 2.5, requests: REQUESTS });
  const withoutTheCancelledOne = leaveBalance({ joiningDay: "2026-01-01", today: "2026-07-01", accrualPerMonth: 2.5, requests: [REQUESTS[0]] });
  assert.equal(withCancel.consumed, withoutTheCancelledOne.consumed, "the cancelled request contributes nothing either way");
});

test("pending and rejected requests never count, approved or not", () => {
  const b = leaveBalance({ joiningDay: "2026-01-01", today: "2026-07-01", accrualPerMonth: 0, requests: REQUESTS });
  assert.equal(b.consumed, 3, "only the one real approved-and-live request");
});

test("carried-forward days add to the accrual", () => {
  const b = leaveBalance({ joiningDay: "2026-01-01", today: "2026-01-01", accrualPerMonth: 2, carriedForward: 5, requests: [] });
  assert.equal(b.accrued, 5, "zero months accrued yet, but the carry-forward is real");
});

test("a missing accrual rate or an unreadable day refuses the calculation, not a wrong number", () => {
  assert.equal(leaveBalance({ joiningDay: "2026-01-01", today: "2026-07-01", accrualPerMonth: null }), null);
  assert.equal(leaveBalance({ joiningDay: "not-a-day", today: "2026-07-01", accrualPerMonth: 2 }), null);
});

test("a leave request needs an employee, a leave type and a real range", () => {
  assert.deepEqual(validateLeaveRequest({}).map((e) => e.field).sort(), ["fromDay", "leaveTypeId", "staffId", "toDay"]);
  assert.deepEqual(validateLeaveRequest({ staffId: "s1", leaveTypeId: "l1", fromDay: "2026-03-01", toDay: "2026-03-03" }), []);
});

test("a last day before the first day is refused", () => {
  const errs = validateLeaveRequest({ staffId: "s1", leaveTypeId: "l1", fromDay: "2026-03-05", toDay: "2026-03-01" });
  assert.equal(errs[0].code, "RANGE_BACKWARDS");
});
