// The daily voucher summary and the day-end cash and bank reports: what each day's vouchers came to, and what cash and
// bank held at the end of each day, from the same ledger as the day book and the cash book - and agreeing with them.
// Throwaway database; see accountingFoundation.test.js.
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
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// The organisation's calendar days (Asia/Dubai until it says otherwise): today, yesterday, the day before
const orgDay = (offset = 0) => new Date(Date.now() + 4 * 3600e3 + offset * 86400e3).toISOString().slice(0, 10);
const D0 = orgDay(0);
const D1 = orgDay(-1);
const D2 = orgDay(-2);
const D3 = orgDay(-3); // nothing happens on it
const at = (day) => new Date(`${day}T00:00:00.000Z`); // how a day-only date is stored

let svc;
let A = {};

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
    FYModel: require("../../models/modules/financial/fiscalYearModel"),
    Branch: require("../../models/core/branchModel"),
    ...require("../../models/modules/financial/financialModels"),
    AccountGroup: require("../../models/modules/financial/accountGroupModel"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    Stock: require("../../models/modules/stockModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    tenant: require("../../utils/tenantContext"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  await svc.FYModel.deleteMany({}); // a run on 1 or 2 January would otherwise post into a year that does not exist

  const acct = (name) => svc.LedgerAccount.findOne({ accountName: name });
  const bankGroup = await svc.AccountGroup.findOne({ name: "Bank" });
  A.cash = await acct("Cash in Hand");
  A.equity = await acct("Opening Balance Equity");
  A.rent = await acct("Rent Expense");
  A.bank = await svc.Chart.createAccount({ accountName: "ENBD Current", groupId: bankGroup._id }, {}, admin);
  A.std = await svc.TaxCode.findOne({ kind: "standard" });
  A.customer = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", creditLimit: 5000 });
  A.vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mills", contactPerson: "x", address: "y" });
  A.rice = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: new mongoose.Types.ObjectId() });

  const sale = async (day, qty, price) => {
    const t = await svc.Tx.createTransaction({
      type: "sales_order", partyId: A.customer._id, partyType: "Customer", partyTypeRef: "Customer", date: at(day),
      items: [{ itemId: A.rice._id, description: "Rice", qty, price, rate: price, vatPercent: 5 }],
    }, "tester");
    await svc.Tx.processTransaction(t._id, "approve", "tester");
    return t;
  };
  const buy = async (day, qty, price) => {
    const t = await svc.Tx.createTransaction({
      type: "purchase_order", partyId: A.vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", date: at(day),
      items: [{ itemId: A.rice._id, description: "Rice", qty, price, rate: price, vatPercent: 5 }],
    }, "tester");
    await svc.Tx.processTransaction(t._id, "approve", "tester");
    return t;
  };

  // two days ago: the owner puts 5000 in the till, and stock is bought on credit
  await svc.Financial.createVoucher({ voucherType: "journal", date: at(D2), narration: "Opening capital", lines: [{ accountId: A.cash._id, debit: 5000 }, { accountId: A.equity._id, credit: 5000 }] }, admin);
  await buy(D2, 100, 10); // 1000 + 50 VAT owed to the vendor
  // yesterday: a credit sale of 210, 100 of it paid in cash, 300 paid to the vendor, 1000 moved from the till to the bank
  await sale(D1, 10, 20);
  await svc.Financial.createVoucher({ voucherType: "receipt", customerId: A.customer._id, totalAmount: 100, date: at(D1), paymentMode: "cash" }, admin);
  await svc.Financial.createVoucher({ voucherType: "payment", vendorId: A.vendor._id, totalAmount: 300, date: at(D1), paymentMode: "cash" }, admin);
  await svc.Financial.createVoucher({ voucherType: "contra", ledgerBased: true, fromAccountId: A.cash._id, toAccountId: A.bank._id, totalAmount: 1000, date: at(D1) }, admin);
  // today: rent paid in cash (200 + 10 VAT), and 100 brought back from the bank
  await svc.Financial.createVoucher({ voucherType: "expense", ledgerBased: true, expenseAccountId: A.rent._id, amount: 200, taxCodeId: A.std._id, description: "Office rent", paymentMode: "cash", date: at(D0) }, admin);
  await svc.Financial.createVoucher({ voucherType: "contra", ledgerBased: true, fromAccountId: A.bank._id, toAccountId: A.cash._id, totalAmount: 100, date: at(D0) }, admin);
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const refused = (promise, code) => assert.rejects(() => promise, (e) => e.code === code, `expected ${code}`);
const dayOf = (summary, day) => summary.days.find((d) => d.day === day);
const account = (report, name) => report.accounts.find((a) => a.accountName === name);

// ----------------------------------------------------------------------------------------------- daily voucher summary

test("daily summary: each day's vouchers by kind, newest day first, and a day with nothing is not there", { skip }, async () => {
  const s = await svc.Reports.dailySummary({ from: D3, to: D0 });
  assert.deepEqual(s.days.map((d) => d.day), [D0, D1, D2], "D3 had nothing");

  const yesterday = dayOf(s, D1);
  assert.equal(yesterday.count, 4);
  assert.deepEqual(yesterday.byType.sales_order, { count: 1, amount: 210 }, "a sale is its invoice, not its cost legs");
  assert.deepEqual(yesterday.byType.receipt, { count: 1, amount: 100 });
  assert.deepEqual(yesterday.byType.payment, { count: 1, amount: 300 });
  assert.deepEqual(yesterday.byType.contra, { count: 1, amount: 1000 });

  const today = dayOf(s, D0);
  assert.equal(today.count, 2);
  assert.equal(today.byType.contra.amount, 100);
  assert.equal(today.byType.expense.count, 1);

  const earlier = dayOf(s, D2);
  assert.deepEqual(earlier.byType.journal, { count: 1, amount: 5000 });
  assert.deepEqual(earlier.byType.purchase_order, { count: 1, amount: 1050 });
});

test("daily summary: the kinds read in a steady order, and the totals add up", { skip }, async () => {
  const s = await svc.Reports.dailySummary({ from: D2, to: D0 });
  assert.deepEqual(s.types.map((t) => t.voucherType), ["sales_order", "purchase_order", "receipt", "payment", "expense", "journal", "contra"]);
  assert.equal(s.types.find((t) => t.voucherType === "sales_order").label, "Sales invoice");
  assert.equal(s.totals.count, 7 + 1, "capital, purchase, sale, receipt, payment, 2 contras, expense");
  assert.equal(s.totals.count, s.days.reduce((t, d) => t + d.count, 0));
  assert.deepEqual(s.totals.byType.contra, { count: 2, amount: 1100 });
  assert.equal(s.totals.unbalanced, 0);
  for (const d of s.days) assert.equal(d.unbalanced, 0);
});

test("daily summary: agrees with the day book for every day and for the whole period", { skip }, async () => {
  const s = await svc.Reports.dailySummary({ from: D2, to: D0 });
  for (const day of [D2, D1, D0]) {
    const book = await svc.Reports.dayBook({ from: day, to: day });
    assert.equal(dayOf(s, day).count, book.total, `${day}: the same number of vouchers`);
    for (const t of book.byType) {
      assert.deepEqual(dayOf(s, day).byType[t.voucherType], { count: t.count, amount: t.amount }, `${day}: ${t.voucherType} is worth the same`);
    }
  }
  const whole = await svc.Reports.dayBook({ from: D2, to: D0 });
  assert.equal(s.totals.count, whole.total);
  for (const t of whole.byType) assert.deepEqual(s.totals.byType[t.voucherType], { count: t.count, amount: t.amount });
});

test("daily summary: a period with nothing in it is empty, not an error, and a bad date is refused", { skip }, async () => {
  const none = await svc.Reports.dailySummary({ from: orgDay(-40), to: orgDay(-30) });
  assert.deepEqual(none.days, []);
  assert.deepEqual(none.types, []);
  assert.equal(none.totals.count, 0);
  await refused(svc.Reports.dailySummary({ from: "not-a-date" }), "INVALID_DATE");
});

// ----------------------------------------------------------------------------------------------- day end

test("day end: each account's opening, in, out and closing, and the day agrees with the ledger", { skip }, async () => {
  const d = await svc.Reports.dayEndSummary({ date: D1 });
  assert.equal(d.date, D1);
  const cash = account(d, "Cash in Hand");
  assert.deepEqual([cash.opening, cash.receipts, cash.payments, cash.closing], [5000, 100, 1300, 3800], "300 to the vendor and 1000 to the bank");
  assert.equal(cash.vouchers, 3, "the receipt, the payment and the contra");
  const bank = account(d, "ENBD Current");
  assert.deepEqual([bank.opening, bank.receipts, bank.payments, bank.closing], [0, 1000, 0, 1000]);
  assert.equal(bank.vouchers, 1);

  assert.deepEqual([d.totals.cash.closing, d.totals.bank.closing, d.totals.all.closing], [3800, 1000, 4800]);
  assert.equal(d.hadActivity, true);
  assert.equal(d.reconciles, true);
  assert.equal(d.closingPerLedger, 4800);
});

test("day end: where the money came from and went to, with a move between your own accounts in neither", { skip }, async () => {
  const d = await svc.Reports.dayEndSummary({ date: D1 });
  assert.equal(d.moneyIn, 100);
  assert.equal(d.moneyOut, 300);
  assert.equal(d.movedBetweenAccounts, 1000, "the 1,000 from the till to the bank");
  const by = Object.fromEntries(d.sources.map((l) => [l.voucherType, l]));
  assert.deepEqual([by.receipt.inflow, by.receipt.outflow], [100, 0]);
  assert.deepEqual([by.payment.inflow, by.payment.outflow], [0, 300]);
  assert.equal(by.contra, undefined, "a contra is neither in nor out");
  // gross movement through the accounts = money in/out + what moved between them
  assert.equal(r2(d.totals.all.receipts), r2(d.moneyIn + d.movedBetweenAccounts));
  assert.equal(r2(d.totals.all.payments), r2(d.moneyOut + d.movedBetweenAccounts));
});

test("day end: a day opens with what the day before closed with, and a quiet day says so", { skip }, async () => {
  const yesterday = await svc.Reports.dayEndSummary({ date: D1 });
  const today = await svc.Reports.dayEndSummary({ date: D0 });
  assert.equal(today.totals.all.opening, yesterday.totals.all.closing);
  assert.equal(account(today, "Cash in Hand").opening, account(yesterday, "Cash in Hand").closing);
  assert.equal(account(today, "ENBD Current").opening, account(yesterday, "ENBD Current").closing);
  // today: 100 back from the bank, 210 of rent paid (200 + 10 VAT)
  assert.equal(account(today, "Cash in Hand").closing, 3800 + 100 - 210);
  assert.equal(account(today, "ENBD Current").closing, 900);
  assert.equal(today.reconciles, true);

  const quiet = await svc.Reports.dayEndSummary({ date: D3 });
  assert.equal(quiet.hadActivity, false);
  assert.equal(quiet.totals.all.opening, quiet.totals.all.closing);
  assert.equal(quiet.totals.all.opening, 0, "nothing had been paid in yet");
  assert.equal(quiet.moneyIn + quiet.moneyOut + quiet.movedBetweenAccounts, 0);
  assert.equal(quiet.reconciles, true);
});

test("day end: with no date it is today, and a bad date is refused", { skip }, async () => {
  assert.equal((await svc.Reports.dayEndSummary({})).date, D0);
  await refused(svc.Reports.dayEndSummary({ date: "yesterday" }), "INVALID_DATE");
});

// ----------------------------------------------------------------------------------------------- the register

test("day-end register: cash and bank at the end of each day with movement, in date order, agreeing with each day's report", { skip }, async () => {
  const reg = await svc.Reports.dayEndRegister({ from: D3, to: D0 });
  assert.deepEqual(reg.days.map((d) => d.day), [D2, D1, D0]);
  assert.deepEqual(reg.opening, { cash: 0, bank: 0, all: 0 });

  for (const day of [D2, D1, D0]) {
    const d = await svc.Reports.dayEndSummary({ date: day });
    const row = reg.days.find((r) => r.day === day);
    assert.equal(row.cash.closing, d.totals.cash.closing, `${day}: cash`);
    assert.equal(row.bank.closing, d.totals.bank.closing, `${day}: bank`);
    assert.equal(row.closing, d.totals.all.closing);
    assert.equal(row.cash.in, d.totals.cash.receipts);
    assert.equal(row.cash.out, d.totals.cash.payments);
    assert.equal(row.bank.in, d.totals.bank.receipts);
  }
  assert.deepEqual(reg.closing, { cash: 3690, bank: 900, all: 4590 });
  assert.equal(reg.closing.all, (await svc.Reports.dayEndSummary({ date: D0 })).totals.all.closing);
});

test("day-end register: a later window opens with what was held before it", { skip }, async () => {
  const reg = await svc.Reports.dayEndRegister({ from: D0, to: D0 });
  const before = await svc.Reports.dayEndSummary({ date: D1 });
  assert.deepEqual(reg.opening, { cash: before.totals.cash.closing, bank: before.totals.bank.closing, all: before.totals.all.closing });
  assert.equal(reg.days.length, 1);
  assert.equal(reg.closing.all, 4590);

  const none = await svc.Reports.dayEndRegister({ from: orgDay(-40), to: orgDay(-30) });
  assert.deepEqual(none.days, []);
  assert.deepEqual(none.closing, { cash: 0, bank: 0, all: 0 });
});

test("day-end register: the last two weeks when no dates are given, and a backwards range is refused", { skip }, async () => {
  const reg = await svc.Reports.dayEndRegister({});
  assert.equal(reg.to, D0);
  assert.equal(reg.from, orgDay(-13));
  await refused(svc.Reports.dayEndRegister({ from: D0, to: D2 }), "INVALID_RANGE");
});

// ----------------------------------------------------------------------------------------------- branches

test("a branch sees only its own day: its vouchers in the summary and its till at the day end", { skip }, async () => {
  await svc.Branch.create({ code: "shj", name: "Sharjah", isActive: true });
  const sharjah = { companyId: "default", branchId: "shj", branchView: "shj" };
  await svc.tenant.runWithTenant(sharjah, () =>
    svc.Financial.createVoucher({ voucherType: "journal", date: at(D0), narration: "Sharjah float", lines: [{ accountId: A.cash._id, debit: 70 }, { accountId: A.equity._id, credit: 70 }] }, admin));

  await svc.tenant.runWithTenant(sharjah, async () => {
    const s = await svc.Reports.dailySummary({ from: D2, to: D0 });
    assert.deepEqual(s.days.map((d) => d.day), [D0], "only what Sharjah posted");
    assert.equal(s.totals.count, 1);
    const d = await svc.Reports.dayEndSummary({ date: D0 });
    assert.equal(account(d, "Cash in Hand").closing, 70);
    assert.equal(d.totals.all.closing, 70);
    assert.equal(d.reconciles, true);
    const reg = await svc.Reports.dayEndRegister({ from: D2, to: D0 });
    assert.equal(reg.closing.all, 70);
  });

  // head office, looking at every branch, sees the sum of them
  const all = await svc.Reports.dayEndSummary({ date: D0 });
  assert.equal(all.totals.all.closing, 4590 + 70);
  assert.equal(dayOf(await svc.Reports.dailySummary({ from: D0, to: D0 }), D0).count, 3);
});
