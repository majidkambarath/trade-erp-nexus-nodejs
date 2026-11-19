// Budgets: an amount per income or expense account per month of a fiscal year, compared with what the ledger says happened.
// Pure: no Mongoose, no clock.
//
// A month is its key "YYYY-MM" (utils/periodClose.js monthsOf gives a year's months, clipped to the year). Every figure is the
// account's NATURAL side: income is credits less debits, an expense debits less credits, so a budget and an actual are both
// positive numbers in the normal case and the variance reads the way a person reads it.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const MONTH = /^\d{4}-\d{2}$/;
const BUDGETABLE = new Set(["INCOME", "EXPENSE"]);

/** A total shared over the months, fils-exact: equal parts, the last month takes what rounding left. */
function spreadEvenly(total, months) {
  const keys = (months || []).map((m) => (typeof m === "string" ? m : m.key));
  if (!keys.length) return {};
  const cents = Math.round(round2(total) * 100);
  const each = Math.floor(cents / keys.length);
  const out = {};
  keys.forEach((k, i) => {
    out[k] = (i === keys.length - 1 ? cents - each * (keys.length - 1) : each) / 100;
  });
  return out;
}

const lineTotal = (amounts) => round2(Object.values(amounts || {}).reduce((t, v) => t + (Number(v) || 0), 0));

/**
 * The lines a budget may hold, cleaned. `accounts` is a Map(id -> { category, accountName }). A line names a postable income or expense
 * account once; an amount is a month of the year, not negative, at most two decimals. A month with nothing is left out of the map.
 * Returns { lines } or throws an Error with `code` INVALID_BUDGET and `line` (1-based).
 */
function validateLines(lines, months, accounts) {
  const keys = new Set((months || []).map((m) => (typeof m === "string" ? m : m.key)));
  const seen = new Set();
  const out = [];
  const fail = (message, line) => Object.assign(new Error(message), { code: "INVALID_BUDGET", line });
  (Array.isArray(lines) ? lines : []).forEach((raw, i) => {
    const n = i + 1;
    const id = raw?.accountId ? String(raw.accountId._id || raw.accountId) : "";
    if (!id) throw fail(`Line ${n}: choose an account`, n);
    const acc = accounts.get(id);
    if (!acc) throw fail(`Line ${n}: that account does not exist`, n);
    if (!BUDGETABLE.has(acc.category)) throw fail(`Line ${n}: ${acc.accountName} is not an income or expense account`, n);
    if (seen.has(id)) throw fail(`Line ${n}: ${acc.accountName} is on the budget twice`, n);
    seen.add(id);
    const amounts = {};
    for (const [k, v] of Object.entries(raw.amounts || {})) {
      if (v === "" || v === null || v === undefined) continue;
      if (!MONTH.test(k) || !keys.has(k)) throw fail(`Line ${n}: ${k} is not a month of this year`, n);
      const num = Number(v);
      if (!Number.isFinite(num) || num < 0) throw fail(`Line ${n}: amounts cannot be negative`, n);
      if (Math.abs(round2(num) - num) > 1e-9) throw fail(`Line ${n}: at most two decimals`, n);
      if (num > 0) amounts[k] = round2(num);
    }
    out.push({ accountId: id, amounts });
  });
  return { lines: out };
}

/**
 * Budget against actual for the months asked.
 * @param lines    the budget's lines [{ accountId, amounts }]
 * @param actual   Map(accountId -> Map(month -> natural amount)) from the ledger
 * @param months   the month keys compared (inside the year)
 * @param accounts Map(id -> { category, accountName, accountCode })
 * Every account on the budget is a row; an account with actuals but no budget line is a row too (budget 0), so nothing that
 * happened is hidden. Variance is actual - budget; it is favourable when income is above budget or an expense below it.
 */
function compare(lines, actual, months, accounts) {
  const keys = (months || []).map((m) => (typeof m === "string" ? m : m.key));
  const ids = new Set([...(lines || []).map((l) => String(l.accountId)), ...[...(actual?.keys() || [])].map(String)]);
  const byLine = new Map((lines || []).map((l) => [String(l.accountId), l.amounts || {}]));
  const rows = [];
  for (const id of ids) {
    const acc = accounts.get(id);
    if (!acc || !BUDGETABLE.has(acc.category)) continue;
    const plan = byLine.get(id) || {};
    const got = actual?.get(id) || new Map();
    const monthly = keys.map((k) => ({ month: k, budget: round2(plan[k] || 0), actual: round2(got.get(k) || 0) }));
    const budget = round2(monthly.reduce((t, m) => t + m.budget, 0));
    const done = round2(monthly.reduce((t, m) => t + m.actual, 0));
    if (!budget && !done && !byLine.has(id)) continue;
    const variance = round2(done - budget);
    rows.push({
      accountId: id, accountCode: acc.accountCode || "", accountName: acc.accountName || "", category: acc.category,
      budget, actual: done, variance,
      used: budget ? round2((done / budget) * 100) : null,
      favourable: acc.category === "INCOME" ? variance >= 0 : variance <= 0,
      monthly,
    });
  }
  rows.sort((a, b) => a.category.localeCompare(b.category) || String(a.accountCode).localeCompare(String(b.accountCode)));
  const sum = (cat, k) => round2(rows.filter((r) => r.category === cat).reduce((t, r) => t + r[k], 0));
  const income = { budget: sum("INCOME", "budget"), actual: sum("INCOME", "actual") };
  const expense = { budget: sum("EXPENSE", "budget"), actual: sum("EXPENSE", "actual") };
  income.variance = round2(income.actual - income.budget);
  expense.variance = round2(expense.actual - expense.budget);
  const net = { budget: round2(income.budget - expense.budget), actual: round2(income.actual - expense.actual) };
  net.variance = round2(net.actual - net.budget);
  const series = keys.map((k, i) => {
    const pick = (cat, f) => round2(rows.filter((r) => r.category === cat).reduce((t, r) => t + r.monthly[i][f], 0));
    return { month: k, budgetNet: round2(pick("INCOME", "budget") - pick("EXPENSE", "budget")), actualNet: round2(pick("INCOME", "actual") - pick("EXPENSE", "actual")) };
  });
  return { rows, totals: { income, expense, net }, series };
}

/** Last year's month keys moved onto this year's, in order: the first month of one onto the first of the other. */
function shiftMonths(fromKeys, toKeys) {
  const map = new Map();
  fromKeys.forEach((k, i) => {
    if (toKeys[i]) map.set(k, toKeys[i]);
  });
  return map;
}

module.exports = { BUDGETABLE, spreadEvenly, lineTotal, validateLines, compare, shiftMonths, round2 };
