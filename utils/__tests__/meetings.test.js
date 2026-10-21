// The meeting rules, and above all the invitation itself: an .ics with one character out of place is a meeting that
// lands in the customer's calendar at the wrong hour, or not at all.
const test = require("node:test");
const assert = require("node:assert/strict");
const m = require("../meetings");

const ID = "a".repeat(24);
const ID2 = "b".repeat(24);
const STAMP = new Date("2026-10-21T10:00:00Z");
const lines = (ics) => ics.split("\r\n");
const lineOf = (ics, prefix) => lines(ics).find((l) => l.startsWith(prefix));
// an unfolded copy: a continuation line starts with one space, and joining them back is how a calendar reads it
const unfolded = (ics) => ics.replace(/\r\n /g, "");

const base = (over = {}) => ({
  uid: "crm-1@zarvia",
  sequence: 0,
  method: "REQUEST",
  start: new Date("2026-11-03T10:30:00Z"),
  end: new Date("2026-11-03T11:00:00Z"),
  subject: "Price review",
  organiser: { name: "Asif Rahman", email: "asif@zarvia.test" },
  attendees: [{ name: "Hassan Al Noor", email: "hassan@alnoor.test" }],
  stamp: STAMP,
  ...over,
});

// ---- when a meeting is -----------------------------------------------------------------------------------------

test("a time on the organisation's clock becomes the right instant, and gives its day back", () => {
  const dubai = m.startInstant("2026-11-03", "14:30", "Asia/Dubai"); // UTC+4
  assert.equal(dubai.toISOString(), "2026-11-03T10:30:00.000Z");
  assert.equal(m.dayOfMeeting(dubai, "Asia/Dubai"), "2026-11-03", "the day dueAt is written from");

  const india = m.startInstant("2026-11-03", "14:30", "Asia/Kolkata"); // UTC+5:30, the half hour that catches naive maths
  assert.equal(india.toISOString(), "2026-11-03T09:00:00.000Z");

  // late in the evening in Dubai is still the same day there, though it is the previous day in UTC
  const late = m.startInstant("2026-11-03", "02:00", "Asia/Dubai");
  assert.equal(late.toISOString(), "2026-11-02T22:00:00.000Z");
  assert.equal(m.dayOfMeeting(late, "Asia/Dubai"), "2026-11-03", "the day is the organisation's, never UTC's");
});

test("a time that is not a time is refused rather than guessed", () => {
  for (const bad of ["25:00", "14:60", "2:30", "", "noon", null, { $ne: "x" }, ["14:30"]]) {
    assert.equal(m.timeOf(bad), null, JSON.stringify(bad));
    assert.equal(m.startInstant("2026-11-03", bad, "Asia/Dubai"), null);
  }
  assert.equal(m.startInstant("2026-02-30", "14:30", "Asia/Dubai"), null, "a day that does not exist");
  assert.equal(m.timeOf("00:00"), "00:00", "midnight is a time");
  assert.equal(m.timeOf("23:59"), "23:59");
});

test("the end is the start plus the minutes, and the length reads back", () => {
  const start = new Date("2026-11-03T10:30:00Z");
  assert.equal(m.endInstant(start, 45).toISOString(), "2026-11-03T11:15:00.000Z");
  assert.equal(m.minutesBetween(start, m.endInstant(start, 90)), 90);
  assert.equal(m.endInstant(null, 30), null);
});

// ---- validation ------------------------------------------------------------------------------------------------

const good = (over = {}) => ({ subject: "Price review", day: "2026-11-03", time: "14:30", minutes: 30, where: "online", attendees: [{ kind: "contact", id: ID }], ...over });
const codes = (input, opts) => m.validateMeeting(input, { zone: "Asia/Dubai", ...opts }).map((e) => e.code);

test("a good meeting passes, and each missing piece is named", () => {
  assert.deepEqual(codes(good()), []);
  assert.deepEqual(codes(good({ subject: "" })), ["MEETING_SUBJECT_REQUIRED"]);
  assert.deepEqual(codes(good({ day: "not a day" })), ["MEETING_DAY_INVALID"]);
  assert.deepEqual(codes(good({ time: "9am" })), ["MEETING_TIME_INVALID"]);
  assert.deepEqual(codes(good({ attendees: [] })), ["MEETING_ATTENDEES_REQUIRED"]);
});

test("a meeting is between five minutes and twelve hours long", () => {
  assert.deepEqual(codes(good({ minutes: 4 })), ["MEETING_TOO_SHORT"]);
  assert.deepEqual(codes(good({ minutes: m.MIN_MINUTES })), [], "the floor itself is allowed");
  assert.deepEqual(codes(good({ minutes: m.MAX_MINUTES })), []);
  assert.deepEqual(codes(good({ minutes: m.MAX_MINUTES + 1 })), ["MEETING_TOO_LONG"]);
  assert.deepEqual(codes(good({ minutes: 0 })), ["MEETING_TOO_SHORT"]);
});

test("only an http link may be put in somebody's calendar", () => {
  assert.deepEqual(codes(good({ joinUrl: "https://meet.example.com/abc" })), []);
  assert.deepEqual(codes(good({ joinUrl: "http://meet.example.com/abc" })), []);
  assert.deepEqual(codes(good({ joinUrl: "" })), [], "booking first and pasting the link later is normal");
  for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "meet.example.com", "ftp://x.test/a"]) {
    assert.deepEqual(codes(good({ joinUrl: bad })), ["MEETING_LINK_INVALID"], bad);
    assert.equal(m.joinUrlOf(bad), "", bad);
  }
});

test("an attendee is somebody we hold, and fifty is as many as one meeting takes", () => {
  assert.deepEqual(codes(good({ attendees: [{ kind: "user", id: ID }, { kind: "contact", id: ID2 }] })), []);
  assert.deepEqual(codes(good({ attendees: [{ kind: "stranger", id: ID }] })), ["MEETING_ATTENDEE_INVALID"]);
  assert.deepEqual(codes(good({ attendees: [{ kind: "contact", id: "nope" }] })), ["MEETING_ATTENDEE_INVALID"]);
  const many = Array.from({ length: 51 }, () => ({ kind: "contact", id: ID }));
  assert.deepEqual(codes(good({ attendees: many })), ["MEETING_TOO_MANY"]);
});

test("a zone the server cannot store days in is refused, with the reason", () => {
  const bad = m.validateMeeting(good({ zone: "America/New_York" }), { zone: "America/New_York" });
  assert.equal(bad[0].code, "MEETING_ZONE_INVALID");
  assert.match(bad[0].message, /west of UTC/i);
  assert.deepEqual(codes(good({ zone: "Asia/Kolkata" }), { zone: "Asia/Kolkata" }), []);
});

test("a reschedule may send only the new time", () => {
  assert.deepEqual(m.validateMeeting({ day: "2026-11-04", time: "09:00" }, { partial: true, zone: "Asia/Dubai" }).map((e) => e.code), []);
  assert.deepEqual(m.validateMeeting({ time: "nope" }, { partial: true, zone: "Asia/Dubai" }).map((e) => e.code), ["MEETING_TIME_INVALID"]);
});

test("nothing a request body carries reaches a field as anything but text", () => {
  const hostile = { subject: { $ne: "x" }, day: ["2026-11-03"], time: {}, minutes: "lots", where: {}, joinUrl: { $gt: "" }, attendees: "all of them" };
  const out = codes(hostile);
  assert.ok(out.includes("MEETING_SUBJECT_REQUIRED") && out.includes("MEETING_DAY_INVALID") && out.includes("MEETING_ATTENDEES_REQUIRED"));
  assert.equal(m.text({ $ne: "x" }), "");
  assert.equal(m.num("lots"), 0);
});

test("what is stored is coerced, and an in-person meeting keeps no join link", () => {
  const stored = m.normaliseMeeting(good({ where: "in_person", location: "Deira office", joinUrl: "https://meet.example.com/x" }), { zone: "Asia/Dubai", attendees: [], uid: "u1" });
  assert.equal(stored.where, "in_person");
  assert.equal(stored.location, "Deira office");
  assert.equal(stored.joinUrl, "", "a room is not a web address");
  assert.equal(stored.startAt.toISOString(), "2026-11-03T10:30:00.000Z");
  assert.equal(stored.endAt.toISOString(), "2026-11-03T11:00:00.000Z");
  assert.equal(stored.timezone, "Asia/Dubai");
  assert.equal(m.normaliseMeeting(good({ minutes: 0 }), { zone: "Asia/Dubai" }).endAt.toISOString(), "2026-11-03T11:00:00.000Z", "no minutes falls back to the default");
});

// ---- clashes ---------------------------------------------------------------------------------------------------

const other = (id, from, to, over = {}) => ({ _id: id, subject: `Other ${id}`, meeting: { startAt: new Date(from), endAt: new Date(to), ...over } });

test("an overlap is reported, a touching end is not, and nothing clashes with itself", () => {
  const mine = { id: "m1", startAt: new Date("2026-11-03T10:30:00Z"), endAt: new Date("2026-11-03T11:00:00Z") };
  const found = m.clashesWith(mine, [
    other("o1", "2026-11-03T10:45:00Z", "2026-11-03T11:15:00Z"), // overlaps the end
    other("o2", "2026-11-03T11:00:00Z", "2026-11-03T11:30:00Z"), // starts exactly as mine ends
    other("o3", "2026-11-03T10:00:00Z", "2026-11-03T10:30:00Z"), // ends exactly as mine starts
    other("o4", "2026-11-03T10:00:00Z", "2026-11-03T12:00:00Z"), // swallows mine
    other("o5", "2026-11-03T10:40:00Z", "2026-11-03T10:50:00Z", { cancelled: false }), // inside mine
    other("o6", "2026-11-03T10:40:00Z", "2026-11-03T10:50:00Z", { cancelledAt: new Date() }), // called off
    other("m1", "2026-11-03T10:30:00Z", "2026-11-03T11:00:00Z"), // itself
  ]);
  assert.deepEqual(found.map((f) => f.id), ["o1", "o4", "o5"]);
  assert.equal(found[0].subject, "Other o1");
  assert.deepEqual(m.clashesWith({ startAt: null, endAt: null }, [other("o1", "2026-11-03T10:45:00Z", "2026-11-03T11:15:00Z")]), []);
  assert.deepEqual(m.clashesWith(mine, "not a list"), []);
});

// ---- the invitation --------------------------------------------------------------------------------------------

test("the invitation is a well-formed iCalendar request", () => {
  const ics = m.buildIcs(base());
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"), "a trailing CRLF, or a strict calendar refuses the file");
  assert.ok(!/[^\r]\n/.test(ics), "CRLF everywhere: a bare newline can fail the whole file");
  assert.equal(lineOf(ics, "METHOD:"), "METHOD:REQUEST");
  assert.equal(lineOf(ics, "UID:"), "UID:crm-1@zarvia");
  assert.equal(lineOf(ics, "DTSTAMP:"), "DTSTAMP:20261021T100000Z");
  assert.equal(lineOf(ics, "DTSTART:"), "DTSTART:20261103T103000Z", "UTC, which every calendar reads the same way");
  assert.equal(lineOf(ics, "DTEND:"), "DTEND:20261103T110000Z");
  assert.equal(lineOf(ics, "SEQUENCE:"), "SEQUENCE:0");
  assert.equal(lineOf(ics, "STATUS:"), "STATUS:CONFIRMED");
  assert.match(unfolded(ics), /ORGANIZER;CN=Asif Rahman:mailto:asif@zarvia\.test/);
  assert.match(unfolded(ics), /ATTENDEE;[^\r]*RSVP=TRUE;CN=Hassan Al Noor:mailto:hassan@alnoor\.test/, "RSVP=TRUE is what asks the calendar for an answer");
  assert.ok(ics.includes("BEGIN:VALARM"), "a reminder, as a person expects of a calendar");
});

test("every line is at most 75 OCTETS, folded with a leading space, never cutting a character in half", () => {
  const ics = m.buildIcs(base({ subject: "A very long subject indeed, long enough that it must be folded across more than one line to be valid" }));
  for (const line of lines(ics)) assert.ok(Buffer.from(line, "utf8").length <= 75, `too long: ${line}`);
  assert.ok(lines(ics).some((l) => l.startsWith(" ")), "it did fold");
  assert.match(unfolded(ics), /SUMMARY:A very long subject indeed\\, long enough/, "and unfolds to the original");

  // Arabic is multi-byte: folding by character length would split one character and arrive as mojibake
  const arabic = "اجتماع لمراجعة الأسعار مع شركة النور للمواد الغذائية في دبي بعد الظهر";
  const wide = m.buildIcs(base({ subject: arabic }));
  for (const line of lines(wide)) assert.ok(Buffer.from(line, "utf8").length <= 75, "an Arabic subject folds by bytes");
  assert.ok(unfolded(wide).includes(`SUMMARY:${arabic}`), "and comes back whole");
});

test("the characters iCalendar reserves are escaped", () => {
  const ics = m.buildIcs(base({ subject: "Price review, 200 bags; half-price", description: "Line one\nLine two", location: "Deira, Dubai" }));
  const flat = unfolded(ics);
  assert.ok(flat.includes("SUMMARY:Price review\\, 200 bags\\; half-price"), "a comma and a semicolon");
  assert.ok(flat.includes("DESCRIPTION:Line one\\nLine two"), "a newline becomes \\n, never a real break");
  assert.ok(flat.includes("LOCATION:Deira\\, Dubai"));
  assert.ok(m.icsValue("a\\b").includes("\\\\"), "a backslash is escaped first, or every other escape doubles");
});

test("a change keeps the UID and raises the sequence; a cancellation says so in three places", () => {
  const first = m.buildIcs(base({ sequence: 0 }));
  const moved = m.buildIcs(base({ sequence: 1, start: new Date("2026-11-04T10:30:00Z"), end: new Date("2026-11-04T11:00:00Z") }));
  assert.equal(lineOf(first, "UID:"), lineOf(moved, "UID:"), "the same meeting, or the calendar files a second one");
  assert.equal(lineOf(moved, "SEQUENCE:"), "SEQUENCE:1", "a higher sequence, or the change is ignored");
  assert.equal(lineOf(moved, "DTSTART:"), "DTSTART:20261104T103000Z");

  const off = m.buildIcs(base({ sequence: 2, method: "CANCEL" }));
  assert.equal(lineOf(off, "METHOD:"), "METHOD:CANCEL");
  assert.equal(lineOf(off, "STATUS:"), "STATUS:CANCELLED");
  assert.equal(lineOf(off, "UID:"), lineOf(first, "UID:"));
  assert.ok(!off.includes("BEGIN:VALARM"), "nothing to be reminded of");
});

test("the place is the link online and the address in person", () => {
  const online = m.buildIcs(base({ joinUrl: "https://meet.example.com/abc-defg", location: "" }));
  assert.equal(lineOf(online, "LOCATION:"), "LOCATION:https://meet.example.com/abc-defg");
  assert.equal(lineOf(online, "URL:"), "URL:https://meet.example.com/abc-defg");
  const room = m.buildIcs(base({ joinUrl: "", location: "Deira office" }));
  assert.equal(lineOf(room, "LOCATION:"), "LOCATION:Deira office");
  assert.equal(lineOf(room, "URL:"), undefined, "no link, no URL line");
});

test("an invitation that could not be built is null, never half a file", () => {
  assert.equal(m.buildIcs(base({ uid: "" })), null);
  assert.equal(m.buildIcs(base({ start: null })), null);
  assert.equal(m.buildIcs(base({ start: new Date("nonsense") })), null);
  assert.equal(m.buildIcs({}), null);
});

test("an attendee with no email is left out rather than written as a broken line", () => {
  const ics = m.buildIcs(base({ attendees: [{ name: "No Address" }, { name: "Real", email: "real@x.test" }] }));
  assert.equal(lines(ics).filter((l) => l.startsWith("ATTENDEE")).length, 1);
  assert.match(unfolded(ics), /CN=Real:mailto:real@x\.test/);
});

// ---- what a person reads ----------------------------------------------------------------------------------------

test("a time reads on the organisation's clock, not UTC's", () => {
  const start = new Date("2026-11-03T10:30:00Z");
  const end = new Date("2026-11-03T11:00:00Z");
  assert.equal(m.timeIn(start, "Asia/Dubai"), "14:30");
  assert.equal(m.timeRange(start, end, "Asia/Dubai"), "14:30 - 15:00");
  assert.equal(m.timeRange(start, end, "Asia/Kolkata"), "16:00 - 16:30");
  assert.equal(m.timeRange(start, end, "UTC"), "10:30 - 11:00");
  assert.equal(m.timeIn(null, "Asia/Dubai"), "");
});

test("the invitation's words name the zone, so nobody abroad has to guess", () => {
  const body = m.inviteText({
    subject: "Price review",
    startAt: new Date("2026-11-03T10:30:00Z"),
    endAt: new Date("2026-11-03T11:00:00Z"),
    zone: "Asia/Dubai",
    joinUrl: "https://meet.example.com/abc",
    organiserName: "Asif Rahman",
    note: "Bring the new price list.",
  });
  assert.match(body, /14:30 - 15:00 \(Asia\/Dubai\)/, "the hour AND the zone");
  assert.match(body, /Join: https:\/\/meet\.example\.com\/abc/, "the link as text, so it survives any mail client");
  assert.match(body, /Organiser: Asif Rahman/);
  assert.match(body, /Bring the new price list\./);

  const room = m.inviteText({ subject: "Site visit", startAt: new Date("2026-11-03T10:30:00Z"), endAt: new Date("2026-11-03T11:00:00Z"), zone: "Asia/Dubai", where: "in_person", location: "Deira office" });
  assert.match(room, /Where: Deira office/);
  assert.ok(!room.includes("Join:"));
});

test("the subject line says which of the three this email is", () => {
  assert.equal(m.inviteSubject({ subject: "Price review" }), "Invitation: Price review");
  assert.equal(m.inviteSubject({ subject: "Price review", changed: true }), "Updated: Price review");
  assert.equal(m.inviteSubject({ subject: "Price review", cancelled: true }), "Cancelled: Price review");
});
