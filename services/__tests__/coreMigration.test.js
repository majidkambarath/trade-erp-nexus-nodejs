// The collections written before organisations existed are converted in place: every row is assigned to the
// original organisation, and the old GLOBAL unique indexes (one transactionNo in the whole database) are
// replaced by per-organisation ones. This builds a database the way an older version left it, with rows that
// name no organisation and the old unique indexes, and proves the migration converts it and is safe to repeat.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let M;

(function load(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) load(p);
    else if (p.endsWith(".js")) require(path.resolve(p));
  }
})(path.resolve(__dirname, "..", "..", "models"));

const names = async (model) => (await model.collection.indexes()).map((i) => i.name);
const indexNamed = async (model, name) => (await model.collection.indexes()).find((i) => i.name === name);

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  M = { T: mongoose.models.Transaction, C: mongoose.models.Customer, S: mongoose.models.Stock, IM: mongoose.models.InventoryMovement, mig: require("../../utils/migrations") };
  // an older version's database: no per-organisation indexes, the old global unique ones instead
  for (const model of [M.T, M.C, M.S, M.IM]) { await model.init(); await model.collection.dropIndexes(); }
  await M.T.collection.createIndex({ transactionNo: 1 }, { unique: true });
  await M.C.collection.createIndex({ customerId: 1 }, { unique: true });
  await M.S.collection.createIndex({ itemId: 1 }, { unique: true });
  await M.T.collection.insertMany([{ transactionNo: "INV-2026-0001", type: "sales_order", status: "APPROVED", totalAmount: 100 }, { transactionNo: "INV-2026-0002", type: "sales_order", status: "APPROVED", totalAmount: 50 }]);
  await M.C.collection.insertOne({ customerId: "CUST2026001", customerName: "Old Customer" });
  await M.S.collection.insertOne({ itemId: "ITEM1", sku: "SKU1", itemName: "Rice" });
  await M.IM.collection.insertMany([{ stockId: new mongoose.Types.ObjectId(), companyId: null, branchId: null }, { stockId: new mongoose.Types.ObjectId() }]);
});
test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("before: the old global unique index stops a second organisation using the same number", { skip }, async () => {
  assert.ok((await names(M.T)).includes("transactionNo_1"));
  await assert.rejects(() => M.T.collection.insertOne({ transactionNo: "INV-2026-0001", companyId: "other-org" }), (e) => e.code === 11000, "this is the problem being solved");
});

test("the migration assigns every old row to the original organisation, and the head office to documents", { skip }, async () => {
  const done = await M.mig.assignCoreToOriginalOrganisation();
  assert.equal(done.Transaction.companyId, 2);
  assert.equal(done.Transaction.branchId, 2);
  assert.equal(done.Customer.companyId, 1);
  assert.equal(done.Stock.companyId, 1);
  const rows = await M.T.collection.find().toArray();
  assert.ok(rows.every((r) => r.companyId === "default" && r.branchId === "main"), "every transaction names the original organisation and the head office");
  assert.equal((await M.C.collection.findOne({ customerId: "CUST2026001" })).companyId, "default");
  const movements = await M.IM.collection.find().toArray();
  assert.ok(movements.every((m) => m.companyId === "default" && m.branchId === "main"), "movements with a null or missing organisation were assigned too");
});

test("the old global unique indexes are gone and per-organisation ones took their place", { skip }, async () => {
  const t = await names(M.T);
  assert.ok(!t.includes("transactionNo_1"), "the global one is dropped");
  const scoped = await indexNamed(M.T, "companyId_1_transactionNo_1");
  assert.ok(scoped && scoped.unique, "the per-organisation unique one exists");
  assert.ok(!(await names(M.C)).includes("customerId_1"));
  assert.ok((await indexNamed(M.C, "companyId_1_customerId_1")).unique);
  assert.ok(!(await names(M.S)).includes("itemId_1"));
  assert.ok((await indexNamed(M.S, "companyId_1_itemId_1")).unique);
});

test("after: another organisation can use the same number, and one organisation still cannot repeat its own", { skip }, async () => {
  await M.T.collection.insertOne({ transactionNo: "INV-2026-0001", companyId: "other-org", branchId: "main" });
  await M.S.collection.insertOne({ itemId: "ITEM1", sku: "SKU1", companyId: "other-org" });
  await assert.rejects(() => M.T.collection.insertOne({ transactionNo: "INV-2026-0001", companyId: "default", branchId: "main" }), (e) => e.code === 11000, "no duplicates inside one organisation");
  await assert.rejects(() => M.S.collection.insertOne({ itemId: "ITEM1", sku: "SKU-X", companyId: "default" }), (e) => e.code === 11000);
});

test("running it again changes nothing", { skip }, async () => {
  const before = JSON.stringify(await names(M.T));
  const again = await M.mig.assignCoreToOriginalOrganisation();
  assert.deepEqual(again, {}, "nothing left to assign");
  assert.equal(JSON.stringify(await names(M.T)), before, "and no index churn");
});
