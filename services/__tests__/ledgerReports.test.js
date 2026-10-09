// General ledger, profit and loss with gross profit, day book, cash and bank book, cash flow and
// party balances, all read from the ledger. Throwaway database; see accountingFoundation.test.js.
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

let svc;
let customer;
let vendor;
let stock;
let vouchers = {};

// Dubai calendar day, the way the reports read dates
const orgDay = (offset = 0) => new Date(Date.now() + 4 * 3600e3 + offset * 86400e3).toISOString().slice(0, 10);

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
    ...require("../../models/modules/banking/bankingModels"),
    AccountGroup: require("../../models/modules/financial/accountGroupModel"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    Stock: require("../../models/modules/stockModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", creditLimit: 500 });
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mills", contactPerson: "x", address: "y" });
  stock = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: new mongoose.Types.ObjectId() });

  const acct = (name) => svc.LedgerAccount.findOne({ accountName: name });
  const [cash, equity, rent, std] = await Promise.all([acct("Cash in Hand"), acct("Opening Balance Equity"), acct("Rent Expense"), svc.TaxCode.findOne({ kind: "standard" })]);
  const bankGroup = await svc.AccountGroup.findOne({ name: "Bank" });
  const enbd = await svc.Chart.createAccount({ accountName: "ENBD Current", groupId: bankGroup._id }, {}, admin);
  const line = (qty, price) => ({ itemId: stock._id, description: "Rice", qty, price, rate: price, vatPercent: 5 });
  const post = async (type, party, partyType, qty, price) => {
    const t = await svc.Tx.createTransaction({ type, partyId: party._id, partyType, partyTypeRef: partyType, items: [line(qty, price)] }, "tester");
    await svc.Tx.processTransaction(t._id, "approve", "tester");
    return t;
  };

  vouchers.capital = await svc.Financial.createVoucher({ voucherType: "journal", date: new Date(), narration: "Opening capital", lines: [{ accountId: cash._id, debit: 5000 }, { accountId: equity._id, credit: 5000 }] }, admin);
  vouchers.purchase = await post("purchase_order", vendor, "Vendor", 100, 10); // 1000 + 50 VAT, vendor owed 1050
  vouchers.sale = await post("sales_order", customer, "Customer", 10, 20); // 200 + 10 VAT, cost 100
  vouchers.receipt = await svc.Financial.createVoucher({ voucherType: "receipt", customerId: customer._id, totalAmount: 100, date: new Date(), paymentMode: "cash" }, admin);
  vouchers.payment = await svc.Financial.createVoucher({ voucherType: "payment", vendorId: vendor._id, totalAmount: 300, date: new Date(), paymentMode: "cash" }, admin);
  vouchers.expense = await svc.Financial.createVoucher({ voucherType: "expense", ledgerBased: true, expenseAccountId: rent._id, amount: 200, taxCodeId: std._id, description: "Office rent", paymentMode: "cash", date: new Date() }, admin);
  vouchers.contra = await svc.Financial.createVoucher({ voucherType: "contra", ledgerBased: true, fromAccountId: cash._id, toAccountId: enbd._id, totalAmount: 1000, date: new Date() }, admin);
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const closingOf = (gl, name) => gl.groups.flatMap((g) => g.accounts).find((a) => a.accountName === name)?.closing;

test("general ledger: every account with opening, debits, credits and closing, filed by group, and it balances", { skip }, async () => {
  const gl = await svc.Reports.generalLedger({ from: orgDay(), to: orgDay() });
  assert.ok(gl.groups.length > 3);
  assert.equal(gl.totals.debit, gl.totals.credit, "debits equal credits");
  assert.equal(gl.totals.closing, 0, "closing balances net to nothing");
  assert.equal(gl.totals.opening, 0);
  assert.equal(closingOf(gl, "Cash in Hand"), 3590); // 5000 + 100 - 300 - 210 - 1000
  assert.equal(closingOf(gl, "ENBD Current"), 1000);
  // the 300 paid to the vendor was not set against an invoice, so it sits on the vendor's advance account
  assert.equal(closingOf(gl, "Vendor - Gulf Mills") + closingOf(gl, "Advance to Vendor - Gulf Mills"), -750);
  assert.equal(closingOf(gl, "Customer - Al Noor") + closingOf(gl, "Customer Advance - Al Noor"), 110);
  const cats = gl.groups.map((g) => g.category);
  assert.deepEqual(cats, [...cats].sort((a, b) => ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"].indexOf(a) - ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"].indexOf(b)));

  // a later period sees all of it as opening, with no movement of its own
  const later = await svc.Reports.generalLedger({ from: orgDay(1), to: orgDay(3) });
  assert.equal(closingOf(later, "Cash in Hand"), 3590);
  assert.equal(later.groups.flatMap((g) => g.accounts).find((a) => a.accountName === "Cash in Hand").opening, 3590);
  assert.equal(later.totals.debit, 0);

  const assets = await svc.Reports.generalLedger({ category: "ASSET" });
  assert.ok(assets.groups.every((g) => g.category === "ASSET"));
});

test("profit and loss: revenue less direct costs is the gross profit, and the net agrees with the old statement", { skip }, async () => {
  const pl = await svc.Reports.profitAndLoss({ from: orgDay(), to: orgDay() });
  assert.equal(pl.revenue.total, 200);
  assert.equal(pl.directCosts.total, 100, "cost of the 10 bags sold at 10 each");
  assert.equal(pl.grossProfit, 100);
  assert.equal(pl.grossMargin, 50);
  assert.equal(pl.operatingExpenses.total, 200, "the rent");
  assert.equal(pl.otherIncome.total, 0);
  assert.equal(pl.netProfit, -100);

  const old = await svc.Financial.getProfitAndLoss(`${orgDay()}T00:00:00+04:00`, `${orgDay()}T23:59:59.999+04:00`);
  assert.equal(pl.netProfit, old.netProfit);
  assert.equal(pl.revenue.total + pl.otherIncome.total, old.totalIncome);
  assert.equal(pl.directCosts.total + pl.operatingExpenses.total, old.totalExpenses);
  assert.ok(pl.revenue.groups[0].accounts.every((a) => a.amount > 0));
});

test("day book: one line per voucher with its party and amount, filters, search and paging", { skip }, async () => {
  const all = await svc.Reports.dayBook({ from: orgDay(), to: orgDay() });
  assert.equal(all.total, 7, "capital journal, purchase, sale, receipt, payment, expense, contra");
  assert.ok(all.rows.every((r) => r.balanced));
  const byLabel = Object.fromEntries(all.byType.map((t) => [t.voucherType, t]));
  assert.equal(byLabel.sales_order.amount, 210);
  assert.equal(byLabel.purchase_order.amount, 1050);
  assert.equal(byLabel.receipt.amount, 100);
  assert.equal(byLabel.payment.amount, 300);
  assert.equal(all.rows.find((r) => r.voucherType === "sales_order").party, "Al Noor");
  assert.equal(all.rows.find((r) => r.voucherType === "sales_order").typeLabel, "Sales invoice");

  const sales = await svc.Reports.dayBook({ type: "sales_order" });
  assert.equal(sales.total, 1);
  const byParty = await svc.Reports.dayBook({ search: "al noor" });
  assert.deepEqual(byParty.rows.map((r) => r.voucherType).sort(), ["receipt", "sales_order"]);
  const byNumber = await svc.Reports.dayBook({ search: vouchers.expense.voucherNo });
  assert.equal(byNumber.total, 1);

  const page2 = await svc.Reports.dayBook({ limit: 3, page: 2 });
  assert.equal(page2.rows.length, 3);
  assert.equal(page2.total, 7);

  const nothing = await svc.Reports.dayBook({ from: orgDay(2), to: orgDay(3) });
  assert.equal(nothing.total, 0);

  const journals = await svc.Reports.dayBook({ type: "journal", includeLines: true });
  assert.equal(journals.rows.length, 1);
  const j = journals.rows[0];
  assert.equal(j.lines.reduce((t, l) => t + l.debit, 0), j.lines.reduce((t, l) => t + l.credit, 0));
  assert.equal(j.lines[0].debit > 0, true, "debit lines first");
});

test("voucher impact: the balanced lines one voucher posted", { skip }, async () => {
  const impact = await svc.Reports.voucherImpact(vouchers.sale._id);
  assert.equal(impact.voucherNo, vouchers.sale.transactionNo);
  assert.equal(impact.balanced, true);
  assert.equal(impact.totals.debit, impact.totals.credit);
  assert.ok(impact.lines.some((l) => l.accountName === "Customer - Al Noor" && l.debit === 210));
  await assert.rejects(() => svc.Reports.voucherImpact(new mongoose.Types.ObjectId()), { code: "NOT_POSTED" });
  await assert.rejects(() => svc.Reports.voucherImpact("nope"), { statusCode: 400 });
});

test("cash and bank book: each account's opening, in, out and closing", { skip }, async () => {
  const book = await svc.Reports.cashBook({ from: orgDay(), to: orgDay() });
  const cash = book.rows.find((r) => r.accountName === "Cash in Hand");
  const bank = book.rows.find((r) => r.accountName === "ENBD Current");
  assert.equal(cash.kind, "cash");
  assert.equal(bank.kind, "bank");
  assert.deepEqual([cash.opening, cash.receipts, cash.payments, cash.closing], [0, 5100, 1510, 3590]);
  assert.deepEqual([bank.opening, bank.receipts, bank.payments, bank.closing], [0, 1000, 0, 1000]);
  assert.equal(book.totals.all.closing, 4590);
  assert.equal(book.totals.cash.closing + book.totals.bank.closing, book.totals.all.closing);
  assert.ok((await svc.Reports.cashBook({ kind: "bank" })).rows.every((r) => r.kind === "bank"));

  const next = await svc.Reports.cashBook({ from: orgDay(1), to: orgDay(2) });
  assert.equal(next.rows.find((r) => r.accountName === "Cash in Hand").opening, 3590);
});

test("cash flow: in and out by kind of voucher, a move between cash and bank is neither, and it reconciles", { skip }, async () => {
  const flow = await svc.Reports.cashFlow({ from: orgDay(), to: orgDay() });
  assert.equal(flow.opening, 0);
  const line = (t) => flow.lines.find((l) => l.voucherType === t);
  assert.equal(line("receipt").inflow, 100);
  assert.equal(line("payment").outflow, 300);
  assert.equal(line("expense").outflow, 210);
  assert.equal(line("journal").inflow, 5000);
  assert.equal(line("contra"), undefined, "a transfer between cash and bank nets to nothing");
  assert.equal(flow.totalIn, 5100);
  assert.equal(flow.totalOut, 510);
  assert.equal(flow.closing, 4590);
  assert.equal(flow.reconciles, true);
  assert.equal(line("receipt").label, "Received from customers");

  const later = await svc.Reports.cashFlow({ from: orgDay(1), to: orgDay(2) });
  assert.equal(later.opening, 4590);
  assert.deepEqual(later.lines, []);
  assert.equal(later.closing, 4590);
});

test("party balances: what customers owe and vendors are owed, with credit limit use and what is overdue", { skip }, async () => {
  const c = await svc.Reports.partyBalances({ type: "customer", asOn: orgDay() });
  const row = c.rows.find((r) => r.partyName === "Al Noor");
  assert.equal(row.balance, 110);
  assert.equal(row.creditLimit, 500);
  assert.equal(row.available, 390);
  assert.equal(row.utilisation, 22);
  assert.equal(row.status, "ok");
  assert.equal(c.totals.owed, 110);

  await svc.Customer.updateOne({ _id: customer._id }, { creditLimit: 100 });
  const over = (await svc.Reports.partyBalances({ type: "customer", asOn: orgDay() })).rows.find((r) => r.partyName === "Al Noor");
  assert.equal(over.status, "over");
  await svc.Customer.updateOne({ _id: customer._id }, { creditLimit: 0 });
  assert.equal((await svc.Reports.partyBalances({ type: "customer", asOn: orgDay() })).rows[0].status, "no-limit");

  const v = await svc.Reports.partyBalances({ type: "vendor", asOn: orgDay() });
  assert.equal(v.rows.find((r) => r.partyName === "Gulf Mills").balance, 750);
  assert.equal(v.totals.owed, 750);

  // before anything happened nobody owes anything
  const earlier = await svc.Reports.partyBalances({ type: "customer", asOn: orgDay(-5) });
  assert.deepEqual(earlier.rows, []);
});

test("bad input is refused with a clear message", { skip }, async () => {
  await assert.rejects(() => svc.Reports.generalLedger({ from: "not-a-date" }), { code: "INVALID_DATE" });
  await assert.rejects(() => svc.Reports.partyBalances({ type: "supplier" }), { statusCode: 400 });
});

test("day book: a cheque receipt that has cleared is one voucher of its own amount, not the amount twice", { skip }, async () => {
  const Cheque = require("../banking/chequeService");
  const bank = await svc.LedgerAccount.findOne({ accountName: "ENBD Current" });
  const before = await svc.Reports.dayBook({ from: orgDay(-1), to: orgDay() });
  const receiptsBefore = before.byType.find((t) => t.voucherType === "receipt")?.amount || 0;

  // received yesterday, cleared today: yesterday's post is the receipt, today's is the clearing of the same voucher
  const yesterday = new Date(Date.now() - 86400e3);
  const r = await svc.Financial.createVoucher({
    voucherType: "receipt", customerId: customer._id, totalAmount: 150, date: yesterday, paymentMode: "cheque",
    paymentDetails: { chequeNo: "DB-001", chequeDate: yesterday, drawnOnBankName: "Citibank", accountId: bank._id },
  }, admin);
  const row = await svc.Cheque.findOne({ voucherId: r._id });
  await Cheque.clear(row._id, { clearedOn: new Date() }, {}, admin);

  // both days: the voucher is still a 150 receipt
  const both = await svc.Reports.dayBook({ from: orgDay(-1), to: orgDay() });
  const mine = both.rows.find((x) => x.voucherNo === r.voucherNo);
  assert.equal(mine.voucherType, "receipt");
  assert.equal(mine.amount, 150, "not 300: the clearing is a move of the same money");
  assert.equal(mine.lineCount, 4, "all four lines are still its own");
  assert.ok(mine.balanced);
  assert.equal(both.byType.find((t) => t.voucherType === "receipt").amount, receiptsBefore + 150, "the receipts total grows by what was received");

  // the day it was received: the receipt only
  const first = await svc.Reports.dayBook({ from: orgDay(-1), to: orgDay(-1) });
  assert.equal(first.rows.find((x) => x.voucherNo === r.voucherNo).amount, 150);
  assert.equal(first.rows.find((x) => x.voucherNo === r.voucherNo).voucherType, "receipt");

  // the day it cleared: only the clearing is in the period, shown as itself with the cheque's amount
  const second = await svc.Reports.dayBook({ from: orgDay(), to: orgDay() });
  const cleared = second.rows.find((x) => x.voucherNo === r.voucherNo);
  assert.equal(cleared.voucherType, "cheque_clearance");
  assert.equal(cleared.typeLabel, "Cheque clearance");
  assert.equal(cleared.amount, 150);
  assert.equal(second.byType.find((t) => t.voucherType === "cheque_clearance").amount, 150);

  // a filter by type finds the receipt, not the clearing
  const receipts = await svc.Reports.dayBook({ type: "receipt", from: orgDay(-1), to: orgDay() });
  assert.equal(receipts.rows.find((x) => x.voucherNo === r.voucherNo).amount, 150);
});
