// The Balance sheet behind Reports -> Statements, as a STATEMENT: classified current / non-current,
// grouped, ordered, with a comparative column (IAS 1.38, 1.60) and profit split into what earlier
// unclosed years earned and what this period did.
//
// The oracle is the IFRS statement of financial position, which was proved against live books on
// 24 Oct 2026. The two read one ledger, so every subtotal must agree; if they ever disagree, this
// screen is the one that is wrong.
//
//   node --require ./utils/testSetup.js --test services/__tests__/balanceSheetStatement.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const admin = new mongoose.Types.ObjectId();
const req = { admin: { _id: admin } };
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

let svc;
const A = {};
const END = (d) => `${d}T23:59:59.999`;

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Financial: require("../financial/financialService"),
    Config: require("../financial/accountConfigService"),
    Ifrs: require("../reports/ifrsReportsService"),
    FiscalYear: require("../core/fiscalYearService"),
    FYModel: require("../../models/modules/financial/fiscalYearModel"),
    AccountGroup: require("../../models/modules/financial/accountGroupModel"),
    ...require("../../models/modules/financial/financialModels"),
    orgLocale: require("../../utils/orgLocale"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);

  await svc.FYModel.deleteMany({});
  for (const code of ["2088", "2089"]) {
    await svc.FiscalYear.create({
      code, startDate: svc.orgLocale.dayStart(`${code}-01-01`), endDate: svc.orgLocale.endOfDay(`${code}-12-31`),
    }, req);
  }
  for (const n of ["Cash in Hand", "Bank Account", "Inventory Stock", "Vehicles", "Furniture & Equipment",
    "Bank Loan", "Owner's Capital", "Retained Earnings", "Other Income", "Rent Expense"]) {
    A[n] = await svc.LedgerAccount.findOne({ accountName: n });
    assert.ok(A[n], `the default chart should have ${n}`);
  }
  // The default chart has no drawings account; a real partnership always does.
  const capital = A["Owner's Capital"];
  A["Owner's Drawings"] = await svc.LedgerAccount.create({
    accountName: "Owner's Drawings", accountCode: "EQ9001", accountType: capital.accountType,
    subType: capital.subType, groupId: capital.groupId, isActive: true, createdBy: admin,
  });

  // ---- the books every test below reads
  // 2088: capital in, a vehicle bought, a loan taken, trading that earns something, drawings taken.
  await journal("2088-01-05", "Cash in Hand", "Owner's Capital", 100000, "capital introduced");
  await journal("2088-02-01", "Vehicles", "Cash in Hand", 40000, "van bought");
  await journal("2088-03-01", "Cash in Hand", "Bank Loan", 25000, "loan drawn");
  await journal("2088-04-01", "Cash in Hand", "Other Income", 18000, "fees earned");
  await journal("2088-05-01", "Rent Expense", "Cash in Hand", 6000, "rent");
  await journal("2088-06-01", "Owner's Drawings", "Cash in Hand", 9000, "owner took money out");
  await journal("2088-07-01", "Inventory Stock", "Cash in Hand", 12000, "stock bought");
  // 2089: the van is sold, so Vehicles has a balance in 2088 and none in 2089.
  await journal("2089-02-01", "Cash in Hand", "Vehicles", 40000, "van sold at book value");
  await journal("2089-03-01", "Cash in Hand", "Other Income", 5000, "more fees");
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const day = (d) => new Date(`${d}T00:00:00.000Z`);
const journal = (d, debit, credit, amount, narration = "test") =>
  svc.Financial.createVoucher({
    voucherType: "journal", date: day(d), narration,
    lines: [{ accountId: A[debit]._id, debit: amount }, { accountId: A[credit]._id, credit: amount }],
  }, admin);

const bs = (asOf, compareAsOf) =>
  svc.Financial.getBalanceSheet(END(asOf), compareAsOf ? { compareAsOf: END(compareAsOf) } : {});

// the group of a given name inside a section, or undefined
const groupNamed = (section, name) => section.groups.find((g) => g.name === name);
const accountIn = (section, accountName) =>
  section.groups.flatMap((g) => g.accounts).find((a) => a.accountName === accountName);


// ================================================================== classification
test("an account under Fixed Assets is non-current; cash, stock and the rest are current", { skip }, async () => {
  const d = await bs("2088-12-31");
  const { assets } = d.sections;

  assert.equal(accountIn(assets.nonCurrent, "Vehicles").amount, 40000, "a van is not a current asset");
  assert.equal(accountIn(assets.current, "Vehicles"), undefined, "and it is not in both");
  assert.equal(accountIn(assets.current, "Cash in Hand").amount, r2(100000 - 40000 + 25000 + 18000 - 6000 - 9000 - 12000));
  assert.equal(accountIn(assets.current, "Inventory Stock").amount, 12000);
  assert.equal(assets.nonCurrent.amount, 40000);
  assert.equal(r2(assets.nonCurrent.amount + assets.current.amount), assets.amount, "the two add to total assets");
});

test("a loan under Long-term Liabilities is non-current", { skip }, async () => {
  const { liabilities } = (await bs("2088-12-31")).sections;
  assert.equal(accountIn(liabilities.nonCurrent, "Bank Loan").amount, 25000);
  assert.equal(liabilities.current.amount, 0, "nothing else is owed");
  assert.equal(liabilities.amount, 25000);
});

test("cash reads last and stock first, the order IAS 1 is read in", { skip }, async () => {
  const { current } = (await bs("2088-12-31")).sections.assets;
  const names = current.groups.map((g) => g.name);
  assert.ok(names.indexOf("Inventory") < names.indexOf("Cash"), `stock before cash, got ${names.join(" / ")}`);
});

// ================================================================== equity
test("drawings are a deduction under capital, not a negative among the positives", { skip }, async () => {
  const { equity } = (await bs("2088-12-31")).sections;
  const less = groupNamed(equity, "Less: Drawings");
  assert.ok(less, "money the owners took out is named as what it is");
  assert.equal(less.amount, -9000, "it reduces equity");
  assert.equal(accountIn(equity, "Owner's Drawings").amount, -9000);
  // and it is NOT mixed in with the capital introduced
  const capitalGroup = equity.groups.find((g) => g.accounts.some((a) => a.accountName === "Owner's Capital"));
  assert.ok(!capitalGroup.accounts.some((a) => a.accountName === "Owner's Drawings"));
});

test("profit nobody closed is brought forward, apart from this period's own trading", { skip }, async () => {
  // 2088 earned 18,000 - 6,000 = 12,000 and was never closed. 2089 earns 5,000 of its own.
  const d = await bs("2089-12-31");
  assert.equal(d.profitBroughtForward, 12000, "what the unclosed year earned");
  assert.equal(d.profitForPeriod, 5000, "what this year earned");
  assert.equal(d.profitToDate, 17000, "and the old single figure is still their sum");

  const { equity } = d.sections;
  assert.equal(groupNamed(equity, "Accumulated profit brought forward").amount, 12000);
  assert.equal(groupNamed(equity, "Profit for the period").amount, 5000);

  const first = await bs("2088-12-31");
  assert.equal(first.profitBroughtForward, 0, "the first year has nothing before it");
  assert.equal(groupNamed(first.sections.equity, "Accumulated profit brought forward"), undefined,
    "a nil brought-forward line is not drawn at all");
});

// ================================================================== the comparative column
test("a comparative column reads exactly what a run at that date reads", { skip }, async () => {
  const withCmp = await bs("2089-12-31", "2088-12-31");
  const direct = await bs("2088-12-31");
  const S = withCmp.sections;

  assert.equal(S.assets.comparative, direct.sections.assets.amount);
  assert.equal(S.assets.nonCurrent.comparative, direct.sections.assets.nonCurrent.amount);
  assert.equal(S.assets.current.comparative, direct.sections.assets.current.amount);
  assert.equal(S.equity.comparative, direct.sections.equity.amount);
  assert.equal(S.liabilities.comparative, direct.sections.liabilities.amount);
  assert.equal(withCmp.comparative.totalAssets, direct.totalAssets);
});

test("an account with a balance then and none now is carried at nil, so the comparative still balances", { skip }, async () => {
  // The van was sold in 2089: Vehicles holds 40,000 at the end of 2088 and nothing at the end of 2089.
  // Walking only today's lines dropped it from the statement, and the comparative column stopped adding up.
  const d = await bs("2089-12-31", "2088-12-31");
  const S = d.sections;

  const van = accountIn(S.assets.nonCurrent, "Vehicles");
  assert.ok(van, "the line is still drawn, because the comparative column needs it");
  assert.equal(van.amount, 0, "nil now");
  assert.equal(van.comparative, 40000, "and what it was");

  assert.equal(S.assets.comparative, S.equityAndLiabilities.comparative,
    "the comparative column balances, which is the whole point of carrying it through");
  assert.equal(S.assets.amount, S.equityAndLiabilities.amount, "and so does this one");
});

test("without a comparative every line says null, never a misleading zero", { skip }, async () => {
  const d = await bs("2089-12-31");
  assert.equal(d.comparative, null);
  assert.equal(d.sections.assets.comparative, null);
  assert.equal(accountIn(d.sections.assets.current, "Cash in Hand").comparative, null);
});

// ================================================================== IAS 1.32, no offsetting
test("a bank account in credit is a current liability, not a negative asset", { skip }, async () => {
  await journal("2089-06-01", "Cash in Hand", "Bank Account", 3000, "overdrawn");
  const S = (await bs("2089-06-30")).sections;

  assert.equal(accountIn(S.assets.current, "Bank Account"), undefined, "not left as a negative asset");
  const overdraft = groupNamed(S.liabilities.current, "Bank overdrafts");
  assert.ok(overdraft, "it is shown as what it is");
  assert.equal(overdraft.amount, 3000, "and as a positive on its own side");
  assert.equal(S.assets.amount, S.equityAndLiabilities.amount, "both sides rose by the same amount");

  await journal("2089-06-02", "Bank Account", "Cash in Hand", 3000, "put back");
});

// ================================================================== nothing that worked stopped working
test("the flat arrays and every total this has always answered are unchanged", { skip }, async () => {
  const d = await bs("2089-12-31");
  for (const key of ["assets", "liabilities", "equity"]) {
    assert.ok(Array.isArray(d[key]), `${key} is still a flat array`);
    for (const row of d[key]) {
      assert.ok(row._id && row.accountName && "amount" in row && "groupName" in row,
        "a row still carries the fields the old screen read");
    }
  }
  assert.equal(r2(d.totalLiabilities + d.totalEquity), d.totalLiabilitiesAndEquity);
  assert.equal(d.isBalanced, true);
  assert.equal(d.totalAssets, d.totalLiabilitiesAndEquity);
  // the flat arrays and the sections are the same figures
  assert.equal(r2(d.assets.reduce((t, a) => t + a.amount, 0)), d.sections.assets.amount);
});

// ================================================================== the oracle
test("every section agrees with the IFRS statement of financial position", { skip }, async () => {
  for (const asAt of ["2088-12-31", "2089-06-30", "2089-12-31"]) {
    const mine = (await bs(asAt)).sections;
    const theirs = await svc.Ifrs.financialPosition({ asAt, compare: "none" });
    const same = (a, b, what) => assert.ok(Math.abs((a || 0) - (b || 0)) < 0.01, `${what} at ${asAt}: ${a} vs ${b}`);

    same(mine.assets.amount, theirs.assets.amount, "total assets");
    same(mine.assets.nonCurrent.amount, theirs.assets.nonCurrent.amount, "non-current assets");
    same(mine.assets.current.amount, theirs.assets.current.amount, "current assets");
    same(mine.equity.amount, theirs.equityAndLiabilities.equity.amount, "equity");
    same(mine.liabilities.nonCurrent.amount, theirs.equityAndLiabilities.nonCurrentLiabilities.amount, "non-current liabilities");
    same(mine.liabilities.current.amount, theirs.equityAndLiabilities.currentLiabilities.amount, "current liabilities");
    same(mine.equityAndLiabilities.amount, theirs.equityAndLiabilities.amount, "equity and liabilities");
  }
});
