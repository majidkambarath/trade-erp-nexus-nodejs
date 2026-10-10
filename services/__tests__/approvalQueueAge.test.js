// How long something has waited, counted in the organisation's own calendar days (Asia/Dubai here), not in UTC ones and not in
// 24-hour blocks. No database: the age is a pure function of two instants and the organisation's zone.
const test = require("node:test");
const assert = require("node:assert/strict");
const { ageInDays } = require("../core/approvalQueueService");

test("an age is whole calendar days in the organisation's zone", () => {
  const at = (s) => new Date(s);
  assert.equal(ageInDays(at("2026-10-08T05:00:00Z"), at("2026-10-08T17:00:00Z")), 0, "the same day");
  assert.equal(ageInDays(at("2026-10-07T21:00:00Z"), at("2026-10-08T01:00:00Z")), 0, "(01:00 and 05:00 on the 8th in Dubai: still the same day, though UTC says two)");
  assert.equal(ageInDays(at("2026-10-07T19:59:00Z"), at("2026-10-08T20:30:00Z")), 2, "23:59 on the 7th, to 00:30 on the 9th: two calendar days, though barely 25 hours");
  assert.equal(ageInDays(at("2026-10-05T22:30:00Z"), at("2026-10-08T10:00:00Z")), 2);
  assert.equal(ageInDays(at("2026-10-01T08:00:00Z"), at("2026-10-31T08:00:00Z")), 30);
});

test("never negative, and an unreadable date is 0 rather than a crash", () => {
  assert.equal(ageInDays(new Date("2026-10-09T08:00:00Z"), new Date("2026-10-08T08:00:00Z")), 0, "a document dated ahead of the clock");
  assert.equal(ageInDays(undefined), 0);
  assert.equal(ageInDays("not a date"), 0);
});
