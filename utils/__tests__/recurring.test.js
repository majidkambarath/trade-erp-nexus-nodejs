// node --test utils/__tests__/recurring.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const r = require("../recurring");

const monthly = (startDay, extra = {}) => ({ frequency: "monthly", interval: 1, startDay, ...extra });

test("monthly runs keep the start's day and clamp it to a short month, without drifting", () => {
  const s = monthly("2026-01-31");
  assert.deepEqual([0, 1, 2, 3, 13].map((k) => r.runDay(s, k)), ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2027-02-28"]);
  assert.equal(r.runDay(monthly("2027-01-29"), 13), "2028-02-29");
});

test("weekly, every two weeks, quarterly and yearly", () => {
  assert.deepEqual(r.upcoming({ frequency: "weekly", interval: 2, startDay: "2026-12-28" }, 0, 3), ["2026-12-28", "2027-01-11", "2027-01-25"]);
  assert.deepEqual(r.upcoming({ frequency: "quarterly", interval: 1, startDay: "2026-11-30" }, 0, 3), ["2026-11-30", "2027-02-28", "2027-05-30"]);
  assert.deepEqual(r.upcoming({ frequency: "yearly", interval: 1, startDay: "2028-02-29" }, 0, 2), ["2028-02-29", "2029-02-28"]);
  assert.equal(r.describe({ frequency: "monthly", interval: 1 }), "Every month");
  assert.equal(r.describe({ frequency: "weekly", interval: 2 }), "Every 2 weeks");
});

test("a schedule is checked: frequency, interval, real days, end after start, a sensible count", () => {
  const bad = (input, field) => assert.throws(() => r.validateSchedule(input), (e) => e.code === "INVALID_SCHEDULE" && e.field === field);
  bad({ frequency: "daily", startDay: "2026-01-01" }, "frequency");
  bad({ frequency: "monthly", interval: 13, startDay: "2026-01-01" }, "interval");
  bad({ frequency: "monthly", interval: 1.5, startDay: "2026-01-01" }, "interval");
  bad({ frequency: "monthly", startDay: "2026-02-30" }, "startDay");
  bad({ frequency: "monthly", startDay: "2026-03-01", endDay: "2026-02-01" }, "endDay");
  bad({ frequency: "monthly", startDay: "2026-03-01", maxCount: 0 }, "maxCount");
  assert.deepEqual(r.validateSchedule({ frequency: "monthly", startDay: "2026-03-01", maxCount: "3", endDay: "" }), { frequency: "monthly", interval: 1, startDay: "2026-03-01", maxCount: 3 });
});

test("the runs owed up to today, capped, stopping at the end day or the number of invoices", () => {
  const s = monthly("2026-01-10");
  assert.deepEqual(r.dueRuns(s, 0, "2026-03-09"), [{ day: "2026-01-10", k: 0 }, { day: "2026-02-10", k: 1 }]);
  assert.deepEqual(r.dueRuns(s, 2, "2026-03-10"), [{ day: "2026-03-10", k: 2 }]);
  assert.equal(r.dueRuns(s, 0, "2029-01-01").length, 12, "a year at most in one pass");
  assert.equal(r.dueRuns(monthly("2026-01-10", { maxCount: 2 }), 0, "2026-12-31").length, 2);
  assert.equal(r.dueRuns(monthly("2026-01-10", { endDay: "2026-03-01" }), 0, "2026-12-31").length, 2);
  assert.equal(r.nextRun(monthly("2026-01-10", { maxCount: 2 }), 2), null);
  assert.equal(r.nextRun(monthly("2026-01-10", { endDay: "2026-03-10" }), 2), "2026-03-10");
});

test("a pause skips its slots without spending the number of invoices", () => {
  const s = monthly("2026-01-10", { maxCount: 3 });
  // one made in January, paused until mid-April: carries on from 10 May, and still makes two more
  const k = r.resumeFrom(s, 1, "2026-04-15", 1);
  assert.equal(r.runDay(s, k), "2026-05-10");
  assert.deepEqual(r.upcoming(s, k, 5, 1), ["2026-05-10", "2026-06-10"]);
  assert.equal(r.resumeFrom(monthly("2026-01-10", { endDay: "2026-02-01" }), 1, "2026-04-15", 1), null);
});

test("an edited schedule carries on after the last invoice made", () => {
  const s = monthly("2026-01-31");
  assert.equal(r.cursorAfter(s, null), 0);
  assert.equal(r.runDay(s, r.cursorAfter(s, "2026-02-28")), "2026-03-31");
  assert.equal(r.runDay({ frequency: "weekly", interval: 1, startDay: "2026-01-01" }, r.cursorAfter({ frequency: "weekly", interval: 1, startDay: "2026-01-01" }, "2026-01-20")), "2026-01-22");
});
