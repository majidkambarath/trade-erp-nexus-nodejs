// The period a list endpoint was asked for, read on the organisation's own calendar. Pure (no Mongoose, no request, no clock
// but the `now` you pass in), so the rule is tested without a server.
//
// A person speaks in calendar days ("from 1 October to 31 October") and the stored dates are instants, so the two ends are
// turned into instants once, here: a day is the zone's day (utils/tz.js), and the last day of a range is WHOLE (inclusive).
// Before this the transaction list read "today" on the server's clock (UTC on the host, four hours behind Dubai), took
// `new Date("2026-10-09")` as the end of a range (04:00 on the 9th in Dubai, so the whole of the 9th after four in the
// morning was left out) and the voucher list ended a plain day at 23:59:59.999 UTC (03:59 on the NEXT day in Dubai).
//
//   listPeriod({ dateFilter, startDate, endDate, dateFrom, dateTo }, { zone, now })
//     -> { gte: Date | null, lte: Date | null, error: { message, code } | null }
//
//   dateFilter  TODAY   the organisation's today, whole
//               WEEK    the last seven days, today included (no upper bound, as before)
//               MONTH   this calendar month so far (no upper bound, as before)
//               CUSTOM  startDate .. endDate, both required, the last day whole
//               ALL / empty: no preset
//   dateFrom / dateTo   a range of plain days (or full timestamps), the last day whole; combined with a preset they narrow it
//
// A bound that is not a date is an `error` (a bound that is quietly dropped widens the list and its total).

const tz = require("./tz");

const given = (v) => v !== null && v !== undefined && String(v).trim() !== "";
const real = (d) => d instanceof Date && !Number.isNaN(d.getTime());

function listPeriod(q = {}, { zone = tz.UTC, now = new Date() } = {}) {
  const fail = (message, code) => ({ gte: null, lte: null, error: { message, code } });
  let gte = null;
  let lte = null;

  const bound = (value, edge, name) => {
    if (!given(value)) return { date: null };
    const date = tz.boundOf(value, edge, zone);
    return real(date) ? { date } : { error: { message: `${name} is not a date`, code: "INVALID_DATE" } };
  };

  const preset = String(q.dateFilter ?? "").trim().toUpperCase();
  if (preset && preset !== "ALL") {
    const today = tz.dayOf(now, zone);
    if (preset === "TODAY") {
      gte = tz.dayStart(today, zone);
      lte = tz.endOfDay(today, zone);
    } else if (preset === "WEEK") {
      gte = tz.dayStart(tz.addDays(today, -6), zone);
    } else if (preset === "MONTH") {
      gte = tz.dayStart(tz.monthStartDay(today), zone);
    } else if (preset === "CUSTOM") {
      if (!given(q.startDate) || !given(q.endDate)) return fail("startDate and endDate required for CUSTOM", "DATE_RANGE_REQUIRED");
      const from = bound(q.startDate, "start", "startDate");
      const to = bound(q.endDate, "end", "endDate");
      if (from.error || to.error) return { gte: null, lte: null, error: from.error || to.error };
      gte = from.date;
      lte = to.date;
    } else {
      return fail("Invalid date filter", "INVALID_DATE_FILTER");
    }
  }

  const from = bound(q.dateFrom, "start", "dateFrom");
  const to = bound(q.dateTo, "end", "dateTo");
  if (from.error || to.error) return { gte: null, lte: null, error: from.error || to.error };
  // both a preset and an explicit range: the period is where they overlap
  if (from.date && (!gte || from.date > gte)) gte = from.date;
  if (to.date && (!lte || to.date < lte)) lte = to.date;

  return { gte, lte, error: null };
}

/** The `{ $gte, $lte }` a Mongo date condition takes, or null when no bound was asked for. */
const condition = (period) => {
  if (!period || (!period.gte && !period.lte)) return null;
  return { ...(period.gte && { $gte: period.gte }), ...(period.lte && { $lte: period.lte }) };
};

module.exports = { listPeriod, condition };
