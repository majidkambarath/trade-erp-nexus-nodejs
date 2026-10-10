// Calendar days in an organisation's own time zone: which day an instant falls on, when a day begins and ends. Pure (no I/O,
// no Mongoose, no clock except the `now` you pass in), so the rules are tested without a server.
//
// A calendar day travels as "YYYY-MM-DD" and an organisation has ONE zone (Organisation.timezone, an IANA name such as
// "Asia/Dubai" or "Europe/London"). Daylight saving is handled: a day's start is found from the zone's offset AT that
// moment, not from a constant, so a day in a zone with clock changes begins at the right instant.
//
// Day-only dates are stored at UTC midnight (a quotation's valid-until, an expiry day), which is the same calendar day in
// any zone at or east of UTC and the day BEFORE west of it. So only zones that are never west of UTC are supported
// (`supportedZone`), and an organisation is refused any other when it is made.

const UTC = "UTC";
const zones = new Map(); // IANA name -> { wall, day } formatters, built once

const formatters = (zone) => {
  let f = zones.get(zone);
  if (!f) {
    f = {
      wall: new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }),
      day: new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }),
    };
    zones.set(zone, f);
  }
  return f;
};

/** Is this an IANA zone name this runtime knows? */
function validZone(zone) {
  if (!zone || typeof zone !== "string") return false;
  try { formatters(zone); return true; } catch (_) { return false; }
}

// A zone the caller named wrongly counts in UTC rather than throwing in the middle of a report.
const safe = (zone) => (validZone(zone) ? zone : UTC);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/; // a date and time with no zone
const pad = (n) => String(n).padStart(2, "0");

/** The zone's offset from UTC, in minutes, at an instant (Dubai +240, London 0 in winter and +60 in summer). */
function offsetMinutes(instant, zone) {
  const z = safe(zone);
  const ms = instant instanceof Date ? instant.getTime() : Number(instant);
  const p = Object.fromEntries(formatters(z).wall.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
}

/** "YYYY-MM-DD" of an instant as seen in the zone. A plain day is already a day and comes back as it is; nonsense is null. */
function dayOf(input = new Date(), zone = UTC) {
  if (typeof input === "string" && DAY_RE.test(input.trim())) return input.trim();
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  return formatters(safe(zone)).day.format(date);
}

/** Today, in the zone. `now` may be a Date, a timestamp or already a day. */
const todayIn = (zone, now = new Date()) => dayOf(now, zone);

// The instant at which the zone's wall clock reads y-m-d h:mi:s.ms. The offset is read at the guess and again at the answer,
// so a time just after a clock change still lands on the right instant.
function wallToInstant(y, m, d, h, mi, s, ms, zone) {
  const z = safe(zone);
  const guess = Date.UTC(y, m - 1, d, h, mi, s, ms);
  let t = guess - offsetMinutes(guess, z) * 60000;
  const again = offsetMinutes(t, z);
  t = guess - again * 60000;
  return new Date(t);
}

const parts = (ymd) => {
  const m = DAY_RE.exec(String(ymd ?? "").trim());
  if (!m) throw new Error(`Not a calendar day: ${ymd}`);
  return String(ymd).trim().split("-").map(Number);
};

/** The instant a calendar day begins in the zone (00:00 on its wall clock). */
function dayStart(ymd, zone = UTC) {
  const [y, m, d] = parts(ymd);
  return wallToInstant(y, m, d, 0, 0, 0, 0, zone);
}

/** The instant the day ends and the next begins (exclusive end: use `< dayEnd`). A day is 23 or 25 hours long when the clocks change. */
function dayEnd(ymd, zone = UTC) {
  const [y, m, d] = parts(ymd);
  return wallToInstant(y, m, d + 1, 0, 0, 0, 0, zone);
}

/** The last millisecond of the day (inclusive end: use `<= endOfDay`). */
const endOfDay = (ymd, zone = UTC) => new Date(dayEnd(ymd, zone).getTime() - 1);

/** Midday on the day, in the zone: an instant that reads as that calendar day in every zone from UTC-11 to UTC+12. */
function noonOf(ymd, zone = UTC) {
  const [y, m, d] = parts(ymd);
  return wallToInstant(y, m, d, 12, 0, 0, 0, zone);
}

/** Is this "YYYY-MM-DD" a day that exists? ("2026-02-30" has the right shape and is not one.) */
function isRealDay(ymd) {
  const text = String(ymd ?? "").trim();
  if (!DAY_RE.test(text)) return false;
  const [y, m, d] = text.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * A date in a request, read as one end of a period on the zone's own calendar.
 *   edge "start" is the "from" end, "end" the "to" end of a range.
 *   - a plain "YYYY-MM-DD" is that calendar day in the zone: its first moment for "start" and its LAST millisecond for "end",
 *     so the last day of a range is whole. (`new Date("2026-10-09")` is 00:00 UTC, which is 04:00 on the 9th in Dubai: as the
 *     "to" end of a range it dropped everything the 9th held after four in the morning.) A day that does not exist is an
 *     Invalid Date.
 *   - "YYYY-MM-DDTHH:mm[:ss[.SSS]]" with NO zone (what a screen builds with `${day}T23:59:59.999`) is that wall-clock time on
 *     the zone's clock. `new Date(...)` reads it on the SERVER's clock, which is UTC on the host and so four hours late in
 *     Dubai: an "end of 31 December" that reached into the first four hours of 1 January.
 *   - anything else is the instant `new Date(value)` reads: a timestamp with a zone ("...Z", "+04:00"), a Date, a number.
 *   - nothing given (null, undefined, "") is null.
 */
function boundOf(value, edge = "start", zone = UTC) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    if (DAY_RE.test(text)) {
      if (!isRealDay(text)) return new Date(NaN);
      return edge === "end" ? endOfDay(text, zone) : dayStart(text, zone);
    }
    const wall = WALL_RE.exec(text);
    if (wall) {
      const [y, m, d, h, mi] = [wall[1], wall[2], wall[3], wall[4], wall[5]].map(Number);
      const s = Number(wall[6] || 0);
      if (!isRealDay(`${wall[1]}-${wall[2]}-${wall[3]}`) || h > 23 || mi > 59 || s > 59) return new Date(NaN);
      const ms = Number(`${wall[7] || ""}00`.slice(0, 3)); // ".9" is 900 ms
      return wallToInstant(y, m, d, h, mi, s, ms, zone);
    }
    return new Date(text);
  }
  return new Date(value);
}

/** The calendar year of an instant in the zone. */
const yearOf = (instant, zone = UTC) => Number(String(dayOf(instant, zone) || "").slice(0, 4));

/** The first day of the month of `ymd` ("2026-10-09" -> "2026-10-01"). */
const monthStartDay = (ymd) => `${String(ymd).slice(0, 7)}-01`;

/** Add whole days to a calendar day, by calendar arithmetic (no zone involved). */
function addDays(ymd, days) {
  const [y, m, d] = parts(ymd);
  const t = new Date(Date.UTC(y, m - 1, d + Number(days)));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/**
 * Is the zone one the system can keep books in? It must exist and never be west of UTC (winter or summer), because day-only
 * dates are stored at UTC midnight. -> { ok } or { ok: false, reason }.
 */
function supportedZone(zone) {
  if (!validZone(zone)) return { ok: false, reason: "That is not a time zone this server knows" };
  const year = new Date().getUTCFullYear();
  const west = [Date.UTC(year, 0, 1), Date.UTC(year, 6, 1)].some((t) => offsetMinutes(t, zone) < 0);
  return west
    ? { ok: false, reason: "Time zones west of UTC are not supported yet: dates without a time are stored at UTC midnight, which would read as the day before there." }
    : { ok: true };
}

module.exports = { UTC, validZone, supportedZone, offsetMinutes, dayOf, todayIn, dayStart, dayEnd, endOfDay, noonOf, yearOf, monthStartDay, addDays, isRealDay, boundOf };
