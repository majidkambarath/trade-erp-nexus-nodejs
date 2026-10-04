// Batches, first-expiry-first-out, shelf life and write-offs. Pure rules first, then a throwaway
// database (random name, dropped afterwards).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const BatchService = require("../stock/batchService");

const DAY = 86400000;
const inDays = (n) => new Date(Date.now() + n * DAY);
const b = (id, qty, expiryDays, receivedDays = 0, extra = {}) => ({
  _id: id, qtyOnHand: qty, status: "active",
  expiryDate: expiryDays === null ? null : inDays(expiryDays), receivedAt: inDays(-receivedDays), ...extra,
});

test("FEFO: earliest expiry first, no-expiry last, ties by receipt date", () => {
  const order = BatchService.eligibleInOrder([
    b("none", 5, null), b("late", 5, 90), b("early", 5, 10), b("tieOld", 5, 30, 10), b("tieNew", 5, 30, 1),
  ]).map((x) => x._id);
  assert.deepEqual(order, ["early", "tieOld", "tieNew", "late", "none"]);
});

test("expired and too-short-shelf-life batches are not eligible", () => {
  const batches = [b("expired", 5, -1), b("short", 5, 10), b("ok", 5, 60)];
  assert.deepEqual(BatchService.eligibleInOrder(batches).map((x) => x._id), ["short", "ok"]);
  assert.deepEqual(BatchService.eligibleInOrder(batches, { minShelfLifeDays: 30 }).map((x) => x._id), ["ok"]);
  assert.deepEqual(
    BatchService.eligibleInOrder([b("empty", 0, 10), b("done", 5, 10, 0, { status: "depleted" })]).map((x) => x._id), []
  );
});

test("plan splits a quantity across batches and reports what no batch could cover", () => {
  const ordered = BatchService.eligibleInOrder([b("a", 50, 10), b("b", 100, 20)]);
  const p = BatchService.plan(ordered, 120);
  assert.deepEqual(p.takes.map((t) => [t.batch._id, t.qty]), [["a", 50], ["b", 70]]);
  assert.equal(p.unallocated, 0);
  assert.equal(BatchService.plan(ordered, 200).unallocated, 50);
});

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Tx: require("../orderPurchase/transactionService"),
    WriteOff: require("../stock/writeOffService"),
    Financial: require("../financial/financialService"),
    Batch: require("../../models/modules/stockBatchModel"),
    Stock: require("../../models/modules/stockModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    Transaction: require("../../models/modules/transactionModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
});
test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

let vendor, customer, stock;
const line = (qty, price, extra = {}) => ({ itemId: stock._id, description: "Milk", qty, price, rate: price, vatPercent: 0, ...extra });
const make = async (type, party, partyType, items, extra = {}) => {
  const t = await svc.Tx.createTransaction(
    { type, partyId: party._id, partyType, partyTypeRef: partyType, items, returnOf: extra.returnOf }, "tester");
  if (extra.approve !== false) await svc.Tx.processTransaction(t._id, "approve", "tester");
  return t;
};
const batches = async () => (await svc.Batch.find({ stockId: stock._id }).sort({ batchNumber: 1 }).lean());
const qtyOf = async (no) => (await svc.Batch.findOne({ stockId: stock._id, batchNumber: no })).qtyOnHand;

test("receiving creates a batch per line with its expiry", { skip }, async () => {
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Dairy", contactPerson: "x", address: "y" });
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Shop", contactPerson: "x" });
  stock = await svc.Stock.create({ itemId: "MLK", sku: "MLK", itemName: "Milk", category: new mongoose.Types.ObjectId() });

  await make("purchase_order", vendor, "Vendor", [line(100, 2, { batchNumber: "A", expiryDate: inDays(30) })]);
  await make("purchase_order", vendor, "Vendor", [line(50, 2, { batchNumber: "B", expiryDate: inDays(10) })]);
  await make("purchase_order", vendor, "Vendor", [line(40, 2, { batchNumber: "OLD", expiryDate: inDays(-2) })]);
  const all = await batches();
  assert.deepEqual(all.map((x) => [x.batchNumber, x.qtyOnHand]), [["A", 100], ["B", 50], ["OLD", 40]]);
});

test("a sale takes the soonest-expiring batch first and never touches an expired one", { skip }, async () => {
  const sale = await make("sales_order", customer, "Customer", [line(120, 3)]);
  assert.equal(await qtyOf("B"), 0);
  assert.equal(await qtyOf("A"), 30);
  assert.equal(await qtyOf("OLD"), 40, "expired stock is not sold");
  const saved = await svc.Transaction.findById(sale._id).lean();
  assert.deepEqual(saved.items[0].allocations.map((a) => [a.batchNumber, a.qty]), [["B", 50], ["A", 70]]);
  assert.equal((await svc.Batch.findOne({ batchNumber: "B" })).status, "depleted");
});

test("a linked return goes back into the batches it was sold from; deleting the sale restores them too", { skip }, async () => {
  const sale = await make("sales_order", customer, "Customer", [line(20, 3)]); // from A: 30 -> 10
  assert.equal(await qtyOf("A"), 10);
  const ret = await make("sales_return", customer, "Customer", [line(5, 3, { returnOfLineId: sale.items[0]._id })], { returnOf: { transactionId: sale._id } });
  assert.equal(await qtyOf("A"), 15);

  await svc.Tx.deleteTransaction(ret._id, "tester");
  assert.equal(await qtyOf("A"), 10);
  await svc.Tx.deleteTransaction(sale._id, "tester");
  assert.equal(await qtyOf("A"), 30);
});

test("a customer's minimum shelf life skips batches that expire too soon", { skip }, async () => {
  const picky = await svc.Customer.create({ customerId: "C2", customerName: "Picky", contactPerson: "x", minShelfLifeDays: 20 });
  // B is depleted and A (30 days) qualifies; add a short one to prove it is skipped
  await make("purchase_order", vendor, "Vendor", [line(10, 2, { batchNumber: "SHORT", expiryDate: inDays(5) })]);
  await make("sales_order", picky, "Customer", [line(10, 3)]);
  assert.equal(await qtyOf("SHORT"), 10, "5 days left < 20 required");
  assert.equal(await qtyOf("A"), 20);
});

test("a purchase whose goods were partly sold cannot be deleted", { skip }, async () => {
  const buy = await make("purchase_order", vendor, "Vendor", [line(10, 2, { batchNumber: "TMP", expiryDate: inDays(200) })]);
  await make("sales_order", customer, "Customer", [line(35, 3)]); // drains A (20) then SHORT (10)... and TMP (5)
  assert.ok((await qtyOf("TMP")) < 10);
  await assert.rejects(() => svc.Tx.deleteTransaction(buy._id, "tester"), { code: "BATCH_PARTLY_USED" });
});

test("write-off: stock leaves at average cost, the ledger books the loss, and it stays balanced", { skip }, async () => {
  const old = await svc.Batch.findOne({ batchNumber: "OLD" });
  await assert.rejects(() => svc.WriteOff.writeOff({ batchId: old._id, qty: 999, reason: "expiry" }), { code: "EXCEEDS_BATCH_QTY" });
  await assert.rejects(() => svc.WriteOff.writeOff({ batchId: old._id, qty: 5, reason: "theft" }), { code: "INVALID_REASON" });

  const before = await svc.Stock.findById(stock._id);
  const r = await svc.WriteOff.writeOff({ batchId: old._id, qty: 40, reason: "expiry", note: "past date" });
  assert.match(r.number, /^WO-\d{4}-0001$/);
  assert.equal(r.cost, Math.round(40 * before.purchasePrice * 100) / 100);
  assert.equal(r.posted, true);

  const after = await svc.Stock.findById(stock._id);
  assert.equal(after.currentStock, before.currentStock - 40);
  assert.equal(after.purchasePrice, before.purchasePrice, "writing off at the average leaves the average unchanged");
  const reloaded = await svc.Batch.findById(old._id);
  assert.equal(reloaded.qtyOnHand, 0);
  assert.equal(reloaded.status, "written_off");

  const tb = await svc.Financial.getTrialBalance(undefined, "2099-01-01");
  assert.equal(tb.summary.isBalanced, true);
  assert.equal(tb.trialBalance.find((x) => x.accountName === "Stock Write-off - Expiry").balance, r.cost);
});
