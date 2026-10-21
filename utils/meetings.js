// Scheduled meetings: the rules, as plain functions with no Mongoose and no request, so every awkward case is a test
// rather than a customer's calendar showing the wrong hour.
//
// A meeting is a CrmActivity of kind "meeting" with a `meeting` subdocument. THE RULE THAT KEEPS THE REST OF THE CRM
// WORKING: `dueAt` stays the calendar DAY, derived from the start, because 33 places read it as a day (the worklist's
// sort, overdue, the board's drops, aging, the reports, the calendar). A meeting adds a time; it never changes what a
// day means.
//
// The organiser books in the ORGANISATION's zone (what the person sees on the form). The instant is what we store, and
// the invitation carries UTC, so a customer in another country sees the right hour on their own calendar.
const tz = require("./tz");

// A meeting shorter than this is a mis-type; longer than a working day is almost always one too. Neither is a hard law,
// which is why both are refusals a person can read and correct rather than silent clamping.
const MIN_MINUTES = 5;
const MAX_MINUTES = 12 * 60;
const DEFAULT_MINUTES = 30;
/** What the form offers; a person may still type any number of minutes within the two bounds above. */
const DURATIONS = [15, 30, 45, 60, 90, 120];

const WHERE = ["online", "in_person", "phone"];
const WHERE_LABEL = { online: "Online", in_person: "In person", phone: "By phone" };

// An attendee is somebody we already hold: a contact (the customer's side) or a colleague (ours). A typed-in address is
// deliberately not a kind - it would be a person nobody can find again, and the user did not ask for it.
const ATTENDEE_KINDS = ["contact", "user"];
const RSVP = ["invited", "accepted", "declined", "tentative"];
const RSVP_LABEL = { invited: "Invited", accepted: "Accepted", declined: "Declined", tentative: "Maybe" };

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ---- coercion: a request body is not to be trusted (the security sweep posts `{ $ne: "x" }` at every route) ---------

const text = (v, max = 200) => {
  if (typeof v === "string") return v.trim().slice(0, max);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
};
const num = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return 0;
};
const oneOf = (v, list) => (list.includes(text(v, 40)) ? text(v, 40) : null);
const isId = (v) => /^[0-9a-fA-F]{24}$/.test(text(v, 24));
const timeOf = (v) => (TIME_RE.test(text(v, 5)) ? text(v, 5) : null);

/** A join link we are willing to put in somebody's calendar: http(s) and nothing else (no javascript:, no data:). */
function joinUrlOf(v) {
  const raw = text(v, 500);
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
}

// ---- when it is ------------------------------------------------------------------------------------------------

/**
 * The instant at which the zone's clock reads `day` at `time`. Wraps tz.wallToInstant, which already handles a clock
 * change, so no new time arithmetic lives here.
 */
function startInstant(day, time, zone) {
  const d = tz.isRealDay(text(day, 10)) ? text(day, 10) : null;
  const t = timeOf(time);
  if (!d || !t) return null;
  const [y, m, dd] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  return tz.wallToInstant(y, m, dd, h, mi, 0, 0, zone);
}

const endInstant = (start, minutes) => (start ? new Date(start.getTime() + Math.round(num(minutes)) * 60000) : null);

/** The day a meeting belongs to - what `dueAt` is written from, and the only thing the rest of the CRM reads. */
const dayOfMeeting = (startAt, zone) => (startAt ? tz.dayOf(startAt, zone) : null);

const minutesBetween = (a, b) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000);

// ---- validation ----------------------------------------------------------------------------------------------------

const err = (errors) => (field, code, message) => errors.push({ field, code, message });

/**
 * Everything a meeting needs before it can be booked. `partial` is for a reschedule, which may send only the new time.
 * Attendees are checked for shape here; whether those ids exist is the service's question, not a pure rule's.
 */
function validateMeeting(input = {}, { partial = false, zone = "UTC" } = {}) {
  const errors = [];
  const add = err(errors);
  const has = (k) => Object.prototype.hasOwnProperty.call(input || {}, k);

  if (!partial || has("subject")) {
    if (!text(input.subject, 200)) add("subject", "MEETING_SUBJECT_REQUIRED", "Say what the meeting is about");
  }
  // Each is judged on its own: a reschedule that moves only the hour sends only the time, and must not be told it has
  // no day. Having BOTH before an instant can be worked out is the service's business, not a field rule's.
  if (!partial || has("day")) {
    if (!tz.isRealDay(text(input.day, 10))) add("day", "MEETING_DAY_INVALID", "Choose the day of the meeting");
  }
  if (!partial || has("time")) {
    if (!timeOf(input.time)) add("time", "MEETING_TIME_INVALID", "Give a start time, as 14:30");
  }
  if (!partial || has("minutes")) {
    const minutes = Math.round(num(input.minutes));
    if (minutes < MIN_MINUTES) add("minutes", "MEETING_TOO_SHORT", `A meeting is at least ${MIN_MINUTES} minutes long`);
    else if (minutes > MAX_MINUTES) add("minutes", "MEETING_TOO_LONG", "A meeting longer than 12 hours is probably a mistake");
  }
  if (has("where") && text(input.where, 20) && !oneOf(input.where, WHERE)) {
    add("where", "MEETING_WHERE_INVALID", "A meeting is online, in person or by phone");
  }
  // An online meeting with no link is allowed on purpose: the organiser often books first and pastes the link later.
  if (has("joinUrl") && text(input.joinUrl, 500) && !joinUrlOf(input.joinUrl)) {
    add("joinUrl", "MEETING_LINK_INVALID", "A meeting link must start with http:// or https://");
  }
  if (has("location") && text(input.location, 300).length > 300) add("location", "MEETING_PLACE_TOO_LONG", "That place is too long");

  if (!partial || has("attendees")) {
    const list = Array.isArray(input.attendees) ? input.attendees : [];
    if (!list.length) add("attendees", "MEETING_ATTENDEES_REQUIRED", "Invite at least one person");
    else if (list.length > 50) add("attendees", "MEETING_TOO_MANY", "Fifty people is as many as one meeting can invite");
    else {
      list.forEach((a, i) => {
        if (!oneOf(a?.kind, ATTENDEE_KINDS)) add(`attendees.${i}.kind`, "MEETING_ATTENDEE_INVALID", "An attendee is a contact or a colleague");
        else if (!isId(a?.id)) add(`attendees.${i}.id`, "MEETING_ATTENDEE_INVALID", "That is not somebody in this organisation");
      });
    }
  }
  if (has("zone") && text(input.zone, 60) && !tz.validZone(input.zone)) {
    add("zone", "MEETING_ZONE_INVALID", "That is not a time zone this server knows");
  }
  // The zone the organisation keeps: a meeting booked in a zone whose days are a day behind would store the wrong day.
  const check = tz.supportedZone(text(input.zone, 60) || zone);
  if (!check.ok) add("zone", "MEETING_ZONE_INVALID", check.reason);
  return errors;
}

/** The meeting as it will be stored, from a validated body. The caller supplies the attendees it has already resolved. */
function normaliseMeeting(input = {}, { zone, attendees = [], uid = null, sequence = 0 } = {}) {
  const start = startInstant(input.day, input.time, zone);
  const minutes = Math.round(num(input.minutes)) || DEFAULT_MINUTES;
  const where = oneOf(input.where, WHERE) || "online";
  return {
    startAt: start,
    endAt: endInstant(start, minutes),
    timezone: zone,
    where,
    location: text(input.location, 300),
    joinUrl: where === "in_person" ? "" : joinUrlOf(input.joinUrl),
    uid: text(uid, 120) || null,
    sequence: Math.max(0, Math.round(num(sequence))),
    attendees,
  };
}

// ---- a clash, which is a warning and never a refusal -----------------------------------------------------------------

/**
 * The organiser's other meetings that overlap this one. Touching ends do not overlap (11:00-11:30 and 11:30-12:00 are
 * fine). A cancelled meeting cannot clash, and a meeting never clashes with itself.
 */
function clashesWith(meeting, others = []) {
  const from = meeting?.startAt ? new Date(meeting.startAt).getTime() : null;
  const to = meeting?.endAt ? new Date(meeting.endAt).getTime() : null;
  if (!from || !to) return [];
  return (Array.isArray(others) ? others : [])
    .filter((o) => {
      const m = o?.meeting || o;
      if (!m?.startAt || !m?.endAt || m.cancelledAt) return false;
      if (meeting.id && o?._id && String(meeting.id) === String(o._id)) return false;
      const s = new Date(m.startAt).getTime();
      const e = new Date(m.endAt).getTime();
      return s < to && e > from;
    })
    .map((o) => ({ id: String(o?._id || ""), subject: text(o?.subject, 200), startAt: (o?.meeting || o).startAt, endAt: (o?.meeting || o).endAt }));
}

// ---- the invitation itself (RFC 5545) ---------------------------------------------------------------------------------

/** "20261103T110000Z": an instant in UTC, which is the one form every calendar reads the same way. */
function icsStamp(instant) {
  // `new Date(null)` is 1 January 1970, not an invalid date, so a missing start would otherwise be written as a 1970
  // meeting rather than refused. Nothing but a Date or a real timestamp or string is an instant.
  if (instant === null || instant === undefined || instant === "") return null;
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}Z`;
}

/** A value in an iCalendar line: a backslash, a semicolon and a comma are escaped, and a newline becomes "\n". */
const icsValue = (v) =>
  String(v ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");

/**
 * Fold a line to 75 OCTETS, not characters: an Arabic or accented subject is multi-byte, and folding by character
 * length would split one character across two lines and arrive as mojibake. A continuation starts with one space.
 */
function fold(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // never cut inside a UTF-8 character: a continuation byte is 10xxxxxx
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    out.push((out.length ? " " : "") + bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74; // the leading space of a continuation counts toward the 75
  }
  return out.join("\r\n");
}

const MAILTO = (email) => `mailto:${String(email || "").trim()}`;

/**
 * The .ics for one meeting.
 *
 * `method` is REQUEST to invite or to change, CANCEL to call it off. A change MUST carry the SAME uid and a HIGHER
 * sequence, or the attendee's calendar files it as a second meeting instead of replacing the first.
 *
 * `organiser` is the person whose mailbox the attendee's Accept reply will reach - the salesperson, not our sending
 * address, because nobody reads the sending address.
 */
function buildIcs({ uid, sequence = 0, method = "REQUEST", start, end, subject, description = "", location = "", joinUrl = "", organiser = {}, attendees = [], stamp = null } = {}) {
  const dtStart = icsStamp(start);
  const dtEnd = icsStamp(end);
  if (!uid || !dtStart || !dtEnd) return null;
  const cancelled = String(method).toUpperCase() === "CANCEL";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Zarvia//CRM//EN",
    "CALSCALE:GREGORIAN",
    `METHOD:${cancelled ? "CANCEL" : "REQUEST"}`,
    "BEGIN:VEVENT",
    `UID:${icsValue(uid)}`,
    `DTSTAMP:${icsStamp(stamp || new Date())}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SEQUENCE:${Math.max(0, Math.round(num(sequence)))}`,
    `SUMMARY:${icsValue(subject)}`,
  ];
  if (description) lines.push(`DESCRIPTION:${icsValue(description)}`);
  // The place a person goes: the link for an online meeting, the address for a real one. Outlook reads LOCATION; Google
  // also reads a URL there and makes it clickable.
  const place = joinUrl || location;
  if (place) lines.push(`LOCATION:${icsValue(place)}`);
  if (joinUrl) lines.push(`URL:${icsValue(joinUrl)}`);
  if (organiser?.email) lines.push(`ORGANIZER;CN=${icsValue(organiser.name || organiser.email)}:${icsValue(MAILTO(organiser.email))}`);
  for (const a of attendees || []) {
    if (!a?.email) continue;
    lines.push(
      `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=${icsValue(a.name || a.email)}:${icsValue(MAILTO(a.email))}`
    );
  }
  lines.push(`STATUS:${cancelled ? "CANCELLED" : "CONFIRMED"}`);
  if (!cancelled) {
    // One reminder 10 minutes before, which is what a person expects a calendar to do.
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "TRIGGER:-PT10M", "END:VALARM");
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  // CRLF throughout, and a trailing CRLF: a calendar that gets bare newlines may refuse the whole file.
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

// ---- what a person reads -----------------------------------------------------------------------------------------

const TIME_FMT = new Map();
function timeFormatter(zone) {
  const key = String(zone || "UTC");
  if (!TIME_FMT.has(key)) {
    TIME_FMT.set(
      key,
      new Intl.DateTimeFormat("en-GB", { timeZone: tz.validZone(key) ? key : "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    );
  }
  return TIME_FMT.get(key);
}

/** "14:30" as the clock reads in that zone. */
const timeIn = (instant, zone) => (instant ? timeFormatter(zone).format(instant instanceof Date ? instant : new Date(instant)) : "");

/** "14:30 - 15:00" for a screen, a chip or a line of an email. */
function timeRange(startAt, endAt, zone) {
  const a = timeIn(startAt, zone);
  const b = timeIn(endAt, zone);
  return a && b ? `${a} - ${b}` : a;
}

/**
 * The invitation's words. The zone is NAMED, because the one thing that ruins a meeting with somebody abroad is a time
 * with no zone beside it; the .ics carries UTC so their calendar converts it, but a person reads this.
 */
function inviteText({ subject, startAt, endAt, zone, where = "online", location = "", joinUrl = "", organiserName = "", note = "", dayLabel = "" } = {}) {
  const when = `${dayLabel || tz.dayOf(startAt, zone)}, ${timeRange(startAt, endAt, zone)} (${zone})`;
  const lines = [`${subject}`, "", `When: ${when}`];
  if (where === "in_person" && location) lines.push(`Where: ${location}`);
  else if (where === "phone") lines.push("Where: by phone");
  if (joinUrl) lines.push(`Join: ${joinUrl}`);
  if (organiserName) lines.push(`Organiser: ${organiserName}`);
  if (note) lines.push("", note);
  return lines.join("\n");
}

/** The subject line of the email the attendee receives. */
const inviteSubject = ({ subject, cancelled = false, changed = false } = {}) =>
  `${cancelled ? "Cancelled: " : changed ? "Updated: " : "Invitation: "}${text(subject, 180)}`;

module.exports = {
  MIN_MINUTES, MAX_MINUTES, DEFAULT_MINUTES, DURATIONS, WHERE, WHERE_LABEL, ATTENDEE_KINDS, RSVP, RSVP_LABEL,
  text, num, oneOf, isId, timeOf, joinUrlOf,
  startInstant, endInstant, dayOfMeeting, minutesBetween,
  validateMeeting, normaliseMeeting, clashesWith,
  icsStamp, icsValue, fold, buildIcs,
  timeIn, timeRange, inviteText, inviteSubject,
};
