// Closing a fiscal year: the closing entry that takes income and expense to Retained Earnings, the lock, the next
// year, the balances the next year opens with, what every report makes of a closing entry, branches, reopening and
// two people closing at once. Throwaway database; see accountingFoundation.test.js.
//
// The years are 2088-2092, far enough ahead that none of them has "ended" whichever day this runs, so every close
// has to acknowledge that warning and the test is the same in any year.
//
//   npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const admin = new mongoose.Types.ObjectId();
const req = { admin: { id: String(admin) } };
const ACK = { acknowledge: ["YEAR_NOT_ENDED"] };
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

let svc;
let A = {}; // accounts by name
let years = {}; // fiscal years by code

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Financial: require("../financial/financialService"),
    Config: require("../financial/accountConfigService"),
    YearEnd: require("../financial/yearEndService"),
    Reports: require("../reports/ledgerReportsService"),
    Ifrs: require("../reports/ifrsReportsService"),
    Dash: require("../reports/dashboardQueries"),
    Tx: require("../orderPurchase/transactionService"),
    FiscalYear: require("../core/fiscalYearService"),
    FYModel: require("../../models/modules/financial/fiscalYearModel"),
    Branch: require("../../models/core/branchModel"),
    ...require("../../models/modules/financial/financialModels"),
    Transaction: require("../../models/modules/transactionModel"),
    Customer: require("../../models/modules/customerModel"),
    Stock: require("../../models/modules/stockModel"),
    tenant: require("../../utils/tenantContext"),
    orgLocale: require("../../utils/orgLocale"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);

  // the default current year is replaced by years that cannot have ended yet
  await svc.FYModel.deleteMany({});
  for (const code of ["2088", "2089", "2090"]) {
    years[code] = await svc.FiscalYear.create({ code, startDate: svc.orgLocale.dayStart(`${code}-01-01`), endDate: svc.orgLocale.endOfDay(`${code}-12-31`) }, req);
  }
  for (const n of ["Cash in Hand", "Owner's Capital", "Other Income", "Rent Expense", "Utilities", "Retained Earnings", "Bank Account"]) {
    A[n] = await svc.LedgerAccount.findOne({ accountName: n });
  }
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const day = (d) => new Date(`${d}T00:00:00.000Z`);
const journal = (d, debit, credit, amount, narration = "test") =>
  svc.Financial.createVoucher({ voucherType: "journal", date: day(d), narration, lines: [{ accountId: A[debit]._id, debit: amount }, { accountId: A[credit]._id, credit: amount }] }, admin);
const live = (filter = {}) => svc.LedgerEntry.find({ isReversed: { $ne: true }, ...filter }).lean();
const net = async (name, filter = {}) => r2((await live({ accountId: A[name]._id, ...filter })).reduce((t, e) => t + e.debitAmount - e.creditAmount, 0));
const stored = async (name) => (await svc.LedgerAccount.findById(A[name]._id).lean()).currentBalance;
const gl = async (from, to, opts = {}) => {
  const rep = await svc.Reports.generalLedger({ from, to, includeZero: true, ...opts });
  return (name) => rep.groups.flatMap((g) => g.accounts).find((a) => a.accountName === name);
};
const ledgerBalanced = async () => {
  const entries = await live();
  const byBranch = new Map();
  for (const e of entries) byBranch.set(e.branchId, r2((byBranch.get(e.branchId) || 0) + e.debitAmount - e.creditAmount));
  return [...byBranch.values()].every((v) => v === 0);
};
const refused = (promise, code) => assert.rejects(() => promise, (e) => e.code === code, `expected ${code}`);

// ----------------------------------------------------------------------------------------------- set-up

test("the books of three years: 2088 (locked the old way), 2089 and 2090", { skip }, async () => {
  await journal("2088-05-01", "Cash in Hand", "Other Income", 100); // 2088 earned 100
  await journal("2089-01-10", "Cash in Hand", "Owner's Capital", 10000);
  await journal("2089-04-01", "Cash in Hand", "Other Income", 800);
  await journal("2089-06-01", "Rent Expense", "Cash in Hand", 300);
  await journal("2089-07-01", "Utilities", "Cash in Hand", 100); // 2089 earned 800 - 400 = 400
  await journal("2090-02-01", "Cash in Hand", "Other Income", 5000);
  await journal("2090-03-01", "Rent Expense", "Cash in Hand", 1000); // 2090 will earn 4000
  assert.equal(await net("Other Income"), -5900);
  assert.equal(await ledgerBalanced(), true);
});

// ----------------------------------------------------------------------------------------------- the rules

test("a year closed the old way, a lock only, reopens with nothing to reverse", { skip }, async () => {
  await svc.FiscalYear.setStatus(years["2088"]._id, "closed", admin); // as every year was closed before closing entries existed
  const before = await svc.LedgerEntry.countDocuments();
  const pre = await svc.YearEnd.preview(years["2088"]._id, req);
  assert.equal(pre.year.status, "closed");
  assert.equal(pre.closing, null, "no closing entry was ever made for it");
  assert.equal(pre.reopen.canReopen, true);

  const out = await svc.YearEnd.reopen(years["2088"]._id, req);
  assert.equal(out.year.status, "open");
  assert.equal(await svc.LedgerEntry.countDocuments(), before, "no entries were made or reversed");
  await svc.FiscalYear.setStatus(years["2088"]._id, "closed", admin);
});

test("a company whose posting map predates the Retained Earnings key has it mapped for them, not refused", { skip }, async () => {
  await svc.Config.updateMappings([{ configKey: "retained-earnings", targetAccount: null }]);
  await assert.rejects(() => svc.Config.resolveAccount("retained-earnings"), { code: "ACCOUNT_NOT_CONFIGURED" });
  const pre = await svc.YearEnd.preview(years["2089"]._id, req);
  assert.equal(pre.retained.accountName, "Retained Earnings");
  assert.equal(pre.blockers.some((b) => b.code === "RETAINED_EARNINGS_NOT_MAPPED"), false);
  assert.equal(String(await svc.Config.resolveAccount("retained-earnings")), String(A["Retained Earnings"]._id), "mapped onto the default account, as the chart's own top-up does");

  // a mapping the company chose itself is never overwritten by the top-up
  const equity = await svc.LedgerAccount.findOne({ accountName: "Owner's Capital" });
  await svc.Config.updateMappings([{ configKey: "retained-earnings", targetAccount: equity._id }]);
  assert.equal((await svc.YearEnd.preview(years["2089"]._id, req)).retained.accountName, "Owner's Capital", "a company's own choice is respected");
  await svc.Config.updateMappings([{ configKey: "retained-earnings", targetAccount: A["Retained Earnings"]._id }]);
});

test("years are closed oldest first, and every reason is given at once", { skip }, async () => {
  const pre = await svc.YearEnd.preview(years["2090"]._id, req);
  assert.equal(pre.canClose, false);
  assert.deepEqual(pre.blockers.map((b) => b.code), ["EARLIER_YEAR_OPEN"]);
  assert.match(pre.blockers[0].title, /Close 2089 first/);
  await refused(svc.YearEnd.close(years["2090"]._id, ACK, req), "YEAR_CLOSE_BLOCKED");
  assert.equal((await svc.FYModel.findById(years["2090"]._id)).status, "open", "nothing happened");
  assert.equal(await svc.LedgerEntry.countDocuments({ voucherType: "closing" }), 0);
});

test("the preview says what closing would do: the year's profit, older profit never closed, and what the next year opens with", { skip }, async () => {
  const pre = await svc.YearEnd.preview(years["2089"]._id, req);
  assert.equal(pre.canClose, true);
  assert.deepEqual(pre.warnings.map((w) => w.code), ["YEAR_NOT_ENDED"]);
  assert.equal(pre.willPost, true);
  assert.deepEqual([pre.figures.yearIncome, pre.figures.yearExpenses, pre.figures.yearProfit], [800, 400, 400]);
  assert.equal(pre.figures.broughtForward, 100, "2088 was only locked: its 100 of profit never reached equity");
  assert.equal(pre.figures.profit, 500, "so this closing takes both");
  assert.equal(pre.figures.accounts, 3, "Other Income, Rent, Utilities");
  assert.equal(pre.figures.carriedForward.balanced, true);
  assert.equal(pre.retained.accountName, "Retained Earnings");
  assert.deepEqual([pre.next.code, pre.next.exists], ["2090", true]);
  assert.equal(pre.branches.length, 1);
  assert.equal(pre.branches[0].profit, 500);
  assert.equal(await svc.LedgerEntry.countDocuments({ voucherType: "closing" }), 0, "a preview posts nothing");
});

test("a warning must be acknowledged by name; without it nothing changes", { skip }, async () => {
  const entries = await svc.LedgerEntry.countDocuments();
  await refused(svc.YearEnd.close(years["2089"]._id, {}, req), "YEAR_CLOSE_WARNINGS");
  await refused(svc.YearEnd.close(years["2089"]._id, { acknowledge: ["SOMETHING_ELSE"] }, req), "YEAR_CLOSE_WARNINGS");
  assert.equal((await svc.FYModel.findById(years["2089"]._id)).status, "open");
  assert.equal(await svc.LedgerEntry.countDocuments(), entries);
});

test("unfinished documents dated in the year stop the close, and say how many", { skip }, async () => {
  const customer = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", creditLimit: 500 });
  const rice = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: new mongoose.Types.ObjectId() });
  const draft = await svc.Tx.createTransaction({
    type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", date: day("2089-09-01"),
    items: [{ itemId: rice._id, description: "Rice", qty: 1, price: 10, rate: 10, vatPercent: 5 }],
  }, "tester");
  const pre = await svc.YearEnd.preview(years["2089"]._id, req);
  assert.equal(pre.canClose, false);
  assert.deepEqual(pre.blockers.map((b) => b.code), ["UNFINISHED_DOCUMENTS"]);
  assert.equal(pre.blockers[0].documents, 1);
  assert.match(pre.blockers[0].title, /1 document dated in 2089 is not approved/);
  await refused(svc.YearEnd.close(years["2089"]._id, ACK, req), "YEAR_CLOSE_BLOCKED");

  // a draft dated in another year is another year's business
  assert.equal((await svc.YearEnd.preview(years["2090"]._id, req)).blockers.some((b) => b.code === "UNFINISHED_DOCUMENTS"), false);

  await svc.Transaction.deleteOne({ _id: draft._id });
  assert.equal((await svc.YearEnd.preview(years["2089"]._id, req)).canClose, true);
});

// ----------------------------------------------------------------------------------------------- closing 2089

let closing2089;

test("closing posts one balanced entry that takes income and expense to Retained Earnings, locks the year and keeps the next", { skip }, async () => {
  const res = await svc.YearEnd.close(years["2089"]._id, ACK, req);
  closing2089 = res.closing;
  assert.equal(res.year.status, "closed");
  assert.equal(res.closedNow, true);
  assert.equal(res.closing.posted, true);
  assert.match(res.closing.voucherNo, /^YEC-2089-0001$/);
  assert.equal(res.closing.profit, 500);
  assert.equal(res.closing.retainedAccountName, "Retained Earnings");
  assert.deepEqual(res.closing.acknowledged, ["YEAR_NOT_ENDED"]);
  assert.equal(res.closing.nextYearCreated, false, "2090 already existed");

  const entries = await live({ voucherType: "closing" });
  assert.equal(entries.length, 4, "Other Income, Rent, Utilities and Retained Earnings");
  assert.ok(entries.every((e) => e.voucherNo === res.closing.voucherNo && String(e.voucherId) === String(res.closing.voucherId)));
  assert.ok(entries.every((e) => e.date.toISOString().slice(0, 10) === "2089-12-31"), "dated the last day of the year");
  const line = (name) => entries.find((e) => e.accountName === name);
  assert.deepEqual([line("Other Income").debitAmount, line("Other Income").creditAmount], [900, 0], "100 from 2088 and 800 from 2089");
  assert.deepEqual([line("Rent Expense").debitAmount, line("Rent Expense").creditAmount], [0, 300]);
  assert.deepEqual([line("Utilities").debitAmount, line("Utilities").creditAmount], [0, 100]);
  assert.deepEqual([line("Retained Earnings").debitAmount, line("Retained Earnings").creditAmount], [0, 500]);
  assert.equal(entries.reduce((t, e) => t + e.debitAmount - e.creditAmount, 0), 0);
  assert.equal(await ledgerBalanced(), true);

  // stored balances follow: income and expense for 2089 are back to nothing, equity has the profit
  assert.equal(await stored("Other Income"), 5000, "only 2090's 5000 is left");
  assert.equal(await stored("Retained Earnings"), 500);
  assert.equal(await stored("Rent Expense"), 1000);
  assert.equal(await stored("Utilities"), 0);

  const fy = await svc.FYModel.findById(years["2089"]._id).lean();
  assert.equal(fy.status, "closed");
  assert.equal(fy.closing.voucherNo, res.closing.voucherNo);
});

test("the closed year is locked: nothing can be posted or reversed in it", { skip }, async () => {
  await refused(journal("2089-12-01", "Rent Expense", "Cash in Hand", 5), "PERIOD_CLOSED");
  await refused(svc.YearEnd.close(years["2089"]._id, ACK, req), "ALREADY_CLOSED");
});

test("a report of the closed year still shows the profit it earned", { skip }, async () => {
  const pl = await svc.Reports.profitAndLoss({ from: "2089-01-01", to: "2089-12-31" });
  assert.equal(pl.netProfit, 400, "the year's own profit; the closing entry is not activity");
  assert.equal(pl.otherIncome.total, 800);
  assert.equal(pl.operatingExpenses.total, 400);

  const rep = await gl("2089-01-01", "2089-12-31");
  assert.equal(rep("Other Income").closing, -900, "before the closing entry (2088's 100 was never closed, so it is still here)");
  assert.equal(rep("Retained Earnings").closing, 0);

  const after = await gl("2089-01-01", "2089-12-31", { includeClosing: true });
  assert.equal(after("Other Income").closing, 0, "the post-closing view: income taken to nothing");
  assert.equal(after("Retained Earnings").closing, -500, "and the profit in equity (credit)");
  assert.equal(after("Rent Expense").closing, 0);

  // the legacy trial balance and balance sheet follow the same rule
  const tb = await svc.Financial.getTrialBalance("2089-01-01T00:00:00.000Z", "2089-12-31T23:59:59.999Z");
  const row = (rows, name) => rows.trialBalance.find((r) => r.accountName === name);
  assert.equal(row(tb, "Other Income").balance, 900);
  assert.equal(row(tb, "Retained Earnings").balance, 0, "nothing in it before the closing entry");
  assert.equal(tb.summary.isBalanced, true);
  const tbAfter = await svc.Financial.getTrialBalance("2089-01-01T00:00:00.000Z", "2089-12-31T23:59:59.999Z", { includeClosing: true });
  assert.equal(row(tbAfter, "Other Income").balance, 0, "closed to nothing");
  assert.equal(row(tbAfter, "Retained Earnings").balance, 500);
  assert.equal(tbAfter.summary.isBalanced, true);
});

test("the next year opens with what the old one closed with, and income and expense start at zero", { skip }, async () => {
  const closed = await gl("2089-01-01", "2089-12-31", { includeClosing: true });
  const open = await gl("2090-01-01", "2090-12-31");
  for (const name of ["Cash in Hand", "Owner's Capital", "Retained Earnings"]) {
    assert.equal(open(name).opening, closed(name).closing, `${name} opens with what it closed with`);
  }
  assert.equal(open("Retained Earnings").opening, -500);
  for (const name of ["Other Income", "Rent Expense", "Utilities"]) {
    assert.equal(open(name).opening, 0, `${name} starts the year at zero`);
  }
  assert.equal(open("Other Income").closing, -5000, "only 2090's own income");
  assert.equal(open("Cash in Hand").opening, 10000 + 100 + 800 - 300 - 100);

  const pl = await svc.Reports.profitAndLoss({ from: "2090-01-01", to: "2090-12-31" });
  assert.equal(pl.netProfit, 4000);
});

test("the balance sheet in the next year carries the closed years' profit in Retained Earnings and this year's beside it", { skip }, async () => {
  const sheet = await svc.Financial.getBalanceSheet("2090-06-30T23:59:59.999Z");
  assert.equal(sheet.isBalanced, true);
  assert.equal(sheet.equity.find((e) => e.accountName === "Retained Earnings").amount, 500);
  assert.equal(sheet.profitToDate, 4000, "this year only: last year's is in Retained Earnings");
  assert.equal(sheet.totalEquity, 10000 + 500 + 4000);

  const pos = await svc.Ifrs.financialPosition({ asAt: "2090-06-30", compare: "none" });
  assert.equal(pos.isBalanced, true);
  const equity = pos.equityAndLiabilities.equity;
  const names = equity.groups.flatMap((g) => g.accounts).map((a) => [a.accountName, a.amount]);
  assert.deepEqual(names.find(([n]) => n === "Retained Earnings"), ["Retained Earnings", 500]);
  assert.ok(equity.groups.some((g) => g.name === "Profit for the period" && g.amount === 4000));
  assert.ok(!equity.groups.some((g) => g.name === "Accumulated profit brought forward"), "nothing is left unclosed");

  // the statement of changes in equity agrees with it
  const changes = await svc.Ifrs.changesInEquity({ to: "2090-06-30", compare: "none" });
  assert.equal(changes.reconciles, true);
});

test("the dashboard's monthly profit does not see the closing entry as December's trading", { skip }, async () => {
  const months = ["2089-04", "2089-05", "2089-06", "2089-07", "2089-08", "2089-09", "2089-10", "2089-11", "2089-12"];
  const profit = await svc.Dash.monthlyProfit(months, "2089-12-31");
  assert.equal(profit.find((m) => m.month === "2089-12").netProfit, 0);
  assert.equal(r2(profit.reduce((t, m) => t + m.netProfit, 0)), 400);
});

test("the day book names the entry", { skip }, async () => {
  const book = await svc.Reports.dayBook({ from: "2089-12-31", to: "2089-12-31" });
  const row = book.rows.find((r) => r.voucherType === "closing");
  assert.ok(row, "the closing entry is there");
  assert.equal(row.typeLabel, "Year-end closing");
  assert.equal(row.balanced, true);
});

// ----------------------------------------------------------------------------------------------- branches

test("each branch is closed on its own books, and a person looking at one branch cannot close the organisation", { skip }, async () => {
  await svc.Branch.create({ code: "shj", name: "Sharjah", isActive: true });
  const sharjah = { companyId: "default", branchId: "shj", branchView: "shj" };
  await svc.tenant.runWithTenant(sharjah, () => journal("2090-04-01", "Cash in Hand", "Other Income", 200));
  await svc.tenant.runWithTenant(sharjah, () => journal("2090-05-01", "Rent Expense", "Cash in Hand", 250)); // Sharjah lost 50

  await svc.tenant.runWithTenant(sharjah, async () => {
    const pre = await svc.YearEnd.preview(years["2090"]._id, req);
    assert.ok(pre.blockers.some((b) => b.code === "ALL_BRANCHES_REQUIRED"));
    await refused(svc.YearEnd.close(years["2090"]._id, ACK, req), "YEAR_CLOSE_BLOCKED");
    await refused(svc.YearEnd.reopen(years["2089"]._id, req), "ALL_BRANCHES_REQUIRED");
  });

  const pre = await svc.YearEnd.preview(years["2090"]._id, req);
  assert.equal(pre.canClose, true);
  assert.deepEqual(pre.branches.map((b) => [b.branchId, b.profit]), [["main", 4000], ["shj", -50]]);
  assert.equal(pre.figures.profit, 3950);
});

// ----------------------------------------------------------------------------------------------- closing 2090 and reopening

test("closing 2090 creates 2091, posts a closing entry per branch, and each branch's books still balance", { skip }, async () => {
  const res = await svc.YearEnd.close(years["2090"]._id, ACK, req);
  assert.match(res.closing.voucherNo, /^YEC-2090-0001$/, "numbered in head office's series");
  assert.equal(res.closing.profit, 3950);
  assert.equal(res.closing.nextYearCreated, true);
  assert.equal(res.closing.nextYear, "2091");

  const next = await svc.FYModel.findOne({ code: "2091" }).lean();
  assert.equal(next.status, "open");
  assert.equal(svc.orgLocale.dayOf(next.startDate), "2091-01-01");
  assert.equal(svc.orgLocale.dayOf(next.endDate), "2091-12-31");
  await svc.FiscalYear.assertPostingAllowed(day("2091-03-01")); // posting carries on without a gap

  const entries = await live({ voucherType: "closing", voucherNo: res.closing.voucherNo });
  const bySharjah = entries.filter((e) => e.branchId === "shj");
  const byMain = entries.filter((e) => e.branchId === "main");
  assert.equal(bySharjah.length, 3, "Other Income, Rent and Retained Earnings");
  assert.equal(r2(bySharjah.reduce((t, e) => t + e.debitAmount - e.creditAmount, 0)), 0);
  assert.equal(r2(byMain.reduce((t, e) => t + e.debitAmount - e.creditAmount, 0)), 0);
  assert.deepEqual(bySharjah.filter((e) => e.accountName === "Retained Earnings").map((e) => [e.debitAmount, e.creditAmount]), [[50, 0]], "Sharjah's loss is debited to Retained Earnings");
  assert.deepEqual(byMain.filter((e) => e.accountName === "Retained Earnings").map((e) => [e.debitAmount, e.creditAmount]), [[0, 4000]]);
  assert.equal(await ledgerBalanced(), true, "every branch balances on its own");

  // Sharjah's own view of the new year: its income and expense start at zero and its loss is in equity
  await svc.tenant.runWithTenant({ companyId: "default", branchId: "shj", branchView: "shj" }, async () => {
    const open = await gl("2091-01-01", "2091-12-31");
    assert.equal(open("Other Income").opening, 0);
    assert.equal(open("Rent Expense").opening, 0);
    assert.equal(open("Retained Earnings").opening, 50, "a debit: the branch's loss");
  });
});

test("years are reopened newest first, and reopening takes the closing entry back out", { skip }, async () => {
  await refused(svc.YearEnd.reopen(years["2089"]._id, req), "YEAR_REOPEN_BLOCKED");
  assert.equal((await svc.YearEnd.preview(years["2089"]._id, req)).reopen.canReopen, false);

  const before2090 = await live({ voucherType: "closing", voucherNo: /^YEC-2090/ });
  assert.equal(before2090.length, 6);
  await svc.YearEnd.reopen(years["2090"]._id, req);
  assert.equal((await svc.FYModel.findById(years["2090"]._id).lean()).status, "open");
  assert.equal((await svc.FYModel.findById(years["2090"]._id).lean()).closing, undefined);
  assert.equal((await live({ voucherNo: /^YEC-2090/ })).length, 0, "the 2090 closing entry is out of the books ...");
  assert.equal(await svc.LedgerEntry.countDocuments({ voucherNo: /^YEC-2090/, isReversed: true }), 12, "... and it and its reversal stay on record");
  assert.equal(await stored("Retained Earnings"), 500);
  assert.equal(await stored("Other Income"), 5200, "2090's 5000 and Sharjah's 200 are back");
  assert.equal(await net("Retained Earnings"), -500);
  assert.equal(await ledgerBalanced(), true);
  await svc.FiscalYear.assertPostingAllowed(day("2090-06-01")); // open again
  await journal("2090-06-01", "Utilities", "Cash in Hand", 25); // a late correction

  // and now 2089, the latest closed
  await svc.YearEnd.reopen(years["2089"]._id, req);
  assert.equal(await net("Retained Earnings"), 0);
  assert.equal(await stored("Retained Earnings"), 0);
  assert.equal((await live({ voucherType: "closing" })).length, 0);
  assert.equal(await ledgerBalanced(), true);
  const pl = await svc.Reports.profitAndLoss({ from: "2089-01-01", to: "2089-12-31" });
  assert.equal(pl.netProfit, 400);
});

test("closed again, a year takes a new number and reverses only its live entries", { skip }, async () => {
  await journal("2089-08-01", "Utilities", "Cash in Hand", 50); // the correction: 2089 earned 350
  const again = await svc.YearEnd.close(years["2089"]._id, ACK, req);
  assert.match(again.closing.voucherNo, /^YEC-2089-0002$/, "a number is never reused");
  assert.notEqual(String(again.closing.voucherId), String(closing2089.voucherId));
  assert.equal(again.closing.profit, 450, "100 from 2088 and 350 from 2089");
  assert.equal(await net("Retained Earnings"), -450);
  assert.equal(await stored("Retained Earnings"), 450);

  // reopening reverses the live entries once, not the first closing's old ones a second time
  await svc.YearEnd.reopen(years["2089"]._id, req);
  assert.equal(await net("Retained Earnings"), 0);
  assert.equal(await stored("Retained Earnings"), 0);
  assert.equal(await stored("Other Income"), 5200 + 900, "all of it back in income");
  assert.equal(await ledgerBalanced(), true);
  await svc.YearEnd.close(years["2089"]._id, ACK, req);
  await svc.YearEnd.close(years["2090"]._id, ACK, req);
  assert.equal(await ledgerBalanced(), true);
});

// ----------------------------------------------------------------------------------------------- at the same time

test("two people closing the same year at once: one closes it, the other is told it is closed", { skip }, async () => {
  const fy = await svc.FYModel.findOne({ code: "2091" });
  const results = await Promise.allSettled([svc.YearEnd.close(fy._id, ACK, req), svc.YearEnd.close(fy._id, ACK, req)]);
  const won = results.filter((r) => r.status === "fulfilled");
  const lost = results.filter((r) => r.status === "rejected");
  assert.equal(won.length, 1, "exactly one succeeds");
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason.code, "ALREADY_CLOSED");
  assert.equal(await svc.FYModel.countDocuments({ code: "2092" }), 1, "the next year was made once");
  assert.equal((await svc.FYModel.findById(fy._id).lean()).status, "closed");
});
