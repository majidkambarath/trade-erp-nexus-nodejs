// The HR MIS dashboard's arithmetic: month buckets, department rollups, shares and the reader split.
// Pure - no Mongoose, no clock, no organisation locale. Anything that needs "today" or "which calendar
// day is this instant" takes it as an argument, which is what makes every figure here testable without a
// database (the shape services/reports/dashboardService.js already proved: free functions hung on the
// service as statics).
//
// It deliberately does NOT re-derive labour maths. utils/hr.js already owns idleHours, idleLabour,
// labourTotal, visibleLabour, labourMargin and serviceDays; this file only buckets and shares what those
// produce. Two figures that disagree about the same thing is the one failure a management screen cannot
// survive, so every number it shows has exactly one definition, owned by the report it belongs to.
const { periodDays } = require("./payroll");

const MONTHS = 6; // how far the trends look back by default
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const pad = (n) => String(n).padStart(2, "0");

/** "2026-01", -1 -> "2025-12". Pure string arithmetic, no zone involved. A local copy rather than a
 * require into services/reports/dashboardQueries.js: an HR service reaching into the reports module
 * would be a new cross-module edge, and the repo's habit (three copies of shiftDay already) is a copy. */
function shiftMonth(month, delta) {
  if (!MONTH.test(String(month || ""))) return month;
  const [y, m] = month.split("-").map(Number);
  const t = y * 12 + (m - 1) + delta;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}

/** `count` months ending with `lastMonth`, oldest first. */
const monthRange = (lastMonth, count) =>
  Array.from({ length: Math.max(1, count) }, (_, i) => shiftMonth(lastMonth, i - (Math.max(1, count) - 1)));

/** The last calendar day of a month, through the HR-native helper rather than a fourth private copy. */
const lastDayOf = (month) => periodDays(month)?.lastDay || null;

/**
 * What the dashboard is being asked for. `today` is injected (never read from a clock here) so a test can
 * stand on any day it likes - the same injectability `resolvePeriod(query, today)` has in the trade
 * dashboard, and the reason its arithmetic is testable at all.
 */
function resolvePeriod({ month, months } = {}, today) {
  const day = String(today || "");
  const current = MONTH.test(String(month || "")) ? month : day.slice(0, 7);
  const count = Number(months) > 0 ? Math.min(Math.trunc(Number(months)), 24) : MONTHS;
  const end = lastDayOf(current);
  return {
    month: current,
    // A past month is read whole; the month in progress stops at today, so a part-month is never
    // compared against a whole one as though trading had stopped.
    from: `${current}-01`,
    to: end && end < day ? end : day || end,
    monthEnd: end,
    months: monthRange(current, count),
    previousMonth: shiftMonth(current, -1),
  };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** A share as a percentage, or null when there is nothing to divide by - never 0, which would read as
 * "none of it" when the truth is "nothing to measure". */
const share = (part, whole) => (num(whole) > 0 ? (num(part) / num(whole)) * 100 : null);
/** The change from `before` to `now` as a percentage, null when there is no base to compare against. */
const change = (now, before) => (num(before) > 0 ? ((num(now) - num(before)) / num(before)) * 100 : null);

/**
 * Joiners, leavers and the net move per month, plus the headcount standing at the end of each.
 *
 * `staff` rows carry joiningDate / exitDate as real Dates, so the caller injects `dayOf` (orgDay) to say
 * which calendar day each falls on in the organisation's own zone - never String(date).slice(0,10), the
 * bug gratuityService and leaveRequestService each carry a comment about.
 *
 * The closing headcount is counted from the dates themselves rather than carried forward from a starting
 * figure: anybody who had joined by the month end and had not left is in it. That way a month with no
 * movement still reports the right headcount, and an employee whose records were back-dated does not
 * shift every later month.
 */
function headcountFlow(staff = [], months = [], { dayOf = () => null } = {}) {
  const people = (Array.isArray(staff) ? staff : [])
    .map((s) => ({ joined: dayOf(s?.joiningDate), left: s?.exitDate ? dayOf(s.exitDate) : null }))
    .filter((p) => p.joined);
  return months.map((month) => {
    const end = lastDayOf(month);
    let joiners = 0;
    let leavers = 0;
    let headcount = 0;
    for (const p of people) {
      if (p.joined.slice(0, 7) === month) joiners += 1;
      if (p.left && p.left.slice(0, 7) === month) leavers += 1;
      if (p.joined <= end && (!p.left || p.left > end)) headcount += 1;
    }
    return { month, joiners, leavers, net: joiners - leavers, headcount };
  });
}

const UNASSIGNED = "Unassigned";

/**
 * Roll rows up by department, largest first.
 *
 * Staff.department (free text) and Staff.departmentId (a ref) can disagree - an older employee carries
 * the string with a null ref, because StaffService only keeps them in step from the day a Department
 * master existed. So the key is the id where there is one and the trimmed name otherwise, and anybody
 * with neither lands in one honest "Unassigned" bucket rather than being dropped.
 */
// `amountOf`, NOT `valueOf`: a destructured option named valueOf is never defaulted, because {}.valueOf
// is inherited from Object.prototype and so is always present - the default then never fires and
// Object.prototype.valueOf is called with no `this`, which throws. Same trap for toString, constructor
// and hasOwnProperty. Found by the test below calling byDepartment with no options at all.
function byDepartment(rows = [], { amountOf = () => 1 } = {}) {
  const buckets = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = r?.departmentId ? String(r.departmentId) : null;
    const name = String(r?.department || "").trim();
    const key = id || name || UNASSIGNED;
    const bucket = buckets.get(key) || { key, name: name || (id ? "" : UNASSIGNED), value: 0, people: 0 };
    // A row that names the department in text wins the label: an id with no name resolved yet would
    // otherwise show the screen a raw ObjectId.
    if (!bucket.name && name) bucket.name = name;
    bucket.value += num(amountOf(r));
    bucket.people += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, name: b.name || UNASSIGNED }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

const PRESENT = ["present", "half_day"];

/**
 * A month's attendance as its own split, and the rate that matters.
 *
 * `rate` counts present and half days against the days somebody was EXPECTED - absent, present and
 * on-leave days - so a holiday or a weekly off cannot flatter it. Null when nothing was expected (a
 * month nobody has marked yet is not 0% attendance, it is unknown), the same rule utils/hr.js applies to
 * a missing cost rate.
 */
function attendanceSplit(rows = []) {
  const counts = { present: 0, half_day: 0, absent: 0, on_leave: 0, holiday: 0, weekly_off: 0 };
  let hours = 0;
  let overtime = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.status in counts) counts[r.status] += num(r.count ?? 1);
    hours += num(r?.hours);
    overtime += num(r?.overtime);
  }
  const worked = counts.present + counts.half_day;
  const expected = worked + counts.absent + counts.on_leave;
  return { counts, worked, expected, rate: share(worked, expected), hours, overtime };
}

/**
 * Payroll cost per month, dense across `months` so a month nobody ran is a gap of zero rather than a
 * missing column. POSTED runs only: a reversed run is still a row, and counting it would double the
 * month it was reversed in.
 */
function costByMonth(runs = [], months = []) {
  const posted = new Map();
  for (const r of Array.isArray(runs) ? runs : []) {
    if (r?.status !== "POSTED" || !r?.period) continue;
    posted.set(r.period, {
      gross: num(r.totalGross),
      net: num(r.totalNet),
      deductions: num(r.totalDeductions),
      employees: num(r.employeeCount),
    });
  }
  return months.map((month) => ({ month, ran: posted.has(month), ...(posted.get(month) || { gross: 0, net: 0, deductions: 0, employees: 0 }) }));
}

/**
 * The labour on work costed in the period, as waterfall steps: what was paid for, what reached a product
 * or a job, and what did not.
 *
 * Deliberately NOT called "all labour". There is no organisation-wide idle figure - LabourCostService
 * .idleFor is handed lines, and those lines only exist for process orders (the opt-in `production`
 * feature) and job cards (the `garage` module). An organisation running neither has nothing here, which
 * is why `hasWork` is reported rather than a zero that would read as "no idle time, well done".
 */
function labourFlow({ bookedCost = 0, idleCost = 0, bookedHours = 0, idleHours = 0, orders = 0 } = {}) {
  const booked = num(bookedCost);
  const idle = num(idleCost);
  const total = booked + idle;
  return {
    hasWork: orders > 0 && total > 0,
    orders: num(orders),
    bookedCost: booked,
    idleCost: idle,
    total,
    bookedHours: num(bookedHours),
    idleHours: num(idleHours),
    idleShare: share(idle, total),
    steps: [
      { key: "paid", label: "Labour paid for", value: total, kind: "total" },
      { key: "idle", label: "Not booked to work", value: -idle, kind: "change" },
      { key: "booked", label: "Into product and job cost", value: booked, kind: "total" },
    ],
  };
}

/**
 * What a reader may see. An org-wide TOTAL survives for everyone; anything nameable, or divisible back
 * into one person's pay, does not - the line payrollController's own forReader already draws when it
 * keeps `totals` and drops the rest.
 *
 * So "payroll cost this month" stays and "cost per employee" goes: an average beside a headcount is a
 * salary with extra steps. Gratuity keeps its organisation total and loses the per-employee breakdown.
 */
function forReader(data, confidential) {
  if (confidential) return data;
  const out = { ...data, confidential: false };
  if (out.cost) {
    out.cost = {
      // The month trend and the organisation's own totals are aggregates, so they stay.
      byMonth: out.cost.byMonth,
      thisMonth: out.cost.thisMonth,
      previousMonth: out.cost.previousMonth,
      changePct: out.cost.changePct,
      // Divisible or nameable: a per-head average, a department small enough to name one person, the
      // labour money on a job.
      perEmployee: undefined,
      byDepartment: undefined,
    };
  }
  if (out.labour) {
    out.labour = { hasWork: out.labour.hasWork, orders: out.labour.orders, bookedHours: out.labour.bookedHours, idleHours: out.labour.idleHours, idleShare: out.labour.idleShare };
  }
  if (out.gratuity) out.gratuity = { liability: out.gratuity.liability, month: out.gratuity.month, employeeCount: out.gratuity.employeeCount, missingCount: out.gratuity.missingCount };
  return out;
}

module.exports = {
  MONTHS,
  UNASSIGNED,
  shiftMonth,
  monthRange,
  lastDayOf,
  resolvePeriod,
  share,
  change,
  headcountFlow,
  byDepartment,
  attendanceSplit,
  costByMonth,
  labourFlow,
  forReader,
};
