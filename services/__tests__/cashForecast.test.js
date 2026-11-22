// The cash forecast against a real database: today's cash from the ledger, then real invoices, bills, cheques, recurring templates and a
// payroll run placed in their weeks.
//   node --require ./utils/testSetup.js --test services/__tests__/cashForecast.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_cf_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
let svc, customer, vendor, rice, cash, capital, bank;
const ymd = (n = 0) => svc.days.addDays(svc.days.todayInOrg(), n);
const at = (d) => new Date(`${d}T00:00:00.000Z`);
const weekOf = (r, day) => r.weeks.find((w) => day >= w.from && day <= w.to);
const L = (qty, price) => ({ itemId: rice._id, description: rice.itemName, qty, price, rate: price, vatPercent: 0 });
let seq = 0;

test.before(async () => {
  if (skip) return;
  process.env.LOG_SILENT = "1";
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Financial: require("../financial/financialService"),
    Tx: require("../orderPurchase/transactionService"),
    Forecast: require("../reports/cashForecastService"),
    Organisation: require("../../models/core/organisationModel"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Cheque: require("../../models/modules/banking/bankingModels").Cheque,
    RecurringInvoice: require("../../models/modules/recurringInvoiceModel"),
    PayrollRun: require("../../models/modules/hr/payrollRunModel"),
    ...require("../../models/modules/financial/financialModels"),
    days: require("../../utils/documentExpiry"),
  };
  require("../../models/modules/uomModel");
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  const acct = (name) => svc.LedgerAccount.findOne({ accountName: name });
  [cash, capital] = await Promise.all([acct("Cash in Hand"), acct("Sales Revenue")]);
  bank = cash; // a cheque needs a bank account id to read back; any ledger account will do for the register
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", creditLimit: 1e7, paymentTerms: "Net 30" });
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mills", contactPerson: "x", address: "y" });
  rice = await svc.Stock.create({ itemId: "R1", sku: "R1", itemName: "Rice", category: new mongoose.Types.ObjectId(), purchasePrice: 5 });
  // 10,000 in cash today
  await svc.Financial.createVoucher({ voucherType: "journal", date: new Date(), lines: [{ accountId: cash._id, debit: 10000 }, { accountId: capital._id, credit: 10000 }] }, new mongoose.Types.ObjectId());
  const buy = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [L(1000, 5)] }, "t");
  await svc.Tx.processTransaction(buy._id, "approve", "t");
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

async function document(type, amountEach, dueIn, extra = {}) {
  seq += 1;
  const party = type === "sales_order" ? customer : vendor;
  const doc = await svc.Tx.createTransaction({ type, partyId: party._id, partyType: type === "sales_order" ? "Customer" : "Vendor", partyTypeRef: type === "sales_order" ? "Customer" : "Vendor", items: [L(1, amountEach)], ...extra }, "t");
  const done = await svc.Tx.processTransaction(doc._id, "approve", "t");
  await svc.Transaction.updateOne({ _id: done._id }, { $set: { dueDate: at(ymd(dueIn)) } });
  return String(done._id);
}
const sourceTotal = (r, source) => r.weeks.reduce((t, w) => t + (w.bySource[source] || 0), 0);

test("the opening is today's cash and bank from the ledger, per account", { skip }, async () => {
  const r = await svc.Forecast.forecast({});
  assert.equal(r.opening, 10000);
  assert.equal(r.weeks.length, 13);
  assert.equal(r.weeks[0].from, ymd(0));
  assert.ok(r.accounts.some((a) => a.name === "Cash in Hand" && a.balance === 10000));
  assert.equal(r.currency, "AED");
  assert.equal(r.totals.closing, r.opening + r.totals.in - r.totals.out);
});

test("an open invoice and an open bill land in the week of their due day; the balance follows", { skip }, async () => {
  // the stock bought in the setup (5,000, no due date, so due today) is a real open bill too: compare against it
  const base = await svc.Forecast.forecast({});
  assert.equal(sourceTotal(base, "payables"), -5000);
  const inv = await document("sales_order", 3000, 10);
  const bill = await document("purchase_order", 800, 3);
  const r = await svc.Forecast.forecast({});
  const inWeek = weekOf(r, ymd(10));
  const outWeek = weekOf(r, ymd(3));
  assert.ok(inWeek.items.some((i) => i.source === "receivables" && i.amount === 3000 && i.ref));
  assert.ok(outWeek.items.some((i) => i.source === "payables" && i.amount === -800));
  assert.equal(sourceTotal(r, "receivables"), 3000);
  assert.equal(sourceTotal(r, "payables"), -5800);
  assert.equal(r.totals.in - r.totals.out, 3000 - 5800);
  // paying the bill takes it out of the forecast
  await svc.Transaction.updateOne({ _id: bill }, { $set: { outstandingAmount: 0, paidAmount: 800 } });
  assert.equal(sourceTotal(await svc.Forecast.forecast({}), "payables"), -5000);
  await svc.Transaction.updateOne({ _id: inv }, { $set: { outstandingAmount: 0, paidAmount: 3000 } });
  assert.equal(sourceTotal(await svc.Forecast.forecast({}), "receivables"), 0);
});

test("an overdue invoice is shown apart and is NOT in the balance", { skip }, async () => {
  const late = await document("sales_order", 1234, -6);
  const r = await svc.Forecast.forecast({});
  assert.equal(r.overdue.in, 1234);
  assert.equal(r.overdue.count, 1);
  assert.equal(sourceTotal(r, "receivables"), 0);
  assert.equal(r.totals.closing, r.opening - 5000, "only the 5,000 bill due today moves the balance");
  assert.ok(r.notes.some((n) => /overdue/.test(n) && /not counted/.test(n)));
  await svc.Transaction.updateOne({ _id: late }, { $set: { outstandingAmount: 0 } });
});

test("cheques not yet cleared come in and out on their own date; one on hold is kept out of the balance", { skip }, async () => {
  const cheque = (over) => svc.Cheque.create({
    direction: "receipt", voucherId: new mongoose.Types.ObjectId(), voucherNo: `RV-${(seq += 1)}`, voucherDate: new Date(), partyId: customer._id, partyType: "Customer", partyName: "Al Noor",
    chequeNo: String(1000 + seq), bankAccountId: bank._id, status: "pending", ...over,
  });
  await cheque({ chequeDate: at(ymd(12)), amount: 500 });
  await cheque({ chequeDate: at(ymd(13)), amount: 700, status: "hold", holdReason: "ask them to wait" });
  await cheque({ direction: "payment", chequeDate: at(ymd(20)), amount: 250, partyId: vendor._id, partyType: "Vendor", partyName: "Gulf Mills" });
  await cheque({ chequeDate: at(ymd(-3)), amount: 90 }); // dated in the past
  const r = await svc.Forecast.forecast({});
  assert.equal(sourceTotal(r, "chequesIn"), 500);
  assert.equal(sourceTotal(r, "chequesOut"), -250);
  assert.equal(r.onHold.in, 700);
  assert.ok(r.overdue.in >= 90);
  assert.ok(weekOf(r, ymd(12)).items.some((i) => i.ref.startsWith("Cheque ") && i.amount === 500));
  await svc.Cheque.deleteMany({});
});

test("a running recurring invoice is a guide: each run on its day plus the customer's terms", { skip }, async () => {
  const t = await svc.RecurringInvoice.create({ name: "Maintenance", partyId: customer._id, frequency: "weekly", interval: 1, startDay: ymd(1), totalAmount: 1000, status: "ACTIVE", cursor: 0, made: 0, nextRunDay: ymd(1) });
  const r = await svc.Forecast.forecast({});
  const runs = r.weeks.flatMap((w) => w.items).filter((i) => i.source === "recurringSales");
  assert.ok(runs.length >= 7, `weekly runs, paid 30 days later, inside a 13-week window: got ${runs.length}`);
  assert.ok(runs.every((i) => i.amount === 1000 && i.certain === false));
  assert.equal(runs[0].day, ymd(31), "the first run is tomorrow, paid after the 30-day terms");
  await svc.RecurringInvoice.updateOne({ _id: t._id }, { $set: { status: "PAUSED" } });
  assert.equal(sourceTotal(await svc.Forecast.forecast({}), "recurringSales"), 0);
  await svc.RecurringInvoice.deleteMany({});
});

test("a running recurring expense goes out each run, with its tax", { skip }, async () => {
  let RecurringVoucher;
  try { RecurringVoucher = require("../../models/modules/financial/recurringVoucherModel"); } catch { return; } // not in this build: skipped quietly by the service too
  const TaxCode = require("../../models/modules/financial/taxCodeModel");
  const std = await TaxCode.findOne({ kind: "standard" });
  const t = await RecurringVoucher.create({
    name: "Office rent", kind: "expense", ownerId: new mongoose.Types.ObjectId(), frequency: "monthly", interval: 1, startDay: ymd(2), amount: 2000, taxCodeId: std?._id,
    description: "Rent", expenseAccountId: cash._id, paymentMode: "cash", status: "ACTIVE", cursor: 0, made: 0, nextRunDay: ymd(2),
  });
  const rate = std?.ratePercent || 0;
  const r = await svc.Forecast.forecast({});
  const runs = r.weeks.flatMap((w) => w.items).filter((i) => i.source === "recurringExpenses");
  assert.ok(runs.length >= 3);
  assert.equal(runs[0].amount, -(2000 * (1 + rate / 100)));
  assert.equal(runs[0].day, ymd(2));
  // a journal template moves no cash and is left out
  await RecurringVoucher.create({ name: "Prepaid", kind: "journal", ownerId: new mongoose.Types.ObjectId(), frequency: "monthly", interval: 1, startDay: ymd(2), lines: [{ accountId: cash._id, debit: 99 }, { accountId: capital._id, credit: 99 }], status: "ACTIVE", nextRunDay: ymd(2) });
  const again = await svc.Forecast.forecast({});
  assert.equal(again.weeks.flatMap((w) => w.items).filter((i) => i.source === "recurringExpenses").length, runs.length);
  await RecurringVoucher.deleteMany({});
});

test("payroll: each coming month end at the last posted net pay, and only where HR was bought", { skip }, async () => {
  const now = new Date();
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  await svc.PayrollRun.create({ period: lastMonth, payDate: `${lastMonth}-28`, status: "POSTED", employeeCount: 4, totalGross: 10000, totalEarnings: 10000, totalDeductions: 1000, totalNet: 9000, voucherNo: "PAY-1" });
  const r = await svc.Forecast.forecast({});
  const pay = r.weeks.flatMap((w) => w.items).filter((i) => i.source === "payroll" && i.label.startsWith("Salaries for"));
  assert.ok(pay.length >= 2, "at least two month ends inside 13 weeks");
  assert.ok(pay.every((i) => i.amount === -9000 && i.certain === false));
  assert.ok(pay.every((i) => i.day.slice(8) === String(new Date(Date.UTC(Number(i.day.slice(0, 4)), Number(i.day.slice(5, 7)), 0)).getUTCDate())), "each on the last day of its month");

  await svc.Organisation.updateOne({ code: "default" }, { $set: { "moduleOverrides.hr": false } });
  const off = await svc.Forecast.forecast({});
  assert.equal(sourceTotal(off, "payroll"), 0);
  assert.ok(off.notes.some((n) => /payroll is not part of this plan/.test(n)));
  await svc.Organisation.updateOne({ code: "default" }, { $unset: { "moduleOverrides.hr": 1 } });
  await svc.PayrollRun.deleteMany({});
});

test("the weeks asked for are checked, and the sum of the weeks is the balance", { skip }, async () => {
  assert.equal((await svc.Forecast.forecast({ weeks: "4" })).weeks.length, 4);
  for (const weeks of ["0", "27", "x", "2.5", "-1"]) {
    await assert.rejects(() => svc.Forecast.forecast({ weeks }), { code: "INVALID_WEEKS" }, weeks);
  }
  // a single-element array (what a different query parser makes of weeks[]=3) is not a number somebody typed: Number(["3"]) is 3
  for (const weeks of [["3"], [3], { n: 3 }, true]) await assert.rejects(() => svc.Forecast.forecast({ weeks }), { code: "INVALID_WEEKS" }, JSON.stringify(weeks));
  const r = await svc.Forecast.forecast({});
  assert.equal(Math.round((r.opening + r.weeks.reduce((t, w) => t + w.net, 0)) * 100), Math.round(r.totals.closing * 100));
  assert.deepEqual(r.weeks.map((w) => w.key), Array.from({ length: 13 }, (_, i) => `W${i + 1}`));
});
