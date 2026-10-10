// The instants a fiscal year made by hand covers. Pure (no Mongoose, no request), so the rule is tested without a server.
//
// A year is stored as two INSTANTS and every posting is judged against them (FiscalYearService.getForDate compares
// startDate <= date <= endDate), so what is stored matters to the millisecond:
//   - a plain "YYYY-MM-DD" is a calendar day of the organisation: the year starts at 00:00 of its first day THERE and
//     ends at the last millisecond of its last day THERE, the same instants the year made by provisioning has
//     (FiscalYearService.ensureDefault, the next year made by the year-end close);
//   - a full timestamp (or a Date) is the instant it names, exactly as before.
// `new Date("2025-12-31")` is 00:00 UTC, which is 04:00 on the 31st in Dubai: a year made from the screen's day strings
// used to end at four in the morning on its last day and start four hours late, so a posting on the evening of 31
// December was refused (NO_FISCAL_YEAR) and the next year, made the same way, left the rest of that day in no year at all.

const tz = require("./tz");

const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());

/**
 * { startDate, endDate, ok } for the two values a person sent.
 * `ok` is false when either is not a date, the end is not after the start, or both are plain days and the end DAY is not
 * after the start day (a year is not one day long: that was refused before, when both read as the same instant).
 */
function instants(startInput, endInput, zone) {
  const startDate = tz.boundOf(startInput, "start", zone);
  const endDate = tz.boundOf(endInput, "end", zone);
  const real = (d) => d instanceof Date && !Number.isNaN(d.getTime());
  let ok = real(startDate) && real(endDate) && endDate > startDate;
  if (ok && isDay(startInput) && isDay(endInput)) ok = endInput.trim() > startInput.trim();
  return { startDate, endDate, ok };
}

module.exports = { instants, isDay };
