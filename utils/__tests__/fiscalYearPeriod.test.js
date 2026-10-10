const test = require("node:test");
const assert = require("node:assert/strict");
const { instants } = require("../fiscalYearPeriod");
const tz = require("../tz");

const iso = (d) => d.toISOString();
const inside = (p, instant) => new Date(instant) >= p.startDate && new Date(instant) <= p.endDate;

test("a year made from plain days covers those days on the organisation's calendar (Dubai)", () => {
  const p = instants("2025-01-01", "2025-12-31", "Asia/Dubai");
  assert.equal(p.ok, true);
  assert.equal(iso(p.startDate), "2024-12-31T20:00:00.000Z", "00:00 on 1 January in Dubai");
  assert.equal(iso(p.endDate), "2025-12-31T19:59:59.999Z", "the last millisecond of 31 December in Dubai");
});

test("regression: the evening of the last day is inside the year (it used to end at 04:00 local)", () => {
  const p = instants("2025-01-01", "2025-12-31", "Asia/Dubai");
  assert.equal(inside(p, "2025-12-31T18:30:00.000Z"), true, "22:30 on 31 December in Dubai");
  assert.equal(inside(p, "2025-12-31T19:59:59.999Z"), true, "the last millisecond");
  assert.equal(inside(p, "2025-12-31T20:00:00.000Z"), false, "00:00 on 1 January belongs to the next year");
  assert.equal(inside(p, "2024-12-31T20:00:00.000Z"), true, "00:00 on 1 January, the first moment, is in");
  assert.equal(inside(p, "2024-12-31T19:59:59.999Z"), false, "the last moment of the year before is not");
  // the old reading, for the record: new Date("2025-12-31") is 04:00 on the 31st in Dubai
  assert.equal(iso(new Date("2025-12-31")), "2025-12-31T00:00:00.000Z");
  assert.ok(new Date("2025-12-31T18:30:00.000Z") > new Date("2025-12-31"), "what the old end date refused");
});

test("two years made the same way leave no hole between them and do not overlap", () => {
  const a = instants("2025-01-01", "2025-12-31", "Asia/Dubai");
  const b = instants("2026-01-01", "2026-12-31", "Asia/Dubai");
  assert.equal(b.startDate.getTime() - a.endDate.getTime(), 1, "the next year begins the millisecond after this one ends");
  // and it is the same pair the year-end close and provisioning make
  assert.equal(b.startDate.getTime(), tz.dayStart("2026-01-01", "Asia/Dubai").getTime());
  assert.equal(a.endDate.getTime(), tz.dayStart("2026-01-01", "Asia/Dubai").getTime() - 1);
});

test("another zone reads the same days on its own clock, daylight saving included", () => {
  const india = instants("2026-04-01", "2027-03-31", "Asia/Kolkata");
  assert.equal(iso(india.startDate), "2026-03-31T18:30:00.000Z");
  assert.equal(iso(india.endDate), "2027-03-31T18:29:59.999Z");
  const london = instants("2026-01-01", "2026-12-31", "Europe/London");
  assert.equal(iso(london.startDate), "2026-01-01T00:00:00.000Z", "GMT in January");
  assert.equal(iso(london.endDate), "2026-12-31T23:59:59.999Z", "GMT in December");
  const summer = instants("2026-06-01", "2026-08-31", "Europe/London");
  assert.equal(iso(summer.startDate), "2026-05-31T23:00:00.000Z", "BST in June");
});

test("a full timestamp or a Date is the instant it names, exactly as before", () => {
  const p = instants("2024-12-31T20:00:00.000Z", "2025-12-31T19:59:59.999Z", "Asia/Dubai");
  assert.equal(p.ok, true);
  assert.equal(iso(p.startDate), "2024-12-31T20:00:00.000Z");
  assert.equal(iso(p.endDate), "2025-12-31T19:59:59.999Z");
  const d = instants(new Date("2025-01-01T00:00:00Z"), new Date("2025-12-31T00:00:00Z"), "Asia/Dubai");
  assert.equal(d.ok, true);
  assert.equal(iso(d.startDate), "2025-01-01T00:00:00.000Z");
  assert.equal(iso(d.endDate), "2025-12-31T00:00:00.000Z");
});

test("a day with a time and a plain day mix: each is read as its own kind", () => {
  const p = instants("2025-01-01", "2025-12-31T10:00:00.000Z", "Asia/Dubai");
  assert.equal(p.ok, true);
  assert.equal(iso(p.startDate), "2024-12-31T20:00:00.000Z");
  assert.equal(iso(p.endDate), "2025-12-31T10:00:00.000Z");
});

test("an end that is not after the start is refused, whatever the kind of date", () => {
  assert.equal(instants("2025-12-31", "2025-01-01", "Asia/Dubai").ok, false);
  assert.equal(instants("2025-01-01", "2025-01-01", "Asia/Dubai").ok, false, "a year is not one day long (refused before as well)");
  assert.equal(instants("2025-06-01T00:00:00Z", "2025-06-01T00:00:00Z", "Asia/Dubai").ok, false);
  assert.equal(instants("2025-06-02T00:00:00Z", "2025-06-01T00:00:00Z", "Asia/Dubai").ok, false);
});

test("nonsense is refused, not stored", () => {
  assert.equal(instants("not a date", "2025-12-31", "Asia/Dubai").ok, false);
  assert.equal(instants("2025-01-01", "2025-02-30", "Asia/Dubai").ok, false, "a day that does not exist");
  assert.equal(instants(undefined, "2025-12-31", "Asia/Dubai").ok, false);
  assert.equal(instants("2025-01-01", null, "Asia/Dubai").ok, false);
  assert.equal(instants("2025-01-01", "", "Asia/Dubai").ok, false);
});

test("a leap day is a real day", () => {
  const p = instants("2028-03-01", "2029-02-28", "Asia/Dubai");
  assert.equal(p.ok, true);
  assert.equal(instants("2028-02-29", "2029-02-28", "Asia/Dubai").ok, true);
  assert.equal(instants("2027-02-29", "2028-02-28", "Asia/Dubai").ok, false);
});
