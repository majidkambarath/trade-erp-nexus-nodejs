// Year-end closing: the rules that need no database (no Mongoose, no request), like utils/plans.js.
//
// Closing a fiscal year does three things, in one transaction (services/financial/yearEndService.js):
//   1. posts ONE closing entry that moves every income and expense balance to Retained Earnings, so the
//      profit becomes equity and the next year's income and expenses start at zero;
//   2. locks the year (nothing can be posted, edited or reversed inside it);
//   3. makes sure the next year exists, so posting carries on the next morning.
// The balance sheet accounts need no entry: the ledger is one running book, so what a year closes with
// is what the next one opens with.
//
// A closing entry is a real posting (voucherType "closing"), but it is not activity. Every report that
// speaks of a period leaves out the closing entries dated INSIDE that period, so the closed year still
// shows the profit it earned; entries dated BEFORE the period count as any other posting, which is what
// carries the profit into Retained Earnings and starts income and expense at zero. See
// services/reports/ledgerReportsService.js (accountMovements).

const CLOSING_VOUCHER_TYPE = "closing";
const EPS = 0.005;
const HEAD_OFFICE = "main";

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const isPnl = (category) => category === "INCOME" || category === "EXPENSE";

// ------------------------------------------------------------------ calendar days ("YYYY-MM-DD")

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// A day a number of months on; the day of the month is kept, or clipped to the last day of a shorter month.
function addMonths(day, months) {
  const [y, m, d] = day.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(d, last))}`;
}

// "2026-12-31" -> "31 Dec 2026" (the wording of a message, not a display format: screens format dates themselves)
function longDay(day) {
  if (!DAY.test(String(day || ""))) return String(day || "");
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// ------------------------------------------------------------------ the next year

// The year that follows [startDay, endDay]. A year of whole months (the usual January-December, or April-March)
// is followed by one of the same number of months; any other length by one of the same number of days.
function nextYearRange(startDay, endDay) {
  if (!DAY.test(startDay || "") || !DAY.test(endDay || "") || endDay < startDay) return null;
  const start = addDays(endDay, 1);
  const wholeMonths = startDay.endsWith("-01") && start.endsWith("-01");
  if (wholeMonths) {
    const [sy, sm] = startDay.split("-").map(Number);
    const [ey, em] = endDay.split("-").map(Number);
    const months = (ey * 12 + em) - (sy * 12 + sm) + 1;
    return { startDay: start, endDay: addDays(addMonths(start, months), -1) };
  }
  return { startDay: start, endDay: addDays(start, daysBetween(startDay, endDay)) };
}

// The name of the year after `code`: "2026" -> "2027", "FY2025-26" -> "FY2026-27", "FY26" -> by the new end date.
function nextYearCode(code, nextEndDay) {
  const text = String(code || "").trim();
  const range = text.match(/^(.*?)(\d{4})(\s*[-/]\s*)(\d{2})$/);
  if (range) return `${range[1]}${Number(range[2]) + 1}${range[3]}${pad((Number(range[4]) + 1) % 100)}`.toUpperCase().slice(0, 20);
  const single = text.match(/^(.*?)(\d{4})$/);
  if (single) return `${single[1]}${Number(single[2]) + 1}`.toUpperCase().slice(0, 20);
  return String(nextEndDay || "").slice(0, 4) || text;
}

// ------------------------------------------------------------------ the closing entry

// rows: the balance of every account, per branch, as at the year end, income and expense accounts included:
//   [{ accountId, accountCode, accountName, branchId, category, debit, credit }]  (cumulative, closing entries of earlier
//   years already counted, so an account closed before reads zero and is left out here).
// Returns what to post. Each branch is closed on its own, so each branch's books still balance and its own income
// and expense start the new year at zero.
function planClosing(rows) {
  const byBranch = new Map();
  const accounts = new Set();
  for (const row of rows || []) {
    if (!isPnl(row.category)) continue;
    const net = r2((row.debit || 0) - (row.credit || 0));
    if (Math.abs(net) < EPS) continue;
    const branchId = row.branchId || HEAD_OFFICE;
    if (!byBranch.has(branchId)) byBranch.set(branchId, { branchId, lines: [], income: 0, expenses: 0 });
    const b = byBranch.get(branchId);
    // the line takes the balance off: an income account (credit balance) is debited, an expense credited
    b.lines.push({
      accountId: String(row.accountId), accountCode: row.accountCode || "", accountName: row.accountName || "", category: row.category,
      debit: net < 0 ? -net : 0, credit: net > 0 ? net : 0,
    });
    accounts.add(String(row.accountId));
    if (row.category === "INCOME") b.income = r2(b.income - net);
    else b.expenses = r2(b.expenses + net);
  }
  const branches = [...byBranch.values()]
    .sort((a, b) => (a.branchId === HEAD_OFFICE ? -1 : b.branchId === HEAD_OFFICE ? 1 : a.branchId.localeCompare(b.branchId)))
    .map((b) => {
      const profit = r2(b.income - b.expenses);
      b.lines.sort((x, y) => (x.category === y.category ? String(x.accountCode).localeCompare(String(y.accountCode)) : x.category === "INCOME" ? -1 : 1));
      // the balancing line to Retained Earnings: a profit is credited to it, a loss debited
      return { ...b, profit, retained: { debit: profit < 0 ? -profit : 0, credit: profit > 0 ? profit : 0 } };
    });
  const income = r2(branches.reduce((t, b) => t + b.income, 0));
  const expenses = r2(branches.reduce((t, b) => t + b.expenses, 0));
  return {
    branches, income, expenses, profit: r2(income - expenses),
    accounts: accounts.size, lines: branches.reduce((t, b) => t + b.lines.length + (Math.abs(b.profit) >= EPS ? 1 : 0), 0),
  };
}

// The ledger entries of a plan. `retained` is { accountId, accountName, accountCode }; `voucher` is
// { voucherId, voucherNo, date, createdBy, yearCode }. A branch whose lines already net to nothing posts no
// Retained Earnings line (it would be a pair of zeros).
function closingEntries(plan, retained, voucher) {
  const base = {
    voucherId: voucher.voucherId, voucherNo: voucher.voucherNo, voucherType: CLOSING_VOUCHER_TYPE, date: voucher.date,
    referenceType: CLOSING_VOUCHER_TYPE, referenceId: voucher.voucherId, referenceNo: voucher.voucherNo,
    financialYear: voucher.yearCode, createdBy: voucher.createdBy,
  };
  const entries = [];
  for (const b of plan.branches) {
    for (const l of b.lines) {
      entries.push({
        ...base, branchId: b.branchId, accountId: l.accountId, accountName: l.accountName, accountCode: l.accountCode,
        debitAmount: l.debit, creditAmount: l.credit, narration: `Year-end closing ${voucher.yearCode} - ${l.accountName}`,
      });
    }
    if (Math.abs(b.profit) >= EPS) {
      entries.push({
        ...base, branchId: b.branchId, accountId: retained.accountId, accountName: retained.accountName, accountCode: retained.accountCode || "",
        debitAmount: b.retained.debit, creditAmount: b.retained.credit,
        narration: `Year-end closing ${voucher.yearCode} - ${b.profit > 0 ? "profit" : "loss"} to ${retained.accountName}`,
      });
    }
  }
  return entries;
}

// Debits equal credits inside every branch. Returns the branches that do not (an empty list is good).
function unbalancedBranches(entries) {
  const sums = new Map();
  for (const e of entries || []) {
    const s = sums.get(e.branchId || HEAD_OFFICE) || { debit: 0, credit: 0 };
    s.debit += e.debitAmount || 0;
    s.credit += e.creditAmount || 0;
    sums.set(e.branchId || HEAD_OFFICE, s);
  }
  return [...sums.entries()].map(([branchId, s]) => ({ branchId, difference: r2(s.debit - s.credit) })).filter((x) => Math.abs(x.difference) >= EPS);
}

// ------------------------------------------------------------------ may this year be closed?

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const money = (n, currency) => `${currency ? `${currency} ` : ""}${r2(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const check = (code, level, title, detail = "", extra = {}) => ({ code, level, title, detail, ...extra });

// Does the stock agree with the Inventory account of the ledger at the closing day? A WARNING the person ticks by name,
// shared by the month close and the year close. `f.stock` is what StockReportsService.ledgerCheck reports (absent: no check).
// While ledger posting is off the POSTING_OFF warning already says the ledger is not receiving anything, so the
// difference would only repeat it. A company with no stock and nothing on the Inventory account has nothing to compare.
function stockCheck(f, atDay) {
  const s = f.stock;
  if (!s || f.postingEnabled === false) return null;
  const cur = f.currency;
  const past = s.basis === "history";
  const how = past ? " It is worked out from the stock movements dated up to that day, as the books stand now: a document reversed or changed since is counted as it is today." : "";
  if (s.error || s.available === false) {
    if (!s.error && Math.abs(s.stockValue || 0) < 0.005) return null;
    return check("STOCK_NOT_RECONCILED", "warning", "Stock could not be compared with the ledger", s.reason || "The Inventory account is not mapped under Accounting setup, Posting accounts.", { difference: null, basis: s.basis || null });
  }
  if (s.reconciles) {
    if (Math.abs(s.stockValue || 0) < 0.005 && Math.abs(s.ledgerBalance || 0) < 0.005) return null;
    return check("STOCK_AGREES", "ok", `Stock agrees with the Inventory ledger (${money(s.stockValue, cur)})`, `At ${longDay(atDay)}.${how}`, { basis: s.basis || null });
  }
  const largest = (s.sources || []).slice(0, 3).map((x) => `${x.label} (stock ${money(x.stock)}, ledger ${money(x.ledger)})`).join("; ");
  return check(
    "STOCK_NOT_RECONCILED", "warning", `Stock differs from the Inventory ledger by ${money(Math.abs(s.difference), cur)}`,
    `At ${longDay(atDay)} the stock is worth ${money(s.stockValue, cur)} and ${s.accountName || "Inventory"} shows ${money(s.ledgerBalance, cur)}.${largest ? ` Largest: ${largest}.` : ""}${how}`,
    { difference: s.difference, stockValue: s.stockValue, ledgerBalance: s.ledgerBalance, basis: s.basis || null, sources: s.sources || [] }
  );
}

// facts (all gathered by the service):
//   year { code, status, startDay, endDay }, today, allBranches, earlierOpen [code], unfinished { documents, vouchers },
//   outOfBalance [{ branchId, difference }], retained { mapped, accountName }, postingEnabled, banks [{ accountName, reconciledTo }],
//   stock (see stockCheck), next { code, exists }, currency
// Returns the checks in the order the screen lists them. A BLOCKER can never be set aside; a WARNING must be
// acknowledged by name (the caller passes the codes it was shown).
function assessClose(facts) {
  const f = facts || {};
  const year = f.year || {};
  const checks = [];

  if (year.status === "closed") {
    checks.push(check("ALREADY_CLOSED", "blocker", `${year.code} is already closed`));
    return finish(checks);
  }

  checks.push(f.allBranches === false
    ? check("ALL_BRANCHES_REQUIRED", "blocker", "Switch to All branches first", "Closing a year covers every branch, so it is done from head office with the branch switcher on All branches.")
    : check("ALL_BRANCHES", "ok", "Every branch is included"));

  const earlier = f.earlierOpen || [];
  checks.push(earlier.length
    ? check("EARLIER_YEAR_OPEN", "blocker", `Close ${earlier.join(", ")} first`, "Years are closed oldest first, so each year's profit reaches Retained Earnings before the next is closed.")
    : check("EARLIER_YEARS_CLOSED", "ok", "No earlier year is left open"));

  const un = f.unfinished || {};
  const unfinished = (un.documents || 0) + (un.vouchers || 0);
  checks.push(unfinished
    ? check(
        "UNFINISHED_DOCUMENTS", "blocker",
        `${[un.documents ? plural(un.documents, "document", "documents") : "", un.vouchers ? plural(un.vouchers, "voucher", "vouchers") : ""].filter(Boolean).join(" and ")} dated in ${year.code} ${unfinished === 1 ? "is" : "are"} not approved`,
        "Approve, reject or delete them, or change their date. Once the year is closed they can no longer be approved.",
        { documents: un.documents || 0, vouchers: un.vouchers || 0 }
      )
    : check("DOCUMENTS_FINISHED", "ok", `Every document dated in ${year.code} is approved, rejected or cancelled`));

  const off = f.outOfBalance || [];
  checks.push(off.length
    ? check("LEDGER_OUT_OF_BALANCE", "blocker", "The ledger does not balance", off.map((o) => `${o.branchId === HEAD_OFFICE ? "Head office" : o.branchId}: debits and credits differ by ${money(Math.abs(o.difference), f.currency)}`).join("; "))
    : check("LEDGER_BALANCED", "ok", "Debits equal credits"));

  const retained = f.retained || {};
  checks.push(retained.mapped
    ? check("RETAINED_EARNINGS", "ok", `The profit goes to ${retained.accountName || "Retained Earnings"}`)
    : check("RETAINED_EARNINGS_NOT_MAPPED", "blocker", "No Retained Earnings account is set", "Choose an equity account for \"Retained earnings\" in Accounting setup, under Posting accounts."));

  if (f.postingEnabled === false) {
    checks.push(check("POSTING_OFF", "warning", "Ledger posting is switched off", "There are no ledger entries to close, so the year is only locked. Switch posting on first if the books should carry the profit forward."));
  }

  if (f.today && year.endDay && f.today < year.endDay) {
    checks.push(check("YEAR_NOT_ENDED", "warning", `${year.code} runs until ${longDay(year.endDay)}`, "Closing now locks the days that are left: nothing dated up to the end of the year can be posted until the year is reopened."));
  }

  const behind = (f.banks || []).filter((b) => !b.reconciledTo || b.reconciledTo < year.endDay);
  if (behind.length) {
    checks.push(check(
      "BANK_NOT_RECONCILED", "warning", `${plural(behind.length, "bank account is", "bank accounts are")} not reconciled to ${longDay(year.endDay)}`,
      behind.map((b) => `${b.accountName} ${b.reconciledTo ? `(to ${longDay(b.reconciledTo)})` : "(never reconciled)"}`).join("; "),
      { accounts: behind.map((b) => b.accountName) }
    ));
  }

  const stock = stockCheck(f, year.endDay);
  if (stock) checks.push(stock);

  const next = f.next || {};
  if (next.conflict) {
    checks.push(check("NEXT_YEAR_CONFLICT", "blocker", `A year that overlaps ${next.code || "the next year"} already exists`, "Add the missing year in Fiscal years (starting the day after this one ends), then close this one."));
  } else if (next.code) {
    checks.push(next.exists
      ? check("NEXT_YEAR_READY", "ok", `${next.code} is ready to carry on`)
      : check("NEXT_YEAR_CREATED", "ok", `${next.code} will be created`, "The balances close into it, so posting carries on without a gap."));
  }
  return finish(checks);
}

function finish(checks) {
  const blockers = checks.filter((c) => c.level === "blocker");
  const warnings = checks.filter((c) => c.level === "warning");
  return { checks, blockers, warnings, canClose: blockers.length === 0 };
}

// The warnings a request has not acknowledged (it names the codes it was shown).
function unacknowledged(assessment, acknowledged) {
  const given = new Set(Array.isArray(acknowledged) ? acknowledged.map(String) : []);
  return (assessment?.warnings || []).filter((w) => !given.has(w.code));
}

// May a closed year be reopened? Only the latest closed one: a later year was closed on the premise that this
// one stays as it is.
function assessReopen(facts) {
  const f = facts || {};
  const year = f.year || {};
  if (year.status !== "closed") return finish([check("NOT_CLOSED", "blocker", `${year.code} is not closed`)]);
  const later = f.laterClosed || [];
  if (later.length) {
    return finish([check("LATER_YEAR_CLOSED", "blocker", `Reopen ${later.join(", ")} first`, "Years are reopened newest first: a later year was closed on the figures of this one.")]);
  }
  const lockedLater = f.laterMonthLocked || [];
  if (lockedLater.length) {
    return finish([check("LATER_MONTHS_CLOSED", "blocker", `Reopen the months of ${lockedLater.join(", ")} first`, "A later year has months closed on the figures of this one, so those are reopened first.")]);
  }
  return finish([check("CAN_REOPEN", "ok", `${year.code} can be reopened`)]);
}

module.exports = {
  CLOSING_VOUCHER_TYPE, HEAD_OFFICE, isPnl,
  addDays, addMonths, daysBetween, longDay, nextYearRange, nextYearCode,
  planClosing, closingEntries, unbalancedBranches,
  assessClose, assessReopen, unacknowledged,
  // shared with the month close (utils/periodClose.js)
  check, finish, money, plural, stockCheck,
};
