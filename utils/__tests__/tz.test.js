const test = require("node:test");
const assert = require("node:assert/strict");
const tz = require("../tz");

const iso = (d) => d.toISOString();

test("which calendar day an instant falls on depends on the zone", () => {
  const instant = new Date("2026-10-08T21:00:00Z"); // 01:00 on the 9th in Dubai, 22:00 on the 8th in London
  assert.equal(tz.dayOf(instant, "Asia/Dubai"), "2026-10-09");
  assert.equal(tz.dayOf(instant, "Europe/London"), "2026-10-08");
  assert.equal(tz.dayOf(instant, "Asia/Kolkata"), "2026-10-09"); // 02:30 on the 9th
  assert.equal(tz.dayOf(instant, "UTC"), "2026-10-08");
});

test("a plain day is already a day, and nonsense is not one", () => {
  assert.equal(tz.dayOf("2026-02-28", "Asia/Dubai"), "2026-02-28");
  assert.equal(tz.dayOf(" 2026-02-28 ", "Asia/Tokyo"), "2026-02-28");
  assert.equal(tz.dayOf("not a date", "Asia/Dubai"), null);
  assert.equal(tz.dayOf(NaN, "Asia/Dubai"), null);
  assert.equal(tz.dayOf("2026-10-08T21:00:00Z", "Asia/Dubai"), "2026-10-09", "a full timestamp is read in the zone");
  assert.equal(tz.todayIn("Asia/Dubai", "2026-03-01"), "2026-03-01");
});

test("a zone the caller got wrong counts in UTC rather than throwing in the middle of a report", () => {
  assert.equal(tz.dayOf(new Date("2026-10-08T21:00:00Z"), "Nowhere/Land"), "2026-10-08");
  assert.equal(iso(tz.dayStart("2026-10-09", "Nowhere/Land")), "2026-10-09T00:00:00.000Z");
});

test("a day begins and ends at the zone's own midnight (Dubai, India, Japan)", () => {
  assert.equal(iso(tz.dayStart("2026-10-09", "Asia/Dubai")), "2026-10-08T20:00:00.000Z");
  assert.equal(iso(tz.dayEnd("2026-10-09", "Asia/Dubai")), "2026-10-09T20:00:00.000Z");
  assert.equal(iso(tz.endOfDay("2026-10-09", "Asia/Dubai")), "2026-10-09T19:59:59.999Z");
  assert.equal(iso(tz.dayStart("2026-10-09", "Asia/Kolkata")), "2026-10-08T18:30:00.000Z", "a half-hour zone");
  assert.equal(iso(tz.dayStart("2026-10-09", "Asia/Tokyo")), "2026-10-08T15:00:00.000Z");
  assert.equal(iso(tz.noonOf("2026-10-09", "Asia/Dubai")), "2026-10-09T08:00:00.000Z");
});

test("clocks changing: a day is 23 hours long in spring and 25 in autumn, and still begins at midnight", () => {
  // Europe/London: forward on 29 March 2026 (00:00 GMT -> 01:00 BST), back on 25 October 2026 (02:00 BST -> 01:00 GMT)
  assert.equal(iso(tz.dayStart("2026-03-29", "Europe/London")), "2026-03-29T00:00:00.000Z");
  assert.equal(iso(tz.dayEnd("2026-03-29", "Europe/London")), "2026-03-29T23:00:00.000Z");
  assert.equal(iso(tz.dayStart("2026-10-25", "Europe/London")), "2026-10-24T23:00:00.000Z");
  assert.equal(iso(tz.dayEnd("2026-10-25", "Europe/London")), "2026-10-26T00:00:00.000Z");
  assert.equal(tz.offsetMinutes(new Date("2026-01-15T12:00:00Z"), "Europe/London"), 0);
  assert.equal(tz.offsetMinutes(new Date("2026-07-15T12:00:00Z"), "Europe/London"), 60);
  assert.equal(tz.offsetMinutes(new Date("2026-07-15T12:00:00Z"), "Asia/Dubai"), 240, "Dubai never changes");
  assert.equal(tz.offsetMinutes(new Date("2026-07-15T12:00:00Z"), "Asia/Kolkata"), 330);
});

test("the calendar year is the zone's year, so the New Year arrives when the zone says", () => {
  assert.equal(tz.yearOf(new Date("2026-12-31T21:00:00Z"), "Asia/Dubai"), 2027);
  assert.equal(tz.yearOf(new Date("2026-12-31T21:00:00Z"), "Europe/London"), 2026);
});

test("every day begins where the previous one ended, in every zone, across the year", () => {
  const zones = ["Asia/Dubai", "Asia/Kolkata", "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Pacific/Auckland", "Africa/Cairo", "UTC"];
  for (const zone of zones) {
    let day = "2026-01-01";
    for (let i = 0; i < 366; i++) {
      const next = tz.addDays(day, 1);
      const start = tz.dayStart(day, zone);
      assert.equal(tz.dayOf(start, zone), day, `${zone} ${day}: the start is on the day`);
      assert.equal(tz.dayOf(new Date(start.getTime() - 1), zone), tz.addDays(day, -1), `${zone} ${day}: a millisecond earlier is the day before`);
      assert.equal(tz.dayEnd(day, zone).getTime(), tz.dayStart(next, zone).getTime(), `${zone} ${day}: ends where the next begins`);
      assert.equal(tz.dayOf(tz.endOfDay(day, zone), zone), day, `${zone} ${day}: the last millisecond is still the day`);
      day = next;
    }
  }
});

test("calendar arithmetic on days involves no zone", () => {
  assert.equal(tz.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(tz.addDays("2028-02-28", 1), "2028-02-29");
  assert.equal(tz.addDays("2027-02-28", 1), "2027-03-01");
  assert.equal(tz.addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(tz.monthStartDay("2026-10-09"), "2026-10-01");
  assert.throws(() => tz.dayStart("tomorrow", "Asia/Dubai"));
});

test("only zones that are never west of UTC are supported, and a made-up one is refused", () => {
  for (const ok of ["Asia/Dubai", "Asia/Kolkata", "Europe/London", "Europe/Berlin", "Asia/Tokyo", "Pacific/Auckland", "Africa/Cairo", "UTC", "Asia/Riyadh"]) {
    assert.equal(tz.supportedZone(ok).ok, true, ok);
  }
  for (const west of ["America/New_York", "America/Los_Angeles", "America/Sao_Paulo", "Pacific/Honolulu"]) {
    const r = tz.supportedZone(west);
    assert.equal(r.ok, false, west);
    assert.match(r.reason, /west of UTC/);
  }
  assert.equal(tz.supportedZone("Mars/Phobos").ok, false);
  assert.equal(tz.supportedZone("").ok, false);
  assert.equal(tz.validZone("Asia/Dubai"), true);
  assert.equal(tz.validZone("Mars/Phobos"), false);
});
