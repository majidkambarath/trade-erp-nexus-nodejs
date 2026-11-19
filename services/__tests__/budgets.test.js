// Budgets against real postings: create, refusals, budget vs actual (whole business and one cost centre), last year's actuals as a start.
//   node --require ./utils/testSetup.js --test services/__tests__/budgets.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_bud_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
let svc, admin, years = {}, SHOP, acc = {};
const req = () => ({ admin: { id: String(admin) } });
const day = (d) => new Date(`${d}T08:00:00.000Z`);
const journal = (d, dr, cr, amount, extra = {}) =>
  svc.Financial.createVoucher({ voucherType: "journal", date: day(d), narration: "t", lines: [{ accountId: dr._id, debit: amount }, { accountId: cr._id, credit: amount }], ...extra }, admin);

test.before(async () => {
  if (skip) return;
  process.env.LOG_SILENT = "1";
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Financial: require("../financial/financialService"),
    Budgets: require("../financial/budgetService"),
    CC: require("../financial/costCentreService"),
    FiscalYear: require("../core/fiscalYearService"),
    orgLocale: require("../../utils/orgLocale"),
    ...require("../../models/modules/financial/financialModels"),
  };
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  admin = new mongoose.Types.ObjectId();
  // the seed may already have made this year's: use it, make what is missing
  const FY = require("../../models/modules/financial/fiscalYearModel");
  for (const code of ["2025", "2026"]) {
    years[code] = (await FY.findOne({ startDate: { $lte: svc.orgLocale.dayStart(`${code}-06-30`) }, endDate: { $gte: svc.orgLocale.dayStart(`${code}-06-30`) } }).lean())
      || (await svc.FiscalYear.create({ code, startDate: svc.orgLocale.dayStart(`${code}-01-01`), endDate: svc.orgLocale.endOfDay(`${code}-12-31`) }, req()));
  }
  const find = (name) => svc.LedgerAccount.findOne({ accountName: name }).lean();
  acc = { sales: await find("Sales Revenue"), rent: await find("Rent Expense"), cash: await find("Cash in Hand"), capital: await find("Owner's Capital") };
  SHOP = await svc.CC.create({ code: "SHOP1", name: "Deira shop" }, req());
  // 2025: rent 300 in January; 2026: sales 1,000 in January (600 of it in the shop) and 1,500 in February, rent 400 in January (shop)
  await journal("2025-01-10", acc.cash, acc.capital, 5000);
  await journal("2025-01-15", acc.rent, acc.cash, 300);
  await journal("2026-01-05", acc.cash, acc.sales, 400);
  await journal("2026-01-06", acc.cash, acc.sales, 600, { costCentreId: String(SHOP._id) });
  await journal("2026-02-03", acc.cash, acc.sales, 1500);
  await journal("2026-01-20", acc.rent, acc.cash, 400, { costCentreId: String(SHOP._id) });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

let whole;
test("a budget is made for a year, once per cost centre, of income and expense accounts only", { skip }, async () => {
  whole = await svc.Budgets.create({
    fiscalYearId: String(years["2026"]._id),
    lines: [
      { accountId: String(acc.sales._id), amounts: { "2026-01": 1200, "2026-02": 1200, "2026-03": 1200 } },
      { accountId: String(acc.rent._id), amounts: { "2026-01": 350, "2026-02": 350 } },
    ],
  }, req());
  assert.equal(whole.name, "Budget 2026");
  assert.deepEqual(whole.totals, { income: 3600, expense: 700 });
  await assert.rejects(() => svc.Budgets.create({ fiscalYearId: String(years["2026"]._id), lines: [] }, req()), { code: "BUDGET_EXISTS" });
  await assert.rejects(() => svc.Budgets.create({ fiscalYearId: String(years["2026"]._id), costCentreId: String(SHOP._id), lines: [{ accountId: String(acc.cash._id), amounts: {} }] }, req()), { code: "INVALID_BUDGET" });
  await assert.rejects(() => svc.Budgets.create({ fiscalYearId: String(years["2026"]._id), costCentreId: String(SHOP._id), lines: [{ accountId: String(acc.rent._id), amounts: { "2025-12": 1 } }] }, req()), { code: "INVALID_BUDGET" });
});

test("budget vs actual for the whole business reads every posting of the months asked, and nothing brought forward", { skip }, async () => {
  const r = await svc.Budgets.report(whole._id, { from: "2026-01", to: "2026-02" });
  const sales = r.rows.find((x) => x.accountName === "Sales Revenue");
  const rent = r.rows.find((x) => x.accountName === "Rent Expense");
  assert.deepEqual([sales.budget, sales.actual, sales.variance, sales.favourable], [2400, 2500, 100, true]);
  assert.deepEqual([rent.budget, rent.actual, rent.variance, rent.favourable], [700, 400, -300, true]);
  assert.deepEqual(r.totals.net, { budget: 1700, actual: 2100, variance: 400 });
  assert.deepEqual(r.months, ["2026-01", "2026-02"]);
  const jan = await svc.Budgets.report(whole._id, { from: "2026-01", to: "2026-01" });
  assert.equal(jan.rows.find((x) => x.accountName === "Sales Revenue").actual, 1000);
  await assert.rejects(() => svc.Budgets.report(whole._id, { from: "2026-03", to: "2026-01" }), { code: "INVALID_RANGE" });
});

test("a cost centre's budget sees only what was posted to that centre", { skip }, async () => {
  const shop = await svc.Budgets.create({ fiscalYearId: String(years["2026"]._id), costCentreId: String(SHOP._id), lines: [{ accountId: String(acc.sales._id), amounts: { "2026-01": 500 } }] }, req());
  assert.equal(shop.name, "Budget 2026 - Deira shop");
  const r = await svc.Budgets.report(shop._id, { from: "2026-01", to: "2026-02" });
  assert.equal(r.rows.find((x) => x.accountName === "Sales Revenue").actual, 600);
  assert.equal(r.rows.find((x) => x.accountName === "Rent Expense").actual, 400, "spent without a budget line, still shown");
});

test("last year's actuals are offered as a start, moved onto this year's months", { skip }, async () => {
  const s = await svc.Budgets.suggest({ fiscalYearId: String(years["2026"]._id) });
  assert.equal(s.from, "2025");
  const rent = s.lines.find((l) => l.accountName === "Rent Expense");
  assert.deepEqual(rent.amounts, { "2026-01": 300 });
  assert.equal(s.lines.some((l) => l.accountName === "Owner's Capital"), false, "balance sheet accounts are not budgeted");
  assert.deepEqual((await svc.Budgets.suggest({ fiscalYearId: String(years["2025"]._id) })).lines, []);
});

test("a budget is changed whole and deleted", { skip }, async () => {
  const saved = await svc.Budgets.update(whole._id, { name: "Plan 2026", lines: [{ accountId: String(acc.rent._id), amounts: { "2026-05": 99.5 } }] }, req());
  assert.equal(saved.name, "Plan 2026");
  assert.deepEqual(saved.totals, { income: 0, expense: 99.5 });
  assert.equal((await svc.Budgets.list()).length, 2);
  await svc.Budgets.remove(whole._id);
  await assert.rejects(() => svc.Budgets.get(whole._id), { code: "BUDGET_NOT_FOUND" });
});
