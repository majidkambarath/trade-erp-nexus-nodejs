// The audit trail and "no hard deletes": every change a person makes is logged with its old and new values, the log cannot
// be changed, an approved document is cancelled and kept, a record with history cannot be deleted, and anything that is
// deleted is kept whole. Throwaway database, dropped after.
//
//   node --require ./utils/testSetup.js --test services/__tests__/auditComplete.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const { withActor } = require("../../utils/tenantContext");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_au_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const person = { id: String(new mongoose.Types.ObjectId()), name: "mariam@example.ae", ip: "10.1.2.3" };
const as = (fn) => withActor(person, fn);

let svc;
let stock;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Tx: require("../orderPurchase/transactionService"),
    Config: require("../financial/accountConfigService"),
    Financial: require("../financial/financialService"),
    Customers: require("../customer/customerService"),
    StockService: require("../stock/stockService"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Customer: require("../../models/modules/customerModel"),
    ActivityLog: require("../../models/modules/financial/activityLogModel"),
    Deleted: require("../../models/modules/deletedRecordModel"),
    CreditLog: require("../../models/modules/CreditLog"),
    UOM: require("../../models/modules/uomModel"),
  };
  require("../../models/core/organisationModel");
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  stock = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: new mongoose.Types.ObjectId(), currentStock: 100, purchasePrice: 5, costValue: 500 });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const rows = (action) => svc.ActivityLog.find({ action }).sort({ at: 1, _id: 1 }).lean();
const sale = async (customer, approve = true) => {
  const t = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", date: new Date(), items: [{ itemId: stock._id, description: "Rice", qty: 2, price: 10, rate: 10, vatPercent: 5 }] }, person.id);
  return approve ? svc.Tx.processTransaction(t._id, "approve", person.id) : t;
};

test("a person's change is logged with the field, its old and new value, who and from where", { skip }, async () => {
  const c = await as(() => svc.Customers.createCustomer({ customerName: "Al Noor", contactPerson: "Ali", billingAddress: "Deira", phone: "+971501111111" }));
  const [created] = await rows("CUSTOMER_CREATED");
  assert.equal(created.entityId, String(c._id));
  assert.equal(created.username, person.name);
  assert.equal(created.userId, person.id);
  assert.equal(created.ip, person.ip);

  await as(() => svc.Customers.updateCustomer(c._id, { phone: "+971502222222", billingAddress: "Deira, Dubai" }));
  const [updated] = await rows("CUSTOMER_UPDATED");
  const byField = Object.fromEntries(updated.changes.map((x) => [x.field, x]));
  assert.deepEqual(byField.phone, { field: "phone", from: "+971501111111", to: "+971502222222" });
  assert.equal(byField.billingAddress.to, "Deira, Dubai");
  assert.match(updated.summary, /changed: .*phone/);

  // the books' own figures are not a person's change, and a change with no person behind it names nobody
  await as(() => svc.Customer.updateOne({ _id: c._id }, { $set: { cashBalance: 99 } }));
  await svc.Customer.updateOne({ _id: c._id }, { $set: { phone: "+971503333333" } });
  assert.equal((await rows("CUSTOMER_UPDATED")).length, 1);
});

test("the audit log cannot be changed or removed", { skip }, async () => {
  const any = await svc.ActivityLog.findOne({}).exec();
  for (const attempt of [
    () => svc.ActivityLog.updateOne({ _id: any._id }, { $set: { summary: "edited" } }),
    () => svc.ActivityLog.updateMany({}, { $set: { summary: "edited" } }),
    () => svc.ActivityLog.findOneAndUpdate({ _id: any._id }, { $set: { summary: "edited" } }),
    () => svc.ActivityLog.deleteOne({ _id: any._id }),
    () => svc.ActivityLog.deleteMany({}),
    () => svc.ActivityLog.findOneAndDelete({ _id: any._id }),
    () => { any.summary = "edited"; return any.save(); },
    () => any.deleteOne(),
  ]) {
    await assert.rejects(attempt, (e) => e.code === "AUDIT_LOG_IMMUTABLE");
  }
  assert.notEqual((await svc.ActivityLog.findById(any._id).lean()).summary, "edited");
});

test("an approved invoice is cancelled and kept; a draft is deleted and kept whole in Deleted records", { skip }, async () => {
  const c = await svc.Customer.create({ customerId: "C-2", customerName: "Bright Star", billingAddress: "Sharjah" });
  const approved = await sale(c);
  const before = (await svc.Stock.findById(stock._id).lean()).currentStock;
  const result = await as(() => svc.Tx.deleteTransaction(approved._id, person.id, { reason: "Raised to the wrong customer" }));
  assert.equal(result.cancelled, true);
  const kept = await svc.Transaction.findById(approved._id).lean();
  assert.equal(kept.status, "CANCELLED");
  assert.equal(kept.cancelled.reason, "Raised to the wrong customer");
  assert.equal(kept.cancelled.wasApproved, true);
  assert.equal(kept.transactionNo, approved.transactionNo, "its number stays on it");
  assert.equal((await svc.Stock.findById(stock._id).lean()).currentStock, before + 2, "its stock is back, as a delete did");
  await assert.rejects(svc.Tx.deleteTransaction(approved._id, person.id), (e) => e.code === "ALREADY_CANCELLED");

  const draft = await sale(c, false);
  await as(() => svc.Tx.deleteTransaction(draft._id, person.id));
  assert.equal(await svc.Transaction.findById(draft._id), null);
  const copy = await svc.Deleted.findOne({ entity: "Transaction", entityId: String(draft._id) }).lean();
  assert.equal(copy.label, draft.transactionNo);
  assert.equal(copy.deletedBy, person.id);
  assert.equal(copy.data.items.length, 1);
  await assert.rejects(svc.Deleted.deleteMany({}), (e) => e.code === "DELETED_RECORD_IMMUTABLE");
});

test("a customer or item with history cannot be deleted; an unused one can, and is kept whole", { skip }, async () => {
  const used = await svc.Customer.create({ customerId: "C-3", customerName: "Gulf Mart", billingAddress: "Dubai" });
  await sale(used);
  await assert.rejects(svc.Customers.deleteCustomer(used._id), (e) => e.code === "PARTY_IN_USE" && /Gulf Mart cannot be deleted: it is on 1 invoice or return/.test(e.message));
  await assert.rejects(svc.StockService.deleteStock(stock._id), (e) => e.code === "ITEM_IN_USE");

  const unused = await svc.Customers.createCustomer({ customerName: "Nobody Yet", contactPerson: "X", billingAddress: "Ajman" });
  await as(() => svc.Customers.deleteCustomer(unused._id));
  assert.equal(await svc.Customer.findById(unused._id), null);
  assert.equal((await svc.Deleted.findOne({ entity: "Customer", entityId: String(unused._id) }).lean()).data.customerName, "Nobody Yet");
  assert.equal((await rows("CUSTOMER_DELETED")).length, 1);
});

test("a deleted receipt leaves its statement rows and their mirror, not a gap", { skip }, async () => {
  const c = await svc.Customer.create({ customerId: "C-5", customerName: "Al Reef", billingAddress: "Dubai" });
  const invoice = await sale(c);
  const receipt = await svc.Financial.createVoucher({ voucherType: "receipt", paymentMode: "cash", customerId: c._id, totalAmount: 21, date: new Date(), linkedInvoices: [{ invoiceId: invoice._id, amount: 21, balance: 0 }] }, new mongoose.Types.ObjectId());
  const logs = await svc.CreditLog.find({ ref: receipt.voucherNo }).lean();
  assert.ok(logs.length >= 1);
  await svc.Financial.deleteVoucher(receipt._id, new mongoose.Types.ObjectId());
  assert.equal((await svc.CreditLog.find({ ref: receipt.voucherNo }).lean()).length, logs.length, "the rows are still there");
  const mirror = await svc.CreditLog.find({ ref: `REV-${receipt.voucherNo}` }).lean();
  assert.equal(mirror.length, logs.length);
  assert.equal(mirror[0].paid, -logs[0].paid);
  assert.equal(mirror[0].status, "REVERSED");
});
