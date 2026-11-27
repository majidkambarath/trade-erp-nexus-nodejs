// What a tax credit note must say about the supply it corrects (VAT Executive Regulation Art. 60(1)): the invoice's date and
// value, what had already been credited, and why. Throwaway database, dropped after.
//
//   node --require ./utils/testSetup.js --test services/__tests__/creditNoteParticulars.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const admin = new mongoose.Types.ObjectId();
const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_cn_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;

let svc;
let customer;
let stock;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Tx: require("../orderPurchase/transactionService"),
    Returns: require("../orderPurchase/returnService"),
    Config: require("../financial/accountConfigService"),
    Financial: require("../financial/financialService"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Customer: require("../../models/modules/customerModel"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    UOM: require("../../models/modules/uomModel"),
  };
  require("../../models/core/organisationModel");
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  customer = await svc.Customer.create({ customerId: "CUST-CN", customerName: "Al Noor", billingAddress: "Deira" });
  stock = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: new mongoose.Types.ObjectId(), currentStock: 100, purchasePrice: 5, costValue: 500 });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const line = (qty) => ({ itemId: stock._id, description: "Rice", qty, price: 10, rate: 10, vatPercent: 5 });
const sale = async () => {
  const t = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", date: "2026-11-02", items: [line(10)] }, "tester");
  return svc.Tx.processTransaction(t._id, "approve", "tester");
};
const back = (invoice, qty, extra = {}) => svc.Tx.createTransaction({
  type: "sales_return", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", date: "2026-11-20",
  returnOf: { transactionId: invoice._id, date: "1999-01-01", value: 1, creditedBefore: 999 }, items: [line(qty)], ...extra,
}, "tester");

test("a credit note records the invoice's date and value, what was credited before, and why", { skip }, async () => {
  const invoice = await sale();
  const first = await back(invoice, 2, { returnReason: "  Damaged   in transit " });
  assert.equal(new Date(first.returnOf.date).toISOString().slice(0, 10), "2026-11-02", "the invoice's own date, not one the request named");
  assert.equal(first.returnOf.value, 100);
  assert.equal(first.returnOf.vat, 5);
  assert.equal(first.returnOf.creditedBefore, 0);
  assert.equal(first.returnReason, "Damaged in transit");
  await svc.Tx.processTransaction(first._id, "approve", "tester");

  // the second note is written knowing what the first credited, read again when it is approved
  const second = await back(invoice, 3);
  assert.equal(second.returnReason, "Goods returned by the customer", "a return with no reason says what it is");
  await svc.Tx.updateTransaction(second._id, { returnReason: "Wrong item delivered", returnOf: { value: 7 } }, "tester");
  const approved = await svc.Tx.processTransaction(second._id, "approve", "tester");
  assert.equal(approved.returnOf.creditedBefore, 20);
  assert.equal(approved.returnOf.value, 100);
  assert.equal(approved.returnReason, "Wrong item delivered");

  const listed = await svc.Tx.getAllTransactions({ type: "sales_return" });
  const rows = listed.transactions || listed;
  assert.ok(rows.some((r) => r.returnReason === "Wrong item delivered" && r.returnOf?.value === 100), "the list carries what the paper prints");

  const returnable = await svc.Returns.returnable(invoice._id);
  assert.equal(returnable.value, 100);
  assert.equal(returnable.totalAmount, 105);
});

test("a ledger note names the invoice it corrects, even one it cannot be set against, and keeps its reason", { skip }, async () => {
  const invoice = await sale();
  const { LedgerAccount } = require("../../models/modules/financial/financialModels");
  const income = await LedgerAccount.findById(await svc.Config.resolveAccount("sales-revenue")).lean();
  await require("../financial/taxCodeService").ensureStarter("default", "AE");
  const std = await svc.TaxCode.findOne({ kind: "standard" }).lean();
  const debit = await svc.Financial.createVoucher({
    voucherType: "debit_note", partyType: "Customer", partyId: customer._id, date: "2026-11-21", originalInvoiceId: invoice._id, reason: "Price agreed was higher",
    lines: [{ accountId: income._id, amount: 20, taxCodeId: std._id }],
  }, admin);
  assert.equal(debit.referenceInvoiceNo, invoice.transactionNo);
  assert.equal(new Date(debit.referenceInvoiceDate).toISOString().slice(0, 10), "2026-11-02");
  assert.equal(debit.referenceInvoiceValue, 100);
  assert.equal(debit.reason, "Price agreed was higher");
  assert.equal((debit.linkedInvoices || []).length, 0, "named, not settled");

  const credit = await svc.Financial.createVoucher({
    voucherType: "credit_note", partyType: "Customer", partyId: customer._id, date: "2026-11-21", referenceInvoiceId: invoice._id, narration: "Short delivery",
    lines: [{ accountId: income._id, amount: 10, taxCodeId: std._id }],
  }, admin);
  assert.equal(credit.referenceInvoiceVat, 5);
  assert.equal(credit.reason, "Short delivery", "a typed narration is the reason");

  await assert.rejects(svc.Financial.createVoucher({
    voucherType: "credit_note", partyType: "Customer", partyId: customer._id, date: "2026-11-21", originalInvoiceId: new mongoose.Types.ObjectId(),
    lines: [{ accountId: income._id, amount: 1 }],
  }, admin), (e) => e.code === "INVALID_INVOICE");
});
