// Closing a month inside an open fiscal year: the rules that need no database (no Mongoose, no request), beside
// utils/yearEnd.js, whose checks and wording this reuses.
//
// A month close is a lock and nothing else: it posts no entry (profit moves to equity only when the YEAR is closed).
// `FiscalYear.lockedThrough` is the last locked calendar day ("YYYY-MM-DD", in the organisation's zone); the period lock
// (FiscalYearService.assertPostingAllowed) refuses any date on or before it. The two locks do not overwrite each other:
//   - a year with status "closed" is locked as a whole, whatever its month lock says;
//   - the month lock is left exactly as it was while the year is closed, so reopening the year gives back the months
//     that were closed before it, no more and no fewer.
// Months are closed in order and only the latest closed month is reopened, so the lock is always one unbroken run from
// the start of the books (across years too: a year's first month needs the year before it locked right to its end).

const Y = require("./yearEnd");

const { check, finish, money, plural, longDay, addDays, addMonths } = Y;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MAX_MONTHS = 120; // a fiscal year is not meant to be longer than this; the cap only stops a nonsense range from looping

// ------------------------------------------------------------------ the months of a year

/** "2026-08" -> "August 2026" */
function monthLabel(key) {
  const [y, m] = String(key || "").split("-").map(Number);
  return MONTH_NAMES[m - 1] ? `${MONTH_NAMES[m - 1]} ${y}` : String(key || "");
}

/**
 * The calendar months a fiscal year runs through, each clipped to the year: [{ key: "2026-08", label, startDay, endDay }].
 * A January-December year has twelve; April-March has twelve; a year that starts mid-month starts with a short month.
 */
function monthsOf(startDay, endDay) {
  if (!DAY.test(startDay || "") || !DAY.test(endDay || "") || endDay < startDay) return [];
  const out = [];
  let key = startDay.slice(0, 7);
  const last = endDay.slice(0, 7);
  while (out.length < MAX_MONTHS) {
    const first = `${key}-01`;
    const end = addDays(addMonths(first, 1), -1);
    out.push({ key, label: monthLabel(key), startDay: first < startDay ? startDay : first, endDay: end > endDay ? endDay : end });
    if (key >= last) break;
    key = addMonths(first, 1).slice(0, 7);
  }
  return out;
}

/** The month of a year with this key, or null. */
const findMonth = (year, key) => monthsOf(year?.startDay, year?.endDay).find((m) => m.key === key) || null;

// year: { code, status, startDay, endDay, lockedThroughDay, monthCloses: [{ month, closedAt, closedByName, acknowledged }] }

/** Is this day behind the month lock of the year (not counting a year that is closed as a whole)? */
const monthLocked = (year, day) => Boolean(year?.lockedThroughDay && day <= year.lockedThroughDay);

/** The last day a year is locked through, by either lock: its end when it is closed, else its month lock, else null. */
const lockedDayOf = (year) => (year?.status === "closed" ? year.endDay : year?.lockedThroughDay || null);

/** Is the whole year locked, so a later year's months may begin? */
const fullyLocked = (year) => year?.status === "closed" || Boolean(year?.lockedThroughDay && year.lockedThroughDay >= year.endDay);

/** Does the year hold any lock at all (a closed year, or at least one closed month)? */
const anyLocked = (year) => year?.status === "closed" || Boolean(year?.lockedThroughDay);

/**
 * Every month of a year with where it stands:
 *   status "closed"      - closed as a month (its lock may be undone, if it is the latest)
 *   status "yearClosed"  - open as a month, but the year is closed, so it is locked with the year
 *   status "open"
 * `canClose` marks the one month that may be closed next, `canReopen` the one that may be reopened (the latest closed),
 * both only while the year itself is open. These are the order rules only; the checks are `assessMonthClose`.
 */
function monthStates(year) {
  const months = monthsOf(year?.startDay, year?.endDay);
  const yearClosed = year?.status === "closed";
  const closes = new Map((year?.monthCloses || []).map((c) => [c.month, c]));
  const nextKey = yearClosed ? null : months.find((m) => !monthLocked(year, m.endDay))?.key || null;
  const closedKeys = months.filter((m) => monthLocked(year, m.endDay)).map((m) => m.key);
  const latestKey = closedKeys.length ? closedKeys[closedKeys.length - 1] : null;
  return months.map((m) => {
    const closed = monthLocked(year, m.endDay);
    const info = closes.get(m.key) || {};
    return {
      ...m,
      status: closed ? "closed" : yearClosed ? "yearClosed" : "open",
      closedAt: closed ? info.closedAt || null : null,
      closedBy: closed ? info.closedByName || null : null,
      canClose: !yearClosed && m.key === nextKey,
      canReopen: !yearClosed && closed && m.key === latestKey,
    };
  });
}

/** The sentence the period lock refuses a date inside the month lock with. */
const lockedMessage = (day) => `Posting is closed up to ${longDay(day)}`;

// ------------------------------------------------------------------ may this month be closed?

// facts (all gathered by the service):
//   year { code, status, startDay, endDay, lockedThroughDay }, month { key, label, startDay, endDay } or null, today,
//   allBranches, earlierYears [code of each earlier year that is not locked right to its end],
//   unfinished { documents, vouchers }, outOfBalance [{ branchId, difference }], postingEnabled,
//   banks [{ accountName, reconciledTo }], stock (see yearEnd.stockCheck), currency
// Returns the checks in the order the screen lists them, like assessClose: a BLOCKER can never be set aside, a WARNING
// must be acknowledged by name.
function assessMonthClose(facts) {
  const f = facts || {};
  const year = f.year || {};
  const month = f.month;
  if (!month) return finish([check("MONTH_NOT_FOUND", "blocker", "That month is not part of this year")]);
  if (year.status === "closed") {
    return finish([check("YEAR_CLOSED", "blocker", `${year.code} is closed`, "Its months are locked with it. Reopen the year first if a month has to change; the months closed before it come back as they were.")]);
  }
  if (monthLocked(year, month.endDay)) return finish([check("ALREADY_CLOSED", "blocker", `${month.label} is already closed`)]);

  const checks = [];
  checks.push(f.allBranches === false
    ? check("ALL_BRANCHES_REQUIRED", "blocker", "Switch to All branches first", "Closing a month locks every branch, so it is done from head office with the branch switcher on All branches.")
    : check("ALL_BRANCHES", "ok", "Every branch is included"));

  const earlierYears = f.earlierYears || [];
  const firstOpen = monthsOf(year.startDay, year.endDay).find((m) => !monthLocked(year, m.endDay));
  if (earlierYears.length) {
    checks.push(check("EARLIER_YEAR_OPEN", "blocker", `Finish closing ${earlierYears.join(", ")} first`, "Months are closed in order, across years too: a year's first month needs the year before it closed, or all of its months."));
  } else if (firstOpen && firstOpen.key !== month.key) {
    checks.push(check("EARLIER_MONTH_OPEN", "blocker", `Close ${firstOpen.label} first`, "Months are closed in order, so each month's figures are final before the next is locked."));
  } else {
    checks.push(check("EARLIER_MONTHS_CLOSED", "ok", "No earlier month is left open"));
  }

  const un = f.unfinished || {};
  const unfinished = (un.documents || 0) + (un.vouchers || 0);
  checks.push(unfinished
    ? check(
        "UNFINISHED_DOCUMENTS", "blocker",
        `${[un.documents ? plural(un.documents, "document", "documents") : "", un.vouchers ? plural(un.vouchers, "voucher", "vouchers") : ""].filter(Boolean).join(" and ")} dated in ${month.label} ${unfinished === 1 ? "is" : "are"} not approved`,
        "Approve, reject or delete them, or change their date. Once the month is closed they can no longer be approved.",
        { documents: un.documents || 0, vouchers: un.vouchers || 0 }
      )
    : check("DOCUMENTS_FINISHED", "ok", `Every document dated in ${month.label} is approved, rejected or cancelled`));

  const off = f.outOfBalance || [];
  checks.push(off.length
    ? check("LEDGER_OUT_OF_BALANCE", "blocker", "The ledger does not balance", off.map((o) => `${o.branchId === Y.HEAD_OFFICE ? "Head office" : o.branchId}: debits and credits differ by ${money(Math.abs(o.difference), f.currency)} up to ${longDay(month.endDay)}`).join("; "))
    : check("LEDGER_BALANCED", "ok", `Debits equal credits up to ${longDay(month.endDay)}`));

  if (f.postingEnabled === false) {
    checks.push(check("POSTING_OFF", "warning", "Ledger posting is switched off", "There are no ledger entries behind the documents, so the month is only locked. Switch posting on first if the books should carry them."));
  }

  if (f.today && f.today <= month.endDay) {
    checks.push(check("MONTH_NOT_ENDED", "warning", `${month.label} has not ended`, `It runs until ${longDay(month.endDay)}. Closing now locks the days that are left: nothing dated up to ${longDay(month.endDay)} can be posted until the month is reopened.`));
  }

  const behind = (f.banks || []).filter((b) => !b.reconciledTo || b.reconciledTo < month.endDay);
  if (behind.length) {
    checks.push(check(
      "BANK_NOT_RECONCILED", "warning", `${plural(behind.length, "bank account is", "bank accounts are")} not reconciled to ${longDay(month.endDay)}`,
      `${behind.map((b) => `${b.accountName} ${b.reconciledTo ? `(to ${longDay(b.reconciledTo)})` : "(never reconciled)"}`).join("; ")}. A bank line dated in a closed month cannot be posted for later.`,
      { accounts: behind.map((b) => b.accountName) }
    ));
  }

  const stock = Y.stockCheck(f, month.endDay);
  if (stock) checks.push(stock);
  return finish(checks);
}

// ------------------------------------------------------------------ may this month be reopened?

// facts: year { code, status, startDay, endDay, lockedThroughDay }, month or null, allBranches,
//        laterYears [code of each later year that holds any lock]
function assessMonthReopen(facts) {
  const f = facts || {};
  const year = f.year || {};
  const month = f.month;
  if (!month) return finish([check("MONTH_NOT_FOUND", "blocker", "That month is not part of this year")]);
  if (year.status === "closed") {
    return finish([check("YEAR_CLOSED", "blocker", `${year.code} is closed`, "Reopen the year first. Its months come back as they were before it was closed, so this one stays closed until you reopen it here.")]);
  }
  if (!monthLocked(year, month.endDay)) return finish([check("NOT_CLOSED", "blocker", `${month.label} is not closed`)]);

  const checks = [];
  checks.push(f.allBranches === false
    ? check("ALL_BRANCHES_REQUIRED", "blocker", "Switch to All branches first", "A month's lock covers every branch, so reopening it is done from head office with the branch switcher on All branches.")
    : check("ALL_BRANCHES", "ok", "Every branch is included"));

  const latest = monthStates(year).filter((m) => m.status === "closed").pop();
  if (latest && latest.key !== month.key) {
    checks.push(check("LATER_MONTH_CLOSED", "blocker", `Reopen ${latest.label} first`, "Months are reopened newest first: a later month was closed on the figures of this one."));
  }
  const later = f.laterYears || [];
  if (later.length) {
    checks.push(check("LATER_YEAR_LOCKED", "blocker", `Reopen the months of ${later.join(", ")} first`, "A later year was closed on the figures of this one, so it is reopened first."));
  }
  if (!checks.some((c) => c.level === "blocker")) checks.push(check("CAN_REOPEN", "ok", `${month.label} can be reopened`));
  return finish(checks);
}

module.exports = {
  monthLabel, monthsOf, findMonth, monthLocked, lockedDayOf, fullyLocked, anyLocked, monthStates, lockedMessage,
  assessMonthClose, assessMonthReopen,
};
