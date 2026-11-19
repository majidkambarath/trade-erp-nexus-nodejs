// The invoice lists are read one filtered, sorted page at a time, with the cards counted by the server.
//   node --require ./utils/testSetup.js --test services/__tests__/serverLists.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let svc, rice, cust, admin;
const docs = {};

function line(qty, price) {
  return { itemId: rice._id, description: rice.itemName, qty, price, rate: price, vatPercent: 5 };
}

test.before(async () => {
  if (skip) return;
  process.env.LOG_SILENT = "1";
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Tx: require("../orderPurchase/transactionService"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    Admin: require("../../models/core/adminModel"),
  };
  require("../../models/modules/uomModel");
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  admin = await new svc.Admin({ name: "Zainab Clerk", email: "zc@test.uae", password: "12312312", type: "super_admin", status: "active", isActive: true }).save();
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Vend", contactPerson: "x", address: "y" });
  const mk = (id, name) => svc.Customer.create({ customerId: id, customerName: name, contactPerson: "c", email: `${id}@x.ae`, billingAddress: "Dubai" });
  cust = { a: await mk("C1", "Alpha Foods"), b: await mk("C2", "Bravo Trading"), c: await mk("C3", "Charlie Stores") };
  await svc.Customer.updateOne({ _id: cust.a._id }, { $set: { paymentTerms: "Net 30" } });
  rice = await svc.Stock.create({ itemId: "ITM1", sku: "SKU1", itemName: "Basmati Rice", category: new mongoose.Types.ObjectId(), purchasePrice: 7 });
  const buy = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [line(900, 10)] }, "t");
  await svc.Tx.processTransaction(buy._id, "approve", "t");
  const sale = async (key, c, qty, date, by = "t", extra = {}) => {
    const d = await svc.Tx.createTransaction({ type: "sales_order", partyId: c._id, partyType: "Customer", partyTypeRef: "Customer", date, items: [line(qty, 20)], ...extra }, by);
    docs[key] = d._id;
    return d;
  };
  await sale("a", cust.a, 10, "2026-01-05", String(admin._id), { lpono: "LPO-777" }); // 210
  await sale("b", cust.b, 30, "2026-01-10"); // 630
  await sale("c", cust.c, 20, "2026-01-15"); // 420
  await sale("d", cust.a, 5, "2026-01-20"); // 105, stays a draft
  for (const k of ["a", "b", "c"]) await svc.Tx.processTransaction(docs[k], "approve", "t");
  await svc.Transaction.updateOne({ _id: docs.b }, { $set: { paidAmount: 200, outstandingAmount: 430 } });
  await svc.Transaction.updateOne({ _id: docs.c }, { $set: { paidAmount: 420, outstandingAmount: 0 } });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const list = (f = {}) => svc.Tx.getAllTransactions({ type: "sales_order", ...f });
const amounts = (r) => r.transactions.map((t) => t.totalAmount);

test("sorting by number, amount, date, status and party, both ways, with a stable page boundary", { skip }, async () => {
  assert.deepEqual(amounts(await list({ sort: "amount", order: "asc" })), [105, 210, 420, 630]);
  assert.deepEqual(amounts(await list({ sort: "amount", order: "desc" })), [630, 420, 210, 105]);
  assert.deepEqual(amounts(await list({ sort: "date", order: "desc" })), [105, 420, 630, 210]);
  const byParty = await list({ sort: "party", order: "asc" });
  assert.deepEqual(byParty.transactions.map((t) => t.partyName), ["Alpha Foods", "Alpha Foods", "Bravo Trading", "Charlie Stores"]);
  assert.equal((await list({ sort: "party", order: "desc" })).transactions[0].partyName, "Charlie Stores");
  const seen = [];
  for (let page = 1; page <= 4; page += 1) seen.push(...(await list({ sort: "party", order: "asc", limit: 1, page })).transactions.map((t) => t.transactionNo));
  assert.equal(new Set(seen).size, 4, "pages of one walk every document exactly once");
  const p2 = await list({ sort: "amount", order: "asc", limit: 2, page: 2 });
  assert.deepEqual(amounts(p2), [420, 630]);
  assert.equal(p2.pagination.total, 4);
  const byNo = (await list({ sort: "number", order: "asc" })).transactions.map((t) => t.transactionNo);
  assert.deepEqual(byNo, [...byNo].sort());
  assert.equal((await list({ sort: "status", order: "asc" })).transactions[0].status, "APPROVED");
});

test("the payment filter reads the amounts: paid, part paid, unpaid and overdue by the party terms", { skip }, async () => {
  assert.deepEqual(amounts(await list({ payment: "PAID" })), [420]);
  assert.deepEqual(amounts(await list({ payment: "PARTIAL" })), [630]);
  assert.deepEqual(amounts(await list({ payment: "UNPAID" })), [210], "a draft is never unpaid");
  const overdue = await list({ payment: "OVERDUE" });
  assert.deepEqual(amounts(overdue).sort((x, y) => x - y), [210, 630]);
  assert.equal(overdue.pagination.total, 2);
  assert.deepEqual(amounts(await list({ payment: "overdue", partyId: String(cust.b._id) })), [630]);
  await assert.rejects(() => list({ payment: "SOON" }), { code: "INVALID_FILTER" });
  await assert.rejects(() => list({ sort: "cost" }), { code: "INVALID_FILTER" });
  await assert.rejects(() => list({ sort: "date", order: "sideways" }), { code: "INVALID_FILTER" });
});

test("search finds a document by its LPO reference and by the name of the person who prepared it", { skip }, async () => {
  assert.deepEqual(amounts(await list({ search: "LPO-777" })), [210]);
  assert.deepEqual(amounts(await list({ search: "zainab" })), [210]);
  assert.equal((await list({ search: "nothing like this" })).pagination.total, 0);
});

test("the period is exact on the document date", { skip }, async () => {
  const mid = await list({ dateFilter: "CUSTOM", startDate: "2026-01-10", endDate: "2026-01-15" });
  assert.deepEqual(amounts(mid).sort((x, y) => x - y), [420, 630]);
});

test("the summary counts every document the filters leave, as the pages cards did", { skip }, async () => {
  const s = await svc.Tx.summary({ type: "sales_order" });
  assert.equal(s.count, 4);
  assert.equal(s.draft, 1);
  assert.equal(s.confirmed, 3);
  assert.equal(s.invoiced, 3);
  assert.equal(s.totalValue, 1365);
  assert.equal(s.invoicedValue, 1260);
  assert.deepEqual([s.paid, s.partial, s.unpaid], [1, 1, 1]);
  assert.equal(s.open, 640);
  assert.equal(s.overdue, 2);
  assert.equal(s.overdueValue, 640);
  const some = await svc.Tx.summary({ type: "sales_order", partyId: String(cust.a._id) });
  assert.equal(some.count, 2);
  assert.equal(some.totalValue, 315);
  assert.equal((await svc.Tx.summary({ type: "sales_order", payment: "PAID" })).count, 1);
  assert.equal((await svc.Tx.summary({ type: "purchase_order" })).count, 1);
});
