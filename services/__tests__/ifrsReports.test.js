// IFRS statements (financial position, profit or loss, changes in equity, cash flows, notes) read
// from the ledger, with comparatives. Throwaway database; see accountingFoundation.test.js.
//
//   node --test services/__tests__/ifrsReports.test.js
//
// The story is told on fixed days so the numbers can be checked by hand:
//   June 2024   (prior year)    capital 3,000; buy 50 bags at 10; sell 10 at 20 on credit
//   May 2025    (prior period)  buy 50 at 10; sell 10 at 20 on credit
//   June 2025   (the period)    capital 5,000; furniture 1,200 (journal); 2,000 long-term loan
//                               (journal); buy 100 at 10; sell 40 at 20 on credit; receipt 100;
//                               payment 300; rent 200 + VAT; bank charges 15; depreciation 20;
//                               corporate tax 10 accrued, 4 paid
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const Ifrs = require("../reports/ifrsReportsService");
const H = Ifrs.helpers;

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const admin = new mongoose.Types.ObjectId();
const at = (ymd) => new Date(`${ymd}T12:00:00+04:00`); // midday in Dubai

let svc;
let accounts = {};

const flatAccounts = (groups) => groups.flatMap((g) => g.accounts);
const amountOf = (groups, name) => flatAccounts(groups).find((a) => a.accountName === name)?.amount;
const lineOf = (lines, key) => lines.find((l) => l.key === key);

// ---------------------------------------------------------------- pure rules (no database)

test("dates: a day is validated, the comparative period is the same days a year back or the period before", () => {
  assert.equal(H.toDay("2025-06-30"), "2025-06-30");
  assert.equal(H.toDay("2025-06-30T23:59:59.999"), "2025-06-30");
  assert.equal(H.toDay(""), null);
  assert.equal(H.toDay(undefined), null);
  assert.throws(() => H.toDay("2025-02-30"), { code: "INVALID_DATE" });
  assert.throws(() => H.toDay("June"), { code: "INVALID_DATE" });

  assert.deepEqual(H.comparativeRange("2025-06-01", "2025-06-30", "prior-year"), { from: "2024-06-01", to: "2024-06-30" });
  assert.deepEqual(H.comparativeRange("2024-03-01", "2024-02-29", "prior-year").to, "2023-02-28", "29 Feb is the last day of its month");
  assert.deepEqual(H.comparativeRange("2025-01-01", "2025-02-28", "prior-year"), { from: "2024-01-01", to: "2024-02-29" }, "the last day of Feb stays the last day");
  assert.deepEqual(H.comparativeRange("2025-06-10", "2025-06-19", "prior-year"), { from: "2024-06-10", to: "2024-06-19" });

  assert.deepEqual(H.comparativeRange("2025-10-01", "2025-10-31", "prior-period"), { from: "2025-09-01", to: "2025-09-30" }, "a month is followed by the month before");
  assert.deepEqual(H.comparativeRange("2025-01-01", "2025-03-31", "prior-period"), { from: "2024-10-01", to: "2024-12-31" }, "a quarter by the quarter before");
  assert.deepEqual(H.comparativeRange("2025-01-01", "2025-12-31", "prior-period"), { from: "2024-01-01", to: "2024-12-31" });
  assert.deepEqual(H.comparativeRange("2025-06-10", "2025-06-19", "prior-period"), { from: "2025-05-31", to: "2025-06-09" }, "ten days by the ten days before");
  assert.equal(H.comparativeRange("2025-06-01", "2025-06-30", "none"), null);

  assert.equal(H.fiscalYearStart("2025-06-30", 1), "2025-01-01");
  assert.equal(H.fiscalYearStart("2025-02-10", 4), "2024-04-01");
  assert.equal(H.fiscalYearStart("2025-04-01", 4), "2025-04-01");

  assert.equal(H.compareMode(undefined), "prior-year");
  assert.equal(H.compareMode("None"), "none");
  assert.throws(() => H.compareMode("last-week"), { code: "INVALID_COMPARE" });
});

test("classification: non-current by group name, expense kinds by name, cash flow buckets", () => {
  for (const name of ["Fixed Assets", "Non-current Liabilities", "Long-term Liabilities", "Property, Plant & Equipment", "Intangible assets", "Noncurrent assets"]) {
    assert.ok(H.NON_CURRENT_RX.test(name), name);
  }
  for (const name of ["Current Assets", "Cash", "Bank", "Accounts Receivable", "Inventory", "Tax Payable", "Credit Cards", "Equity"]) {
    assert.ok(!H.NON_CURRENT_RX.test(name), name);
  }
  assert.ok(H.FINANCE_RX.test("Bank Charges") && H.FINANCE_RX.test("Interest on loan") && H.FINANCE_RX.test("Finance costs"));
  assert.ok(H.DEPRECIATION_RX.test("Depreciation - vehicles") && H.DEPRECIATION_RX.test("Amortisation of software"));
  assert.ok(H.TAX_RX.test("Corporate Tax Expense") && H.TAX_RX.test("Income tax") && !H.TAX_RX.test("Output VAT"));

  const row = (over) => ({ accountName: "x", path: [], category: "ASSET", nonCurrent: false, isCash: false, groupId: "g", ...over });
  assert.equal(H.cashFlowBucket(row({ isCash: true })), "cash");
  assert.equal(H.cashFlowBucket(row({ category: "INCOME" })), "pnl");
  assert.equal(H.cashFlowBucket(row({ nonCurrent: true, path: ["Fixed Assets"] })), "nonCurrentAssets");
  assert.equal(H.cashFlowBucket(row({ path: ["Current Assets", "Inventory"] })), "inventory");
  assert.equal(H.cashFlowBucket(row({ path: ["Current Assets", "Accounts Receivable"] })), "receivables");
  assert.equal(H.cashFlowBucket(row({ path: ["Current Assets", "Post-dated Cheques Received"] })), "otherCurrentAssets");
  assert.equal(H.cashFlowBucket(row({ category: "LIABILITY", path: ["Current Liabilities", "Accounts Payable"] })), "payables");
  assert.equal(H.cashFlowBucket(row({ category: "LIABILITY", accountName: "Corporate Tax Payable", path: ["Tax Payable"] })), "taxPayable");
  assert.equal(H.cashFlowBucket(row({ category: "LIABILITY", nonCurrent: true, path: ["Long-term Liabilities"] })), "borrowings");
  assert.equal(H.cashFlowBucket(row({ category: "LIABILITY", accountName: "Short-term loan", path: ["Current Liabilities"] })), "borrowings");
  assert.equal(H.cashFlowBucket(row({ category: "LIABILITY", path: ["Current Liabilities", "Credit Cards"] })), "otherCurrentLiabilities");
  assert.equal(H.cashFlowBucket(row({ category: "EQUITY" })), "equity");
  assert.equal(H.cashFlowBucket(row({ groupId: "cashgroup" }), { cashGroupIds: new Set(["cashgroup"]) }), "unclassified", "a cash account that is switched off");

  assert.equal(H.equityColumn({ accountName: "Owner's Capital", path: ["Equity"] }), "share_capital");
  assert.equal(H.equityColumn({ accountName: "Retained Earnings", path: ["Equity"] }), "retained_earnings");
  assert.equal(H.equityColumn({ accountName: "Opening Balance Equity", path: ["Equity"] }), "other_equity");
});

test("the router exposes the five statements behind authentication", () => {
  const router = require("../../routes/reports/ifrsRoutes");
  const paths = router.stack.filter((l) => l.route).map((l) => [Object.keys(l.route.methods)[0], l.route.path]);
  assert.deepEqual(paths, [["get", "/financial-position"], ["get", "/profit-or-loss"], ["get", "/changes-in-equity"], ["get", "/cash-flows"], ["get", "/notes"]]);
  assert.equal(router.stack[0].route, undefined, "authenticateToken is the first layer");
});

// ---------------------------------------------------------------- against the ledger

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Financial: require("../financial/financialService"),
    Tx: require("../orderPurchase/transactionService"),
    Chart: require("../financial/chartOfAccountsService"),
    Config: require("../financial/accountConfigService"),
    Reports: require("../reports/ledgerReportsService"),
    ...require("../../models/modules/financial/financialModels"),
    AccountGroup: require("../../models/modules/financial/accountGroupModel"),
    FiscalYear: require("../../models/modules/financial/fiscalYearModel"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  // no fiscal year defined: posting is allowed on any day, so the story can sit on fixed dates
  await svc.FiscalYear.deleteMany({});
  await svc.Config.updateSettings({ profile: { legalName: "Harbour Trading Co LLC", trn: "100123456789012" } });

  const customer = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", creditLimit: 0 });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mills", contactPerson: "x", address: "y" });
  const stock = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: new mongoose.Types.ObjectId() });

  const acct = (name) => svc.LedgerAccount.findOne({ accountName: name });
  const group = (name) => svc.AccountGroup.findOne({ name });
  const make = (accountName, groupName) => group(groupName).then((g) => svc.Chart.createAccount({ accountName, groupId: g._id }, {}, admin));
  const [cash, capital, furniture, loan, rent, bankCharges, std] = await Promise.all([
    acct("Cash in Hand"), acct("Owner's Capital"), acct("Furniture & Equipment"), acct("Bank Loan"), acct("Rent Expense"), acct("Bank Charges"),
    svc.TaxCode.findOne({ kind: "standard" }),
  ]);
  const enbd = await make("ENBD Current", "Bank");
  const depreciation = await make("Depreciation Expense", "Operating Expenses");
  const accumulated = await make("Accumulated Depreciation", "Fixed Assets");
  const taxExpense = await make("Corporate Tax Expense", "Operating Expenses");
  const taxPayable = await make("Corporate Tax Payable", "Tax Payable");
  accounts = { cash, capital, furniture, loan, rent, bankCharges, enbd, depreciation, accumulated, taxExpense, taxPayable, std };

  const line = (qty, price) => ({ itemId: stock._id, description: "Rice", qty, price, rate: price, vatPercent: 5 });
  const post = async (type, party, partyType, qty, price, day) => {
    const t = await svc.Tx.createTransaction({ type, partyId: party._id, partyType, partyTypeRef: partyType, date: at(day), items: [line(qty, price)] }, "tester");
    await svc.Tx.processTransaction(t._id, "approve", "tester");
    return svc.Transaction.findById(t._id).lean();
  };
  const journal = (day, narration, dr, cr, amount) =>
    svc.Financial.createVoucher({ voucherType: "journal", date: at(day), narration, lines: [{ accountId: dr._id, debit: amount }, { accountId: cr._id, credit: amount }] }, admin);

  // June 2024
  await journal("2024-06-05", "Capital", cash, capital, 3000);
  await post("purchase_order", vendor, "Vendor", 50, 10, "2024-06-10"); // 500 + 25 VAT
  await post("sales_order", customer, "Customer", 10, 20, "2024-06-20"); // 200 + 10 VAT, cost 100
  // May 2025
  await post("purchase_order", vendor, "Vendor", 50, 10, "2025-05-10");
  await post("sales_order", customer, "Customer", 10, 20, "2025-05-20");
  // June 2025
  await journal("2025-06-01", "Capital introduced", cash, capital, 5000);
  await journal("2025-06-02", "Furniture bought", furniture, cash, 1200);
  await journal("2025-06-03", "Long-term bank loan", enbd, loan, 2000);
  const purchase = await post("purchase_order", vendor, "Vendor", 100, 10, "2025-06-05"); // 1,000 + 50 VAT
  const sale = await post("sales_order", customer, "Customer", 40, 20, "2025-06-10"); // 800 + 40 VAT = 840, cost 400
  await svc.Financial.createVoucher({
    voucherType: "receipt", customerId: customer._id, totalAmount: 100, date: at("2025-06-15"), paymentMode: "cash",
    linkedInvoices: [{ invoiceId: sale._id, amount: 100, balance: sale.outstandingAmount - 100 }],
  }, admin);
  await svc.Financial.createVoucher({
    voucherType: "payment", vendorId: vendor._id, totalAmount: 300, date: at("2025-06-16"), paymentMode: "cash",
    linkedInvoices: [{ invoiceId: purchase._id, amount: 300, balance: purchase.outstandingAmount - 300 }],
  }, admin);
  await svc.Financial.createVoucher({ voucherType: "expense", ledgerBased: true, expenseAccountId: rent._id, amount: 200, taxCodeId: std._id, description: "Office rent", paymentMode: "cash", date: at("2025-06-18") }, admin);
  await journal("2025-06-20", "Bank charges", bankCharges, enbd, 15);
  await journal("2025-06-30", "Depreciation for June", depreciation, accumulated, 20);
  await journal("2025-06-30", "Corporate tax for June", taxExpense, taxPayable, 10);
  await journal("2025-06-30", "Corporate tax paid", taxPayable, cash, 4);
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("financial position: current and non-current assets, equity with profit, liabilities, and it balances", { skip }, async () => {
  const p = await Ifrs.financialPosition({ asAt: "2025-06-30", from: "2025-06-01" });
  assert.equal(p.title, "Statement of financial position");
  assert.equal(p.currency, "AED");
  assert.equal(p.entity.name, "Harbour Trading Co LLC");
  assert.equal(p.entity.trn, "100123456789012");
  assert.equal(p.compare, "prior-year");
  assert.deepEqual(p.comparative, { asAt: "2024-06-30", from: "2024-06-01" });

  // non-current: the furniture less its accumulated depreciation (a contra account in the same group)
  const nca = p.assets.nonCurrent;
  assert.equal(amountOf(nca.groups, "Furniture & Equipment"), 1200);
  assert.equal(amountOf(nca.groups, "Accumulated Depreciation"), -20);
  assert.equal(nca.amount, 1180);
  assert.equal(nca.comparative, 0);

  // current: stock, receivables, then cash last
  const ca = p.assets.current;
  assert.deepEqual(ca.groups.map((g) => g.name).slice(0, 1), ["Inventory"]);
  assert.equal(ca.groups.at(-1).name === "Cash" || ca.groups.at(-1).name === "Bank", true, "cash and bank come last");
  assert.equal(amountOf(ca.groups, "Inventory Stock"), 1400);
  assert.equal(amountOf(ca.groups, "Customer - Al Noor"), 1160); // 210 + 210 + 840 - 100
  assert.equal(amountOf(ca.groups, "Input VAT"), 110);
  assert.equal(amountOf(ca.groups, "Cash in Hand"), 6386);
  assert.equal(amountOf(ca.groups, "ENBD Current"), 1985);
  assert.equal(ca.amount, 11041);
  assert.equal(p.assets.amount, 12221);

  const eq = p.equityAndLiabilities;
  assert.equal(amountOf(eq.equity.groups, "Owner's Capital"), 8000);
  assert.equal(amountOf(eq.equity.groups, "Accumulated profit brought forward"), 200, "June 2024 and May 2025");
  assert.equal(amountOf(eq.equity.groups, "Profit for the period"), 155);
  assert.equal(eq.equity.amount, 8355);
  assert.equal(amountOf(eq.nonCurrentLiabilities.groups, "Bank Loan"), 2000);
  assert.equal(eq.nonCurrentLiabilities.amount, 2000);
  assert.equal(amountOf(eq.currentLiabilities.groups, "Vendor - Gulf Mills"), 1800);
  assert.equal(amountOf(eq.currentLiabilities.groups, "Output VAT"), 60);
  assert.equal(amountOf(eq.currentLiabilities.groups, "Corporate Tax Payable"), 6);
  assert.equal(eq.currentLiabilities.amount, 1866);
  assert.equal(eq.liabilities.amount, 3866);
  assert.equal(eq.amount, 12221);
  assert.equal(p.isBalanced, true);
  assert.equal(p.difference, 0);

  // every account sits on exactly one side
  const all = [...flatAccounts(nca.groups), ...flatAccounts(ca.groups), ...flatAccounts(eq.equity.groups), ...flatAccounts(eq.nonCurrentLiabilities.groups), ...flatAccounts(eq.currentLiabilities.groups)]
    .filter((a) => a.accountId);
  assert.equal(new Set(all.map((a) => a.accountId)).size, all.length);

  // comparative: a year earlier
  assert.equal(amountOf(ca.groups, "Inventory Stock") !== undefined, true);
  assert.equal(flatAccounts(ca.groups).find((a) => a.accountName === "Inventory Stock").comparative, 400);
  assert.equal(flatAccounts(ca.groups).find((a) => a.accountName === "Cash in Hand").comparative, 3000);
  assert.equal(ca.comparative, 3635);
  assert.equal(p.assets.comparative, 3635);
  assert.equal(eq.equity.comparative, 3100); // capital 3,000 + profit 100
  assert.equal(eq.liabilities.comparative, 535);
  assert.equal(eq.comparative, 3635);
  assert.equal(p.comparativeIsBalanced, true);
});

test("financial position: prior period and no comparative; the period defaults to the fiscal year", { skip }, async () => {
  const prior = await Ifrs.financialPosition({ asAt: "2025-06-30", from: "2025-06-01", compare: "prior-period" });
  assert.deepEqual(prior.comparative, { asAt: "2025-05-31", from: "2025-05-01" });
  assert.equal(prior.assets.comparative, 4270);
  assert.equal(prior.equityAndLiabilities.equity.comparative, 3200); // capital 3,000 + profit 100 to May 2025 + 100 in May
  assert.equal(prior.equityAndLiabilities.comparative, 4270);
  assert.equal(prior.comparativeIsBalanced, true);

  const none = await Ifrs.financialPosition({ asAt: "2025-06-30", from: "2025-06-01", compare: "none" });
  assert.equal(none.comparative, null);
  assert.equal(none.assets.comparative, null);
  assert.equal(none.comparativeIsBalanced, null);
  assert.equal(flatAccounts(none.assets.current.groups).every((a) => a.comparative === null), true);
  assert.equal(none.assets.amount, 12221);

  // with no `from`, profit is split at the start of the fiscal year (1 January): nothing earlier than that is brought forward
  const year = await Ifrs.financialPosition({ asAt: "2025-06-30", compare: "none" });
  assert.equal(year.from, "2025-01-01");
  assert.equal(amountOf(year.equityAndLiabilities.equity.groups, "Accumulated profit brought forward"), 100, "June 2024 only");
  assert.equal(amountOf(year.equityAndLiabilities.equity.groups, "Profit for the period"), 255, "May and June 2025");
  assert.equal(year.equityAndLiabilities.equity.amount, 8355);

  // before anything happened
  const empty = await Ifrs.financialPosition({ asAt: "2020-01-31", compare: "none" });
  assert.equal(empty.assets.amount, 0);
  assert.equal(empty.isBalanced, true);
});

test("profit or loss by function: revenue, cost of sales, gross profit, expenses split out, tax, comparatives", { skip }, async () => {
  const pl = await Ifrs.profitOrLoss({ from: "2025-06-01", to: "2025-06-30" });
  assert.equal(pl.title, "Statement of profit or loss and other comprehensive income");
  assert.deepEqual(pl.comparative, { from: "2024-06-01", to: "2024-06-30" });
  assert.equal(pl.revenue.amount, 800);
  assert.equal(pl.revenue.comparative, 200);
  assert.equal(pl.costOfSales.amount, 400);
  assert.equal(pl.costOfSales.comparative, 100);
  assert.deepEqual([pl.grossProfit.amount, pl.grossProfit.comparative], [400, 100]);
  assert.equal(pl.otherIncome.amount, 0);
  assert.equal(pl.operatingExpenses.amount, 200);
  assert.deepEqual(pl.operatingExpenses.accounts.map((a) => a.accountName), ["Rent Expense"]);
  assert.equal(pl.operatingExpenses.comparative, 0);
  assert.deepEqual(pl.depreciationAndAmortisation.accounts.map((a) => [a.accountName, a.amount]), [["Depreciation Expense", 20]]);
  assert.deepEqual([pl.operatingProfit.amount, pl.operatingProfit.comparative], [180, 100]);
  assert.deepEqual(pl.financeCosts.accounts.map((a) => [a.accountName, a.amount]), [["Bank Charges", 15]]);
  assert.deepEqual([pl.profitBeforeTax.amount, pl.profitBeforeTax.comparative], [165, 100]);
  assert.deepEqual(pl.incomeTaxExpense.accounts.map((a) => [a.accountName, a.amount]), [["Corporate Tax Expense", 10]]);
  assert.deepEqual([pl.profitForPeriod.amount, pl.profitForPeriod.comparative], [155, 100]);
  assert.deepEqual([pl.otherComprehensiveIncome.amount, pl.otherComprehensiveIncome.comparative], [0, 0]);
  assert.deepEqual([pl.totalComprehensiveIncome.amount, pl.totalComprehensiveIncome.comparative], [155, 100]);

  // the same profit as the existing statements
  const old = await svc.Reports.profitAndLoss({ from: "2025-06-01", to: "2025-06-30" });
  assert.equal(pl.profitForPeriod.amount, old.netProfit);
  assert.equal(pl.grossProfit.amount, old.grossProfit);
  const legacy = await svc.Financial.getProfitAndLoss("2025-06-01T00:00:00+04:00", "2025-06-30T23:59:59.999+04:00");
  assert.equal(pl.profitForPeriod.amount, legacy.netProfit);

  const prior = await Ifrs.profitOrLoss({ from: "2025-06-01", to: "2025-06-30", compare: "prior-period" });
  assert.deepEqual(prior.comparative, { from: "2025-05-01", to: "2025-05-31" });
  assert.deepEqual([prior.revenue.comparative, prior.profitForPeriod.comparative], [200, 100]);

  const none = await Ifrs.profitOrLoss({ from: "2025-06-01", to: "2025-06-30", compare: "none" });
  assert.equal(none.comparative, null);
  assert.equal(none.revenue.comparative, null);
  assert.equal(none.profitForPeriod.comparative, null);
  assert.equal(none.revenue.accounts[0].comparative, null);

  // a different period: the whole of the 2025 year to date
  const year = await Ifrs.profitOrLoss({ from: "2025-01-01", to: "2025-06-30", compare: "none" });
  assert.equal(year.profitForPeriod.amount, 255);
});

test("changes in equity: opening, profit, capital introduced, closing, and it agrees with the position", { skip }, async () => {
  const s = await Ifrs.changesInEquity({ from: "2025-06-01", to: "2025-06-30" });
  assert.deepEqual(s.columns.map((c) => c.key), ["share_capital", "retained_earnings", "other_equity", "total"]);
  const row = (block, key) => block.rows.find((r) => r.key === key).values;
  assert.deepEqual(row(s.current, "opening"), { share_capital: 3000, retained_earnings: 200, other_equity: 0, total: 3200 });
  assert.deepEqual(row(s.current, "profit"), { share_capital: 0, retained_earnings: 155, other_equity: 0, total: 155 });
  assert.equal(row(s.current, "oci").total, 0);
  assert.equal(row(s.current, "comprehensive").total, 155);
  assert.deepEqual(row(s.current, "introduced"), { share_capital: 5000, retained_earnings: 0, other_equity: 0, total: 5000 });
  assert.equal(row(s.current, "reduced").total, 0);
  assert.deepEqual(row(s.current, "closing"), { share_capital: 8000, retained_earnings: 355, other_equity: 0, total: 8355 });
  assert.equal(s.current.equityPerPosition, 8355);
  assert.equal(s.current.reconciles, true);

  const position = await Ifrs.financialPosition({ asAt: "2025-06-30", from: "2025-06-01", compare: "none" });
  assert.equal(row(s.current, "closing").total, position.equityAndLiabilities.equity.amount);

  // the comparative statement is the year before, and its closing is that year's equity
  assert.deepEqual([s.comparative.from, s.comparative.to], ["2024-06-01", "2024-06-30"]);
  assert.equal(row(s.comparative, "opening").total, 0);
  assert.equal(row(s.comparative, "profit").total, 100);
  assert.equal(row(s.comparative, "introduced").total, 3000);
  assert.equal(row(s.comparative, "closing").total, 3100);
  assert.equal(s.reconciles, true);

  assert.equal((await Ifrs.changesInEquity({ from: "2025-06-01", to: "2025-06-30", compare: "none" })).comparative, null);

  // money taken out by the owner is a decrease, shown apart from capital introduced
  await svc.Financial.createVoucher({
    voucherType: "journal", date: at("2025-09-05"), narration: "Owner's drawings",
    lines: [{ accountId: accounts.capital._id, debit: 500 }, { accountId: accounts.cash._id, credit: 500 }],
  }, admin);
  const sept = await Ifrs.changesInEquity({ from: "2025-09-01", to: "2025-09-30", compare: "none" });
  assert.equal(row(sept.current, "opening").total, 8355);
  assert.equal(row(sept.current, "reduced").share_capital, -500);
  assert.equal(row(sept.current, "introduced").total, 0);
  assert.equal(row(sept.current, "closing").total, 7855);
  assert.equal(sept.current.reconciles, true);
});

test("cash flows (indirect): operating, investing, financing, and the closing cash is the ledger's", { skip }, async () => {
  const cf = await Ifrs.cashFlows({ from: "2025-06-01", to: "2025-06-30" });
  assert.equal(cf.title, "Statement of cash flows");
  assert.equal(cf.method, "indirect");
  const op = cf.operating;
  assert.equal(op.profitBeforeTax.amount, 165);
  assert.equal(lineOf(op.adjustments.lines, "depreciation").amount, 20);
  assert.equal(lineOf(op.adjustments.lines, "financeCosts").amount, 15);
  assert.equal(lineOf(op.adjustments.lines, "disposal").amount, 0);
  assert.equal(op.adjustments.amount, 35);
  assert.equal(op.beforeWorkingCapital.amount, 200);
  assert.equal(op.beforeWorkingCapital.comparative, 100);
  assert.equal(lineOf(op.workingCapital.lines, "inventory").amount, -600); // 80 -> 140 bags at 10
  assert.equal(lineOf(op.workingCapital.lines, "receivables").amount, -800); // customers +740, input VAT +60
  assert.equal(lineOf(op.workingCapital.lines, "payables").amount, 790); // vendors +750, output VAT +40
  assert.equal(op.workingCapital.amount, -610);
  assert.equal(op.cashGenerated.amount, -410);
  assert.equal(op.interestPaid.amount, -15);
  assert.equal(op.incomeTaxPaid.amount, -4, "10 expensed, 6 still owed");
  assert.equal(op.net.amount, -429);
  assert.equal(cf.investing.lines[0].amount, -1200, "furniture bought; depreciation is not a payment");
  assert.equal(cf.investing.net.amount, -1200);
  assert.equal(lineOf(cf.financing.lines, "borrowings").amount, 2000);
  assert.equal(lineOf(cf.financing.lines, "equity").amount, 5000);
  assert.equal(cf.financing.net.amount, 7000);
  assert.equal(cf.other.amount, 0);
  assert.equal(cf.netIncrease.amount, 5371);
  assert.equal(cf.openingCash.amount, 3000);
  assert.equal(cf.closingCash.amount, 8371);
  assert.equal(cf.closingPerLedger.amount, 8371);
  assert.equal(cf.reconciles, true);
  assert.equal(cf.difference, 0);
  assert.equal(cf.cashAccounts >= 2, true);

  // comparative year: nothing but the capital came in
  assert.equal(op.profitBeforeTax.comparative, 100);
  assert.equal(op.workingCapital.comparative, -100);
  assert.equal(op.net.comparative, 0);
  assert.equal(cf.financing.net.comparative, 3000);
  assert.equal(cf.netIncrease.comparative, 3000);
  assert.equal(cf.openingCash.comparative, 0);
  assert.equal(cf.closingCash.comparative, 3000);
  assert.equal(cf.comparativeReconciles, true);

  // it agrees with the ledger's own cash flow screen
  const ledger = await svc.Reports.cashFlow({ from: "2025-06-01", to: "2025-06-30" });
  assert.equal(cf.openingCash.amount, ledger.opening);
  assert.equal(cf.closingCash.amount, ledger.closingPerLedger);
  assert.equal(cf.netIncrease.amount, ledger.net);

  const none = await Ifrs.cashFlows({ from: "2025-06-01", to: "2025-06-30", compare: "none" });
  assert.equal(none.comparative, null);
  assert.equal(none.netIncrease.comparative, null);
  assert.equal(none.comparativeReconciles, null);

  // the month before: a quiet month, nothing moves in cash
  const may = await Ifrs.cashFlows({ from: "2025-05-01", to: "2025-05-31", compare: "none" });
  assert.equal(may.netIncrease.amount, 0);
  assert.equal(may.openingCash.amount, 3000);
  assert.equal(may.reconciles, true);
});

test("notes: policies, entity, and the note tables from the ledger", { skip }, async () => {
  const n = await Ifrs.notes({ asAt: "2025-06-30" });
  assert.equal(n.entity.name, "Harbour Trading Co LLC");
  assert.deepEqual(n.policies.map((p) => p.key), ["entity", "basis", "inventory", "revenue", "vat", "classification"]);
  const text = (key) => n.policies.find((p) => p.key === key).text;
  assert.match(text("entity"), /Harbour Trading Co LLC.*100123456789012/);
  assert.match(text("basis"), /IFRS.*AED/s);
  assert.match(text("inventory"), /weighted average/i);
  assert.match(text("revenue"), /IFRS 15/);
  assert.match(text("vat"), /VAT/);
  assert.match(n.disclaimer, /not a complete set/);

  const t = n.tables;
  assert.equal(t.tradeReceivables.rows[0].amount, 1160);
  assert.equal(t.tradeReceivables.rows[0].comparative, 210);
  assert.equal(t.tradeReceivables.total.amount, 1160);
  const ar = t.tradeReceivables.ageing;
  // customers have 30 days: the June invoice is not yet due, May's is 11 days late, 2024's long overdue
  assert.deepEqual(Object.fromEntries(ar.buckets.map((b) => [b.key, b.amount])), { current: 740, d1_30: 210, d31_60: 0, d61_90: 0, d90plus: 210 });
  assert.equal(ar.total, 1160);
  assert.equal(ar.overdue, 420);
  assert.equal(ar.notSetAgainstInvoices, 0, "ledger and open invoices agree");

  assert.equal(t.inventory.total.amount, 1400);
  assert.equal(t.inventory.total.comparative, 400);
  assert.equal(t.inventory.accounts[0].accountName, "Inventory Stock");

  assert.deepEqual(t.cash.accounts.map((a) => [a.accountName, a.net]).sort(), [["Cash in Hand", 6386], ["ENBD Current", 1985]]);
  assert.equal(t.cash.total.net, 8371);
  assert.equal(t.cash.total.comparativeNet, 3000);

  assert.equal(t.tradePayables.rows[0].amount, 1800);
  assert.equal(t.tradePayables.rows[0].comparative, 525);
  assert.deepEqual(Object.fromEntries(t.tradePayables.ageing.buckets.map((b) => [b.key, b.amount])), { current: 750, d1_30: 525, d31_60: 0, d61_90: 0, d90plus: 525 });
  assert.equal(t.tradePayables.ageing.notSetAgainstInvoices, 0);

  assert.equal(t.vat.rows[0].amount, 60);
  assert.equal(t.vat.rows[1].amount, 110);
  assert.equal(t.vat.net.amount, -50, "more input VAT than output VAT: recoverable");

  // every note total agrees with the statement of financial position
  const p = await Ifrs.financialPosition({ asAt: "2025-06-30", compare: "none" });
  assert.equal(amountOf(p.assets.current.groups, "Inventory Stock"), t.inventory.total.amount);
  assert.equal(amountOf(p.assets.current.groups, "Customer - Al Noor"), t.tradeReceivables.total.amount);

  const none = await Ifrs.notes({ asAt: "2025-06-30", compare: "none" });
  assert.equal(none.tables.inventory.total.comparative, null);
  assert.equal(none.comparative, null);
});

test("cash that cannot be explained by a rule is shown as Other, and still reconciles", { skip }, async () => {
  // cash moved to a bank account that is then switched off: it is no longer "cash and bank"
  const dormant = await svc.AccountGroup.findOne({ name: "Bank" }).then((g) => svc.Chart.createAccount({ accountName: "Dormant Bank", groupId: g._id }, {}, admin));
  await svc.Financial.createVoucher({ voucherType: "contra", ledgerBased: true, fromAccountId: accounts.cash._id, toAccountId: dormant._id, totalAmount: 500, date: at("2025-07-10") }, admin);
  await svc.LedgerAccount.updateOne({ _id: dormant._id }, { isActive: false });

  const cf = await Ifrs.cashFlows({ from: "2025-07-01", to: "2025-07-31", compare: "none" });
  assert.equal(cf.other.amount, -500);
  assert.equal(cf.operating.net.amount, 0);
  assert.equal(cf.netIncrease.amount, -500);
  assert.equal(cf.openingCash.amount, 8371);
  assert.equal(cf.closingCash.amount, 7871);
  assert.equal(cf.closingPerLedger.amount, 7871);
  assert.equal(cf.reconciles, true);
  assert.equal(cf.other.label, "Other movements (not classified above)");

  // the position still holds the money, as a current asset
  const p = await Ifrs.financialPosition({ asAt: "2025-07-31", compare: "none" });
  assert.equal(amountOf(p.assets.current.groups, "Dormant Bank"), 500);
  assert.equal(p.isBalanced, true);
});

test("bad input is refused with a clear message", { skip }, async () => {
  await assert.rejects(() => Ifrs.financialPosition({ asAt: "not-a-date" }), { code: "INVALID_DATE" });
  await assert.rejects(() => Ifrs.profitOrLoss({ from: "2025-06-30", to: "2025-06-01" }), { code: "INVALID_RANGE" });
  await assert.rejects(() => Ifrs.cashFlows({ from: "2025-06-01", to: "2025-06-30", compare: "yesterday" }), { code: "INVALID_COMPARE" });
  await assert.rejects(() => Ifrs.notes({ to: "2025-13-01" }), { code: "INVALID_DATE" });
});

test("a ledger that does not balance is reported, not hidden", { skip }, async () => {
  // a one-sided entry, which no voucher could post: cash goes up with nothing on the other side
  await svc.LedgerEntry.create({
    voucherId: new mongoose.Types.ObjectId(), voucherNo: "ROGUE-1", voucherType: "journal", accountId: accounts.cash._id,
    accountName: "Cash in Hand", accountCode: accounts.cash.accountCode, date: at("2025-08-10"), debitAmount: 75, creditAmount: 0, createdBy: admin,
  });
  const cf = await Ifrs.cashFlows({ from: "2025-08-01", to: "2025-08-31", compare: "none" });
  assert.equal(cf.reconciles, false);
  assert.equal(cf.difference, -75, "the statement explains nothing of the 75 that arrived");
  assert.equal(cf.closingPerLedger.amount, 7871 + 75);

  const p = await Ifrs.financialPosition({ asAt: "2025-08-31", from: "2025-08-01", compare: "none" });
  assert.equal(p.isBalanced, false);
  assert.equal(p.difference, 75);

  const s = await Ifrs.changesInEquity({ from: "2025-08-01", to: "2025-08-31", compare: "none" });
  assert.equal(s.current.reconciles, true, "equity itself is still the same as the position's equity");
});
