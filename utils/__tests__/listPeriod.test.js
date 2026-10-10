const test = require("node:test");
const assert = require("node:assert/strict");
const { listPeriod, condition } = require("../listPeriod");

const DUBAI = "Asia/Dubai";
const iso = (d) => (d ? d.toISOString() : null);
// 22:30 on Saturday 10 October 2026 in Dubai, which is 18:30 UTC the same day; and 01:30 on the 11th in Dubai (21:30 UTC the 10th)
const EVENING = new Date("2026-10-10T18:30:00.000Z");
const SMALL_HOURS = new Date("2026-10-10T21:30:00.000Z");

test("no period asked for means no bound", () => {
  assert.deepEqual(listPeriod({}, { zone: DUBAI, now: EVENING }), { gte: null, lte: null, error: null });
  assert.deepEqual(listPeriod({ dateFilter: "ALL" }, { zone: DUBAI, now: EVENING }), { gte: null, lte: null, error: null });
  assert.deepEqual(listPeriod({ dateFilter: "", dateFrom: "", dateTo: "" }, { zone: DUBAI, now: EVENING }), { gte: null, lte: null, error: null });
  assert.equal(condition({ gte: null, lte: null }), null);
});

test("TODAY is the organisation's day, not the server's: at 01:30 on the 11th in Dubai it is the 11th", () => {
  const evening = listPeriod({ dateFilter: "TODAY" }, { zone: DUBAI, now: EVENING });
  assert.equal(iso(evening.gte), "2026-10-09T20:00:00.000Z", "00:00 on the 10th in Dubai");
  assert.equal(iso(evening.lte), "2026-10-10T19:59:59.999Z", "the last millisecond of the 10th in Dubai");
  const night = listPeriod({ dateFilter: "TODAY" }, { zone: DUBAI, now: SMALL_HOURS });
  assert.equal(iso(night.gte), "2026-10-10T20:00:00.000Z", "a UTC clock would still say the 10th");
  assert.equal(iso(night.lte), "2026-10-11T19:59:59.999Z");
  // a document dated 11 October (stored at UTC midnight) is today's at that hour
  const doc = new Date("2026-10-11T00:00:00.000Z");
  assert.ok(doc >= night.gte && doc <= night.lte);
});

test("WEEK is the last seven days, today included, from the start of that day; MONTH is this month so far", () => {
  const week = listPeriod({ dateFilter: "WEEK" }, { zone: DUBAI, now: EVENING });
  assert.equal(iso(week.gte), "2026-10-03T20:00:00.000Z", "00:00 on 4 October (10th less six days) in Dubai");
  assert.equal(week.lte, null, "no upper bound, as before");
  const month = listPeriod({ dateFilter: "MONTH" }, { zone: DUBAI, now: EVENING });
  assert.equal(iso(month.gte), "2026-09-30T20:00:00.000Z", "00:00 on 1 October in Dubai");
  assert.equal(month.lte, null);
  // the first morning of a month, in the zone, is already the new month
  const first = listPeriod({ dateFilter: "MONTH" }, { zone: DUBAI, now: new Date("2026-10-31T21:30:00.000Z") });
  assert.equal(iso(first.gte), "2026-10-31T20:00:00.000Z", "01:30 on 1 November in Dubai");
});

test("the keyword is not case sensitive", () => {
  assert.deepEqual(listPeriod({ dateFilter: "today" }, { zone: DUBAI, now: EVENING }), listPeriod({ dateFilter: "TODAY" }, { zone: DUBAI, now: EVENING }));
});

test("CUSTOM needs both ends, and its last day is whole", () => {
  const p = listPeriod({ dateFilter: "CUSTOM", startDate: "2026-10-01", endDate: "2026-10-09" }, { zone: DUBAI, now: EVENING });
  assert.equal(p.error, null);
  assert.equal(iso(p.gte), "2026-09-30T20:00:00.000Z");
  assert.equal(iso(p.lte), "2026-10-09T19:59:59.999Z", "not 00:00 UTC on the 9th, which dropped the 9th after four in the morning");
  const evening9th = new Date("2026-10-09T15:00:00.000Z"); // 19:00 on the 9th in Dubai
  assert.ok(evening9th >= p.gte && evening9th <= p.lte, "a document of the 9th is in a range ending on the 9th");
  for (const q of [{ dateFilter: "CUSTOM" }, { dateFilter: "CUSTOM", startDate: "2026-10-01" }, { dateFilter: "CUSTOM", endDate: "2026-10-01" }]) {
    const bad = listPeriod(q, { zone: DUBAI, now: EVENING });
    assert.equal(bad.error.code, "DATE_RANGE_REQUIRED");
  }
});

test("dateFrom / dateTo are a range of days, the last day whole", () => {
  const p = listPeriod({ dateFrom: "2026-10-05", dateTo: "2026-10-05" }, { zone: DUBAI, now: EVENING });
  assert.equal(iso(p.gte), "2026-10-04T20:00:00.000Z");
  assert.equal(iso(p.lte), "2026-10-05T19:59:59.999Z", "one day is a whole day, not an empty range");
  const open = listPeriod({ dateFrom: "2026-10-05" }, { zone: DUBAI, now: EVENING });
  assert.equal(open.lte, null);
  const upTo = listPeriod({ dateTo: "2026-10-05" }, { zone: DUBAI, now: EVENING });
  assert.equal(upTo.gte, null);
  assert.deepEqual(condition(upTo), { $lte: upTo.lte });
});

test("a full timestamp bound is the instant it names", () => {
  const p = listPeriod({ dateFrom: "2026-10-05T10:00:00.000Z", dateTo: "2026-10-06T10:00:00.000Z" }, { zone: DUBAI, now: EVENING });
  assert.equal(iso(p.gte), "2026-10-05T10:00:00.000Z");
  assert.equal(iso(p.lte), "2026-10-06T10:00:00.000Z");
});

test("a preset and an explicit range narrow each other", () => {
  const p = listPeriod({ dateFilter: "WEEK", dateFrom: "2026-10-07", dateTo: "2026-10-20" }, { zone: DUBAI, now: EVENING });
  assert.equal(iso(p.gte), "2026-10-06T20:00:00.000Z", "the later of the two starts");
  assert.equal(iso(p.lte), "2026-10-20T19:59:59.999Z");
  const t = listPeriod({ dateFilter: "TODAY", dateFrom: "2026-01-01", dateTo: "2026-12-31" }, { zone: DUBAI, now: EVENING });
  assert.equal(iso(t.gte), "2026-10-09T20:00:00.000Z");
  assert.equal(iso(t.lte), "2026-10-10T19:59:59.999Z", "the earlier of the two ends");
});

test("a bound that is not a date is an error, never a dropped filter", () => {
  assert.equal(listPeriod({ dateFrom: "banana" }, { zone: DUBAI, now: EVENING }).error.code, "INVALID_DATE");
  assert.equal(listPeriod({ dateTo: "2026-02-30" }, { zone: DUBAI, now: EVENING }).error.code, "INVALID_DATE");
  assert.equal(listPeriod({ dateFilter: "CUSTOM", startDate: "x", endDate: "2026-01-01" }, { zone: DUBAI, now: EVENING }).error.code, "INVALID_DATE");
  assert.equal(listPeriod({ dateFilter: "FORTNIGHT" }, { zone: DUBAI, now: EVENING }).error.code, "INVALID_DATE_FILTER");
  assert.match(listPeriod({ dateTo: "banana" }, { zone: DUBAI, now: EVENING }).error.message, /dateTo/);
});

test("the same request reads differently in another zone", () => {
  const london = listPeriod({ dateFrom: "2026-07-01", dateTo: "2026-07-01" }, { zone: "Europe/London", now: EVENING });
  assert.equal(iso(london.gte), "2026-06-30T23:00:00.000Z", "BST");
  assert.equal(iso(london.lte), "2026-07-01T22:59:59.999Z");
});
