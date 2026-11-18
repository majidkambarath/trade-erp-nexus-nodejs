// Invoices in a foreign currency: stored and posted in the base currency at the document's rate, with the foreign figures kept beside them.
//   node --require ./utils/testSetup.js --test services/__tests__/fxInvoices.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
let svc, vendor, customer, rice, std;

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  const fin = require("../../models/modules/financial/financialModels");
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Tx: require("../orderPurchase/transactionService"),
    Currencies: require("../financial/currencyService"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Category: require("../../models/modules/categoryModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    LedgerEntry: fin.LedgerEntry,
  };
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  await svc.Currencies.update("USD", { isActive: true }, {});
  await svc.Currencies.update("KWD", { isActive: true }, {});
  await svc.Currencies.addRate("USD", { rate: 3.6725, effectiveDate: new Date().toISOString().slice(0, 10) }, {});
  await svc.Currencies.addRate("KWD", { rate: 12, effectiveDate: new Date().toISOString().slice(0, 10) }, {});
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Vend", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Cust", contactPerson: "Ali", paymentTerms: "Net 30", trnNumber: "100999888700003" });
  const category = await svc.Category.create({ name: "General" });
  rice = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: category._id });
  std = await svc.TaxCode.findOne({ kind: "standard" }).lean();
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const L = (qty, price, extra = {}) => ({ itemId: rice._id, description: "Rice", qty, price, rate: price, vatPercent: 5, taxCodeId: std._id, ...extra });
const buy = (items, extra = {}) => svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items, ...extra }, "tester");
const sell = (items, extra = {}) => svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items, ...extra }, "tester");
const approve = (t) => svc.Tx.processTransaction(t._id, "approve", "tester");
const live = (t) => svc.LedgerEntry.find({ voucherId: t._id, isReversed: { $ne: true } }).lean();
const totals = async (t) => {
  const e = await live(t);
  return { dr: r2(e.reduce((s, x) => s + x.debitAmount, 0)), cr: r2(e.reduce((s, x) => s + x.creditAmount, 0)) };
};

test("a USD sale of 1,000 at 3.6725 is stored in AED with the dollar figures kept", { skip }, async () => {
  await approve(await buy([L(100, 10, { taxCodeId: undefined, vatPercent: 0 })]));
  const t = await sell([L(10, 100)], { currency: "USD" });
  assert.equal(t.fx.currency, "USD");
  assert.equal(t.fx.rate, 3.6725);
  assert.equal(t.fx.totalAmount, 1050);
  assert.equal(t.fx.outstandingAmount, 1050);
  assert.equal(t.items[0].taxableAmount, 3672.5);
  assert.equal(t.items[0].vatAmount, 183.63);
  assert.equal(t.totalAmount, 3856.13);
  assert.equal(t.items[0].fx.lineTotal, 1050);
  assert.equal(t.pricing.grandTotal, 3856.13);
  const a = await approve(t);
  assert.notEqual(a.status, "DRAFT");
  const tt = await totals(t);
  assert.equal(tt.dr, tt.cr, "posts balanced in AED");
  const stored = await svc.Transaction.findById(t._id).lean();
  assert.equal(stored.outstandingAmount, 3856.13);
});

test("a base-currency document is untouched: no fx block", { skip }, async () => {
  const t = await sell([L(1, 100)]);
  assert.equal(t.fx?.currency, undefined);
  assert.equal(t.totalAmount, 105);
});

test("the currency is refused when it cannot work", { skip }, async () => {
  await assert.rejects(() => sell([L(1, 100)], { currency: "KWD" }), { code: "FOREIGN_DECIMALS_UNSUPPORTED" });
  await assert.rejects(() => sell([L(1, 100)], { currency: "EUR" }), (e) => ["CURRENCY_INACTIVE", "CURRENCY_NOT_ACTIVE", "NO_RATE", "CURRENCY_NOT_FOUND"].includes(e.code) || /EUR/.test(e.message));
  await assert.rejects(() => sell([L(1, 100)], { currency: "USD", isOpening: true }), (e) => true);
  await assert.rejects(() => sell([L(1, 100)], { currency: "USD", exchangeRate: 9 }), (e) => /reason|tolerance|differs/i.test(e.message));
});

test("a typed rate inside tolerance with a reason is kept on the document", { skip }, async () => {
  const t = await sell([L(1, 100)], { currency: "USD", exchangeRate: 3.7 });
  assert.equal(t.fx.rate, 3.7);
  assert.equal(t.items[0].taxableAmount, 370);
});

test("editing a draft foreign invoice needs its lines, and re-prices at the same rate", { skip }, async () => {
  const t = await sell([L(1, 100)], { currency: "USD" });
  await assert.rejects(() => svc.Tx.updateTransaction(t._id, { discount: 5 }, "tester"), { code: "FOREIGN_NEEDS_LINES" });
  const u = await svc.Tx.updateTransaction(t._id, { items: [L(2, 100)] }, "tester");
  assert.equal(u.fx.rate, 3.6725);
  assert.equal(u.fx.totalAmount, 210);
  assert.equal(u.totalAmount, r2(2 * 100 * 3.6725 * 1.05));
  const forged = await svc.Tx.updateTransaction(t._id, { items: [L(1, 100)], fx: { rate: 1, totalAmount: 1 } }, "tester");
  assert.equal(forged.fx.rate, 3.6725, "a body cannot write fx");
});

test("a header discount on a foreign invoice is spread and the base lines still add up", { skip }, async () => {
  const t = await sell([L(3, 33.33), L(2, 12.5)], { currency: "USD", discount: 10 });
  const sum = r2(t.items.reduce((s, i) => s + i.lineTotal, 0));
  assert.equal(sum, t.totalAmount);
  for (const i of t.items) assert.equal(r2(i.taxableAmount + i.vatAmount), i.lineTotal);
});

// ===================================== settlement =====================================

const mk = require("mongoose").Types;
const Fin = () => require("../financial/financialService");
const receipt = (extra) => Fin().createVoucher({ voucherType: "receipt", customerId: customer._id, date: new Date(), paymentMode: "cash", ...extra }, new mk.ObjectId());
const payment = (extra) => Fin().createVoucher({ voucherType: "payment", vendorId: vendor._id, date: new Date(), paymentMode: "cash", ...extra }, new mk.ObjectId());
const legsOf = async (v) => (await svc.LedgerEntry.find({ voucherId: v._id, isReversed: { $ne: true } }).lean()).map((e) => `${e.accountName}:${e.debitAmount ? "Dr" + e.debitAmount : "Cr" + e.creditAmount}`).sort();
const fresh = (t) => svc.Transaction.findById(t._id).lean();
const usdSale = async (qty = 10, price = 100) => approve(await sell([L(qty, price)], { currency: "USD" })).then(() => null);
async function approvedUsdSale() {
  const t = await sell([L(10, 100)], { currency: "USD" });
  await approve(t);
  return t;
}

test("a receipt in the invoice's currency settles it: the dollars clear, the ledger's dirhams clear, the difference is an exchange gain", { skip }, async () => {
  const inv = await approvedUsdSale();
  assert.equal((await fresh(inv)).fx.outstandingAmount, 1050);
  const r = await receipt({ currency: "USD", foreignAmount: 1050, exchangeRate: 3.7, linkedInvoices: [{ invoiceId: inv._id, amount: 1050, balance: 0 }] });
  assert.equal(r.totalAmount, 3885);
  assert.equal(r.linkedInvoices[0].allocatedAmount, 3856.13, "what the ledger carried");
  assert.equal(r.linkedInvoices[0].allocatedForeign, 1050);
  assert.equal(r.onAccountAmount, 0);
  assert.deepEqual(await legsOf(r), ["Cash in Hand:Dr3885", "Customer - Cust:Cr3856.13", "Exchange Gain / Loss:Cr28.87"].sort());
  const after = await fresh(inv);
  assert.equal(after.outstandingAmount, 0);
  assert.equal(after.fx.outstandingAmount, 0);
  assert.equal(after.fx.paidAmount, 1050);
  assert.equal(after.paidAmount, 3856.13);

  await Fin().deleteVoucher(r._id, new mk.ObjectId());
  const back = await fresh(inv);
  assert.equal(back.outstandingAmount, 3856.13);
  assert.equal(back.fx.outstandingAmount, 1050);
  assert.equal(back.fx.paidAmount, 0);
});

test("part payments each clear their share, the last clears what is left, and the differences are losses when the dollar fell", { skip }, async () => {
  const inv = await approvedUsdSale();
  const r1 = await receipt({ currency: "USD", foreignAmount: 500, exchangeRate: 3.6, linkedInvoices: [{ invoiceId: inv._id, amount: 500, balance: 550 }] });
  assert.equal(r1.linkedInvoices[0].allocatedAmount, 1836.25);
  assert.deepEqual(await legsOf(r1), ["Cash in Hand:Dr1800", "Customer - Cust:Cr1836.25", "Exchange Gain / Loss:Dr36.25"].sort());
  const mid = await fresh(inv);
  assert.deepEqual([mid.fx.outstandingAmount, mid.outstandingAmount], [550, 2019.88]);

  const r2_ = await receipt({ currency: "USD", foreignAmount: 550, exchangeRate: 3.65, linkedInvoices: [{ invoiceId: inv._id, amount: 550, balance: 0 }] });
  assert.equal(r2_.linkedInvoices[0].allocatedAmount, 2019.88, "the last part takes everything the ledger still carried");
  const end = await fresh(inv);
  assert.deepEqual([end.fx.outstandingAmount, end.outstandingAmount], [0, 0]);
});

test("an unallocated part of a foreign receipt stays on account at its base value", { skip }, async () => {
  const inv = await approvedUsdSale();
  const r = await receipt({ currency: "USD", foreignAmount: 1200, exchangeRate: 3.6725, linkedInvoices: [{ invoiceId: inv._id, amount: 1050, balance: 0 }] });
  assert.equal(r.totalAmount, 4407);
  assert.equal(r.onAccountAmount, 550.87, "150 USD x 3.6725 less rounding of the proportional split");
  const legs = await legsOf(r);
  assert.ok(legs.includes("Customer - Cust:Cr3856.13"));
  assert.ok(legs.some((l) => l.startsWith("Customer Advance")));
});

test("the guards: a dirham voucher cannot settle a dollar invoice, nor another currency, nor a mixture; a note cannot be set against it", { skip }, async () => {
  const inv = await approvedUsdSale();
  await assert.rejects(() => receipt({ totalAmount: 100, linkedInvoices: [{ invoiceId: inv._id, amount: 100, balance: 3756.13 }] }), { code: "FOREIGN_INVOICE_NEEDS_CURRENCY" });
  const base = await sell([L(1, 100)]);
  await approve(base);
  await assert.rejects(
    () => receipt({ currency: "USD", foreignAmount: 100, linkedInvoices: [{ invoiceId: inv._id, amount: 50, balance: 1000 }, { invoiceId: base._id, amount: 50, balance: 55 }] }),
    { code: "MIXED_INVOICE_CURRENCIES" }
  );
  await assert.rejects(() => receipt({ currency: "USD", foreignAmount: 2000, linkedInvoices: [{ invoiceId: inv._id, amount: 1100, balance: -50 }] }), (e) => /mismatch|only/i.test(e.message));
  const open = await fresh(inv);
  assert.equal(open.fx.outstandingAmount, 1050, "no refused voucher touched the invoice");
});

test("a payment to a supplier in dollars: paying more dirhams than were carried is a loss", { skip }, async () => {
  const bill = await buy([L(10, 100, { taxCodeId: undefined, vatPercent: 0 })], { currency: "USD" });
  await approve(bill);
  assert.equal((await fresh(bill)).totalAmount, 3672.5);
  const p = await payment({ currency: "USD", foreignAmount: 1000, exchangeRate: 3.7, linkedInvoices: [{ invoiceId: bill._id, amount: 1000, balance: 0 }] });
  assert.deepEqual(await legsOf(p), ["Cash in Hand:Cr3700", "Exchange Gain / Loss:Dr27.5", "Vendor - Vend:Dr3672.5"].sort());
  assert.equal((await fresh(bill)).fx.outstandingAmount, 0);
});

test("a return of a dollar invoice is in dollars at the invoice's rate and takes dollars off what is owed", { skip }, async () => {
  const inv = await approvedUsdSale();
  const line = inv.items[0];
  await assert.rejects(() => svc.Tx.createTransaction({ type: "sales_return", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", currency: "EUR", returnOf: { transactionId: inv._id }, items: [L(2, 100, { returnOfLineId: line._id })] }, "t"), { code: "RETURN_CURRENCY_MISMATCH" });
  const ret = await svc.Tx.createTransaction({ type: "sales_return", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", returnOf: { transactionId: inv._id }, items: [L(2, 100, { returnOfLineId: line._id })] }, "t");
  assert.equal(ret.fx.currency, "USD");
  assert.equal(ret.fx.rate, 3.6725);
  assert.equal(ret.fx.totalAmount, 210);
  assert.equal(ret.totalAmount, 771.23);
  await approve(ret);
  const after = await fresh(inv);
  assert.deepEqual([after.fx.creditedAmount, after.fx.outstandingAmount], [210, 840]);
  assert.equal(after.outstandingAmount, r2(3856.13 - 771.23));
  await svc.Tx.deleteTransaction(ret._id, "t");
  const back = await fresh(inv);
  assert.deepEqual([back.fx.creditedAmount, back.fx.outstandingAmount, back.outstandingAmount], [0, 1050, 3856.13]);
});

// ===================================== reading it back =====================================

test("the return form is handed the invoice's currency, rate and dollar prices", { skip }, async () => {
  const inv = await approvedUsdSale();
  const R = require("../orderPurchase/returnService");
  const out = await R.returnable(inv._id);
  assert.equal(out.currency, "USD");
  assert.equal(out.exchangeRate, 3.6725);
  assert.equal(out.lines[0].price, 100, "the foreign unit price, not the dirham one");
  const base = await sell([L(1, 100)]);
  await approve(base);
  const plain = await R.returnable(base._id);
  assert.equal(plain.currency, undefined);
});

test("the list carries the foreign view so it prints and the voucher form can settle in it", { skip }, async () => {
  const inv = await approvedUsdSale();
  require("../../models/modules/uomModel"); // the list joins units
  const page = await svc.Tx.getAllTransactions({ type: "sales_order", limit: 200 });
  const rows = page.transactions || page.data || page;
  const row = rows.find((x) => String(x._id) === String(inv._id));
  assert.ok(row, "the invoice is listed");
  assert.equal(row.fx.currency, "USD");
  assert.equal(row.fx.outstandingAmount, 1050);
});

test("exposure: open dollar invoices valued at the rate on a day against what the ledger carries, nothing posted", { skip }, async () => {
  const Exposure = require("../financial/fxExposureService");
  const before = await svc.LedgerEntry.countDocuments({});
  const rep = await Exposure.report({});
  assert.equal(rep.baseCurrency, "AED");
  assert.ok(rep.rows.length > 0);
  const usd = rep.currencies.find((c) => c.currency === "USD");
  assert.ok(usd && usd.receivable > 0);
  assert.equal(r2(usd.valued - usd.carrying), usd.difference);
  assert.equal(rep.totalDifference, r2(rep.currencies.reduce((t, c) => t + c.difference, 0)));
  assert.equal(await svc.LedgerEntry.countDocuments({}), before, "a report posts nothing");
  await assert.rejects(() => Exposure.report({ asOn: "not a date" }), { code: "INVALID_DATE" });
});
