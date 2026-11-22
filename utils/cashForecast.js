// The cash flow forecast: known money in and money out, filed into weeks, from today's cash and bank balance. Pure: no Mongoose, no clock.
// Every day is "YYYY-MM-DD" on the organisation's calendar. Nothing here is stored; the service reads the books and hands the items in.
//
// THE RULES THAT MATTER (each is pinned by a test):
//   - Week 1 starts TODAY and runs to the coming Sunday; every later week is Monday to Sunday. So the 13 weeks always start with what is
//     actually left of this one, never with days already gone.
//   - An item dated BEFORE today (an overdue invoice or bill, a cheque past its date) is OVERDUE: it is shown apart and is NOT in the
//     running balance. It may be paid tomorrow or never, and the forecast must not promise it. (The cheque forecast assumes an overdue
//     cheque clears at once; an invoice is not a cheque.)
//   - An item after the last week is LATER, shown apart.
//   - An item on HOLD (a cheque somebody asked not to present) is counted but kept out of the balance, like the cheque forecast does.
//   - Weeks + overdue + later + on hold always add up to every item that was handed in: nothing is dropped.
const MS_DAY = 86400000;

const isDay = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
const utc = (ymd) => new Date(`${ymd}T00:00:00Z`);
const addDays = (ymd, n) => new Date(utc(ymd).getTime() + n * MS_DAY).toISOString().slice(0, 10);
/** 1 = Monday ... 7 = Sunday */
const isoWeekday = (ymd) => ((utc(ymd).getUTCDay() + 6) % 7) + 1;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const SOURCES = ["receivables", "payables", "chequesIn", "chequesOut", "recurringSales", "recurringExpenses", "payroll"];
const MAX_WEEKS = 26;
const SHOWN_PER_WEEK = 25; // the biggest items a week lists; the rest are counted

/** The weeks: `[{ key: "W1", n, from, to }]`. Week 1 is today to Sunday; the rest are Monday to Sunday. */
function weeks(today, count = 13) {
  const n = Math.max(1, Math.min(MAX_WEEKS, Math.floor(Number(count)) || 13));
  if (!isDay(today)) return [];
  const out = [];
  let from = today;
  for (let i = 1; i <= n; i += 1) {
    const to = addDays(from, 7 - isoWeekday(from)); // the Sunday of the week `from` is in
    out.push({ key: `W${i}`, n: i, from, to });
    from = addDays(to, 1);
  }
  return out;
}

/**
 * @param today    "YYYY-MM-DD"
 * @param opening  cash and bank today (a number)
 * @param items    [{ day, amount (+ money in, - money out), source, label, ref?, certain?, onHold? }]
 * @param count    weeks, 1-26 (default 13)
 */
function buildForecast({ today, opening = 0, items = [], count = 13 } = {}) {
  const grid = weeks(today, count);
  const rows = grid.map((w) => ({ ...w, in: 0, out: 0, net: 0, closing: 0, bySource: {}, items: [], moreItems: 0, onHold: { in: 0, out: 0, count: 0 } }));
  const lastDay = rows.length ? rows[rows.length - 1].to : today;
  const overdue = { in: 0, out: 0, count: 0, bySource: {} };
  const later = { in: 0, out: 0, count: 0 };
  const skipped = [];

  for (const item of Array.isArray(items) ? items : []) {
    const amount = round2(item?.amount);
    if (!isDay(item?.day) || !Number.isFinite(amount) || amount === 0) { skipped.push(item); continue; }
    const side = amount > 0 ? "in" : "out";
    const abs = Math.abs(amount);
    if (item.day < today) {
      overdue[side] = round2(overdue[side] + abs);
      overdue.count += 1;
      overdue.bySource[item.source] = round2((overdue.bySource[item.source] || 0) + amount);
      continue;
    }
    if (item.day > lastDay) {
      later[side] = round2(later[side] + abs);
      later.count += 1;
      continue;
    }
    const w = rows.find((r) => item.day >= r.from && item.day <= r.to);
    if (item.onHold) {
      w.onHold[side] = round2(w.onHold[side] + abs);
      w.onHold.count += 1;
      continue;
    }
    w[side] = round2(w[side] + abs);
    w.bySource[item.source] = round2((w.bySource[item.source] || 0) + amount);
    w.items.push({ day: item.day, amount, source: item.source, label: item.label || "", ref: item.ref || "", certain: item.certain !== false });
  }

  let balance = round2(opening);
  let lowest = { closing: balance, weekKey: null };
  let firstShortfall = null;
  for (const w of rows) {
    w.net = round2(w.in - w.out);
    balance = round2(balance + w.net);
    w.closing = balance;
    w.items.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.day.localeCompare(b.day));
    if (w.items.length > SHOWN_PER_WEEK) { w.moreItems = w.items.length - SHOWN_PER_WEEK; w.items.length = SHOWN_PER_WEEK; }
    if (balance < lowest.closing) lowest = { closing: balance, weekKey: w.key };
    if (firstShortfall === null && balance < 0) firstShortfall = w.key;
  }
  // `lowest` is the lowest balance the forecast reaches: a week's closing, or today's opening (weekKey null) when no week goes lower
  const sum = (k) => round2(rows.reduce((t, w) => t + w[k], 0));
  return {
    today, opening: round2(opening), weeks: rows, overdue, later, lowest, firstShortfall,
    totals: { in: sum("in"), out: sum("out"), net: round2(sum("in") - sum("out")), closing: rows.length ? rows[rows.length - 1].closing : round2(opening) },
    onHold: { in: round2(rows.reduce((t, w) => t + w.onHold.in, 0)), out: round2(rows.reduce((t, w) => t + w.onHold.out, 0)), count: rows.reduce((t, w) => t + w.onHold.count, 0) },
    skipped: skipped.length,
  };
}

/** The coming run days of a schedule inside [from, to] (a template's `upcoming` already stops at its own end). */
function runsBetween(upcomingDays = [], from, to) {
  return upcomingDays.filter((d) => isDay(d) && d >= from && d <= to);
}

/** Money for an expense template: the net, plus the tax at the code's rate (a rate of 0 or none adds nothing). */
const grossOf = (net, ratePercent) => round2(Number(net || 0) * (1 + (Number(ratePercent) || 0) / 100));

module.exports = { SOURCES, MAX_WEEKS, SHOWN_PER_WEEK, isDay, addDays, isoWeekday, weeks, buildForecast, runsBetween, grossOf };
