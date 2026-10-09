const test = require("node:test");
const assert = require("node:assert/strict");
const Y = require("../yearEnd");

// ----------------------------------------------------------------------------- the next year

test("the next year has the same number of months, or the same number of days", () => {
  assert.deepEqual(Y.nextYearRange("2026-01-01", "2026-12-31"), { startDay: "2027-01-01", endDay: "2027-12-31" });
  assert.deepEqual(Y.nextYearRange("2027-01-01", "2027-12-31"), { startDay: "2028-01-01", endDay: "2028-12-31" }, "a leap year follows");
  assert.deepEqual(Y.nextYearRange("2025-04-01", "2026-03-31"), { startDay: "2026-04-01", endDay: "2027-03-31" }, "April to March");
  assert.deepEqual(Y.nextYearRange("2026-01-01", "2027-02-28"), { startDay: "2027-03-01", endDay: "2028-04-30" }, "a 14-month first year is followed by 14 months");
  // not whole months: the same number of days (351 here, 15 Jan to 31 Dec inclusive)
  assert.deepEqual(Y.nextYearRange("2026-01-15", "2026-12-31"), { startDay: "2027-01-01", endDay: "2027-12-17" });
  assert.equal(Y.nextYearRange("2026-12-31", "2026-01-01"), null, "an upside-down year has no successor");
  assert.equal(Y.nextYearRange("", "2026-12-31"), null);
});

test("the next year's name follows the old one's pattern", () => {
  assert.equal(Y.nextYearCode("2026", "2027-12-31"), "2027");
  assert.equal(Y.nextYearCode("FY2026", "2027-12-31"), "FY2027");
  assert.equal(Y.nextYearCode("FY2025-26", "2027-03-31"), "FY2026-27");
  assert.equal(Y.nextYearCode("2099-00", "2100-12-31"), "2100-01");
  assert.equal(Y.nextYearCode("Trading year", "2027-12-31"), "2027", "a name with no year in it is named by the new end date");
  assert.ok(Y.nextYearCode("A".repeat(18) + "2026", "2027-12-31").length <= 20);
});

test("month arithmetic keeps the day, or the last day of a shorter month", () => {
  assert.equal(Y.addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(Y.addMonths("2028-01-31", 1), "2028-02-29");
  assert.equal(Y.addMonths("2026-11-15", 3), "2027-02-15");
  assert.equal(Y.addMonths("2026-03-15", -3), "2025-12-15");
  assert.equal(Y.longDay("2026-12-31"), "31 Dec 2026");
});

// ----------------------------------------------------------------------------- the closing entry

const row = (accountId, name, category, branchId, debit, credit, code = "") => ({ accountId, accountName: name, accountCode: code || name, category, branchId, debit, credit });

const ROWS = [
  row("a1", "Bank", "ASSET", "main", 5000, 0), // not closed: a balance sheet account
  row("eq", "Owner's Capital", "EQUITY", "main", 0, 5000),
  row("i1", "Sales Revenue", "INCOME", "main", 0, 1000, "SAL01"),
  row("e1", "Cost of Goods Sold", "EXPENSE", "main", 600, 0, "COGS1"),
  row("e2", "Rent", "EXPENSE", "main", 100, 0, "OPEX1"),
  row("i1", "Sales Revenue", "INCOME", "shj", 0, 200, "SAL01"), // Sharjah earned 200 ...
  row("e2", "Rent", "EXPENSE", "shj", 250, 0, "OPEX1"), //          ... and spent 250: a loss of 50
  row("i2", "Other Income", "INCOME", "main", 40, 40), // nets to nothing: left out
  row("e3", "Refunded Rent", "EXPENSE", "main", 0, 30, "OPEX2"), // an expense with a credit balance
];

test("every income and expense balance is taken off, branch by branch, and the difference goes to Retained Earnings", () => {
  const plan = Y.planClosing(ROWS);
  assert.deepEqual(plan.branches.map((b) => b.branchId), ["main", "shj"], "head office first");
  const [main, shj] = plan.branches;

  assert.equal(main.income, 1000);
  assert.equal(main.expenses, 670, "600 + 100, less the 30 refunded");
  assert.equal(main.profit, 330);
  assert.deepEqual(main.retained, { debit: 0, credit: 330 }, "a profit is credited to Retained Earnings");
  const line = (b, id) => b.lines.find((l) => l.accountId === id);
  assert.deepEqual([line(main, "i1").debit, line(main, "i1").credit], [1000, 0], "income is debited to bring it to zero");
  assert.deepEqual([line(main, "e1").debit, line(main, "e1").credit], [0, 600], "an expense is credited");
  assert.deepEqual([line(main, "e3").debit, line(main, "e3").credit], [30, 0], "an expense with a credit balance is debited");
  assert.equal(line(main, "i2"), undefined, "an account that nets to nothing posts nothing");
  assert.equal(line(main, "a1"), undefined, "a balance sheet account is never closed");
  assert.equal(line(main, "eq"), undefined);

  assert.equal(shj.profit, -50);
  assert.deepEqual(shj.retained, { debit: 50, credit: 0 }, "a loss is debited to Retained Earnings");

  assert.equal(plan.income, 1200);
  assert.equal(plan.expenses, 920);
  assert.equal(plan.profit, 280, "the whole business: 330 at head office, a 50 loss in Sharjah");
  assert.equal(plan.accounts, 4, "Sales, COGS, Rent, Refunded Rent");
});

test("the closing entries balance inside every branch, and leave each income and expense account at zero", () => {
  const plan = Y.planClosing(ROWS);
  const retained = { accountId: "re", accountName: "Retained Earnings", accountCode: "EQ02" };
  const entries = Y.closingEntries(plan, retained, { voucherId: "fy1", voucherNo: "YEC-2026-0001", date: new Date("2026-12-31T00:00:00Z"), createdBy: "u1", yearCode: "2026" });

  assert.deepEqual(Y.unbalancedBranches(entries), [], "debits equal credits in each branch");
  assert.ok(entries.every((e) => e.voucherType === "closing" && e.voucherNo === "YEC-2026-0001" && e.financialYear === "2026"));
  assert.ok(entries.every((e) => (e.debitAmount > 0) !== (e.creditAmount > 0)), "a line is a debit or a credit, never both or neither");

  // applied on top of the balances, every income and expense account reads zero in every branch
  const after = new Map();
  for (const r of ROWS) after.set(`${r.branchId}|${r.accountId}`, { ...r });
  for (const e of entries) {
    const key = `${e.branchId}|${e.accountId}`;
    const cur = after.get(key) || { debit: 0, credit: 0, category: e.accountId === "re" ? "EQUITY" : "?" };
    after.set(key, { ...cur, debit: cur.debit + e.debitAmount, credit: cur.credit + e.creditAmount });
  }
  for (const [key, r] of after) {
    if (r.category === "INCOME" || r.category === "EXPENSE") assert.equal(Math.round((r.debit - r.credit) * 100), 0, `${key} is back to zero`);
  }
  const reMain = entries.find((e) => e.accountId === "re" && e.branchId === "main");
  assert.equal(reMain.creditAmount, 330);
  const reShj = entries.find((e) => e.accountId === "re" && e.branchId === "shj");
  assert.equal(reShj.debitAmount, 50);
});

test("a year with nothing to close plans nothing, and a branch that nets to nothing posts no Retained Earnings line", () => {
  const empty = Y.planClosing([row("a1", "Bank", "ASSET", "main", 10, 0), row("i1", "Sales", "INCOME", "main", 5, 5)]);
  assert.deepEqual(empty, { branches: [], income: 0, expenses: 0, profit: 0, accounts: 0, lines: 0 });
  assert.deepEqual(Y.closingEntries(empty, { accountId: "re", accountName: "RE" }, { voucherId: "x", voucherNo: "n", date: new Date(), createdBy: "u", yearCode: "2026" }), []);

  // 100 of income and 100 of expense: both are closed, and no Retained Earnings line carries the zero
  const breakEven = Y.planClosing([row("i1", "Sales", "INCOME", "main", 0, 100), row("e1", "Rent", "EXPENSE", "main", 100, 0)]);
  assert.equal(breakEven.profit, 0);
  const entries = Y.closingEntries(breakEven, { accountId: "re", accountName: "RE" }, { voucherId: "x", voucherNo: "n", date: new Date(), createdBy: "u", yearCode: "2026" });
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.accountId !== "re"));
  assert.deepEqual(Y.unbalancedBranches(entries), []);
});

test("an earlier closing counts: a year already closed reads zero and is not closed twice", () => {
  // the 2026 closing entry took Sales (credit 1000) to zero; 2027 earned 300 more, so the balance as at 2027 is 300
  const plan = Y.planClosing([row("i1", "Sales", "INCOME", "main", 1000, 1300)]);
  assert.equal(plan.profit, 300);
  assert.deepEqual(plan.branches[0].lines.map((l) => [l.accountId, l.debit, l.credit]), [["i1", 300, 0]]);
});

test("the unbalanced check names the branch and the amount", () => {
  assert.deepEqual(
    Y.unbalancedBranches([{ branchId: "main", debitAmount: 10, creditAmount: 0 }, { branchId: "main", debitAmount: 0, creditAmount: 10 }, { branchId: "shj", debitAmount: 5, creditAmount: 0 }]),
    [{ branchId: "shj", difference: 5 }]
  );
});

// ----------------------------------------------------------------------------- may it be closed?

const GOOD = {
  year: { code: "2026", status: "open", startDay: "2026-01-01", endDay: "2026-12-31" }, today: "2027-01-05", allBranches: true,
  earlierOpen: [], unfinished: { documents: 0, vouchers: 0 }, outOfBalance: [], retained: { mapped: true, accountName: "Retained Earnings" },
  postingEnabled: true, banks: [{ accountName: "ENBD", reconciledTo: "2026-12-31" }], next: { code: "2027", exists: false }, currency: "AED",
};
const codes = (a, level) => a.checks.filter((c) => c.level === level).map((c) => c.code);

test("a tidy year that has ended can be closed, with nothing to acknowledge", () => {
  const a = Y.assessClose(GOOD);
  assert.equal(a.canClose, true);
  assert.deepEqual(a.blockers, []);
  assert.deepEqual(a.warnings, []);
  assert.ok(codes(a, "ok").includes("NEXT_YEAR_CREATED"));
  assert.deepEqual(Y.unacknowledged(a, []), []);
});

test("each thing that makes closing wrong is a blocker that cannot be set aside", () => {
  const blocked = (patch) => codes(Y.assessClose({ ...GOOD, ...patch }), "blocker");
  assert.deepEqual(blocked({ year: { ...GOOD.year, status: "closed" } }), ["ALREADY_CLOSED"]);
  assert.deepEqual(blocked({ allBranches: false }), ["ALL_BRANCHES_REQUIRED"]);
  assert.deepEqual(blocked({ earlierOpen: ["2025"] }), ["EARLIER_YEAR_OPEN"]);
  assert.deepEqual(blocked({ unfinished: { documents: 3, vouchers: 0 } }), ["UNFINISHED_DOCUMENTS"]);
  assert.deepEqual(blocked({ unfinished: { documents: 0, vouchers: 1 } }), ["UNFINISHED_DOCUMENTS"]);
  assert.deepEqual(blocked({ outOfBalance: [{ branchId: "main", difference: 0.5 }] }), ["LEDGER_OUT_OF_BALANCE"]);
  assert.deepEqual(blocked({ retained: { mapped: false } }), ["RETAINED_EARNINGS_NOT_MAPPED"]);
  const several = Y.assessClose({ ...GOOD, earlierOpen: ["2025"], retained: { mapped: false } });
  assert.equal(several.canClose, false);
  assert.equal(several.blockers.length, 2, "all the reasons are given at once");
});

test("the unfinished work is counted in words a person can act on", () => {
  const a = Y.assessClose({ ...GOOD, unfinished: { documents: 3, vouchers: 1 } });
  const c = a.blockers[0];
  assert.match(c.title, /3 documents and 1 voucher dated in 2026 are not approved/);
  assert.deepEqual([c.documents, c.vouchers], [3, 1]);
  assert.match(Y.assessClose({ ...GOOD, unfinished: { documents: 1, vouchers: 0 } }).blockers[0].title, /1 document dated in 2026 is not approved/);
});

test("warnings can be acknowledged by name, one by one", () => {
  const a = Y.assessClose({ ...GOOD, today: "2026-10-09", postingEnabled: false, banks: [{ accountName: "ENBD", reconciledTo: "2026-09-30" }, { accountName: "Mashreq", reconciledTo: null }, { accountName: "RAK", reconciledTo: "2026-12-31" }] });
  assert.equal(a.canClose, true, "warnings do not stop it, they must be acknowledged");
  assert.deepEqual(a.warnings.map((w) => w.code), ["POSTING_OFF", "YEAR_NOT_ENDED", "BANK_NOT_RECONCILED"]);
  assert.match(a.warnings[1].title, /2026 runs until 31 Dec 2026/);
  assert.match(a.warnings[2].detail, /ENBD \(to 30 Sep 2026\); Mashreq \(never reconciled\)/);
  assert.ok(!/RAK/.test(a.warnings[2].detail), "an account reconciled to the year end is fine");

  assert.deepEqual(Y.unacknowledged(a, []).map((w) => w.code), ["POSTING_OFF", "YEAR_NOT_ENDED", "BANK_NOT_RECONCILED"]);
  assert.deepEqual(Y.unacknowledged(a, ["YEAR_NOT_ENDED"]).map((w) => w.code), ["POSTING_OFF", "BANK_NOT_RECONCILED"]);
  assert.deepEqual(Y.unacknowledged(a, ["POSTING_OFF", "YEAR_NOT_ENDED", "BANK_NOT_RECONCILED"]), []);
  assert.deepEqual(Y.unacknowledged(a, "YEAR_NOT_ENDED").length, 3, "anything but a list acknowledges nothing");
  assert.deepEqual(Y.unacknowledged(a, null).length, 3);
});

test("a year is reopened newest first", () => {
  const year = { code: "2026", status: "closed" };
  assert.equal(Y.assessReopen({ year, laterClosed: [] }).canClose, true);
  const refused = Y.assessReopen({ year, laterClosed: ["2027"] });
  assert.equal(refused.canClose, false);
  assert.equal(refused.blockers[0].code, "LATER_YEAR_CLOSED");
  assert.match(refused.blockers[0].title, /Reopen 2027 first/);
  assert.equal(Y.assessReopen({ year: { code: "2026", status: "open" }, laterClosed: [] }).blockers[0].code, "NOT_CLOSED");
});
