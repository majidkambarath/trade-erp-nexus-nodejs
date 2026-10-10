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

test("a plain day in a request is that day on the zone's calendar: whole at the end, from midnight at the start", () => {
  assert.equal(iso(tz.boundOf("2026-10-09", "start", "Asia/Dubai")), "2026-10-08T20:00:00.000Z");
  assert.equal(iso(tz.boundOf("2026-10-09", "end", "Asia/Dubai")), "2026-10-09T19:59:59.999Z");
  assert.equal(iso(tz.boundOf(" 2026-10-09 ", "end", "Asia/Dubai")), "2026-10-09T19:59:59.999Z", "spaces are not part of a day");
  assert.equal(iso(tz.boundOf("2026-10-09", "end", "UTC")), "2026-10-09T23:59:59.999Z");
  // what `new Date(day)` said, and why it was wrong as the end of a range in Dubai
  assert.equal(iso(new Date("2026-10-09")), "2026-10-09T00:00:00.000Z");
  assert.ok(tz.boundOf("2026-10-09", "end", "Asia/Dubai") > new Date("2026-10-09T10:00:00.000Z"), "14:00 on the 9th is inside a range ending on the 9th");
  // the last day of a range is whole in a zone with clock changes too (a 25-hour day)
  assert.equal(iso(tz.boundOf("2026-10-25", "end", "Europe/London")), "2026-10-25T23:59:59.999Z");
  assert.equal(iso(tz.boundOf("2026-10-25", "start", "Europe/London")), "2026-10-24T23:00:00.000Z");
});

test("anything that is not a plain day is the instant it names; nothing given is null; nonsense is an Invalid Date", () => {
  assert.equal(iso(tz.boundOf("2026-10-09T10:00:00.000Z", "end", "Asia/Dubai")), "2026-10-09T10:00:00.000Z");
  assert.equal(iso(tz.boundOf(new Date("2026-10-09T10:00:00.000Z"), "start", "Asia/Dubai")), "2026-10-09T10:00:00.000Z");
  assert.equal(iso(tz.boundOf(Date.UTC(2026, 9, 9, 10), "start", "Asia/Dubai")), "2026-10-09T10:00:00.000Z");
  assert.equal(tz.boundOf(undefined, "end", "Asia/Dubai"), null);
  assert.equal(tz.boundOf(null, "end", "Asia/Dubai"), null);
  assert.equal(tz.boundOf("  ", "end", "Asia/Dubai"), null);
  assert.ok(Number.isNaN(tz.boundOf("banana", "end", "Asia/Dubai").getTime()));
  assert.ok(Number.isNaN(tz.boundOf("2026-02-30", "end", "Asia/Dubai").getTime()), "30 February has the shape of a day and is not one");
});

test("a date and time with no zone is wall-clock time on the zone's clock, not the server's", () => {
  // what the trial balance screen sends as the end of its range
  assert.equal(iso(tz.boundOf("2026-12-31T23:59:59.999", "end", "Asia/Dubai")), "2026-12-31T19:59:59.999Z");
  assert.equal(iso(tz.boundOf("2026-12-31T23:59:59.999", "end", "UTC")), "2026-12-31T23:59:59.999Z");
  assert.equal(iso(tz.boundOf("2026-10-09T08:30", "start", "Asia/Dubai")), "2026-10-09T04:30:00.000Z");
  assert.equal(iso(tz.boundOf("2026-10-09 08:30:15", "start", "Asia/Dubai")), "2026-10-09T04:30:15.000Z", "a space works as the T");
  assert.equal(iso(tz.boundOf("2026-10-09T08:30:15.5", "start", "Asia/Dubai")), "2026-10-09T04:30:15.500Z");
  assert.equal(iso(tz.boundOf("2026-07-01T23:59:59.999", "end", "Europe/London")), "2026-07-01T22:59:59.999Z", "BST");
  // a zone written on the value is respected as written
  assert.equal(iso(tz.boundOf("2026-12-31T23:59:59.999Z", "end", "Asia/Dubai")), "2026-12-31T23:59:59.999Z");
  assert.equal(iso(tz.boundOf("2026-12-31T23:59:59.999+04:00", "end", "UTC")), "2026-12-31T19:59:59.999Z");
  // nonsense inside the shape
  assert.ok(Number.isNaN(tz.boundOf("2026-02-30T10:00:00", "end", "Asia/Dubai").getTime()));
  assert.ok(Number.isNaN(tz.boundOf("2026-10-09T25:00:00", "end", "Asia/Dubai").getTime()));
  assert.ok(Number.isNaN(tz.boundOf("2026-10-09T10:61:00", "end", "Asia/Dubai").getTime()));
});

test("which days exist", () => {
  assert.equal(tz.isRealDay("2026-02-28"), true);
  assert.equal(tz.isRealDay("2028-02-29"), true);
  assert.equal(tz.isRealDay("2027-02-29"), false);
  assert.equal(tz.isRealDay("2026-13-01"), false);
  assert.equal(tz.isRealDay("2026-00-10"), false);
  assert.equal(tz.isRealDay("2026-4-1"), false);
  assert.equal(tz.isRealDay("0050-01-01"), false);
  assert.equal(tz.isRealDay(null), false);
});
