// Manual quantity changes (a stock count, a correction, a movement typed on the Inventory page) are
// costed at the weighted average, take batches first-expiry-first-out, write one movement and, with
// posting on, book Inventory against Stock adjustment. Throwaway database (random name, dropped after).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const DAY = 86400000;

let svc;
let item;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Stock: require("../../models/modules/stockModel"),
    StockService: require("../stock/stockService"),
    Config: require("../financial/accountConfigService"),
    CompanySettings: require("../../models/modules/financial/companySettingsModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
    Batch: require("../../models/modules/stockBatchModel"),
    ...require("../../models/modules/financial/financialModels"),
    Fiscal: require("../../models/modules/financial/fiscalYearModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.CompanySettings.updateMany({}, { ledgerPostingEnabled: true, ledgerPostingTouched: true });
  item = await svc.Stock.create({ itemId: "MILK", sku: "MILK", itemName: "Milk", category: new mongoose.Types.ObjectId() });
});
test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const net = async (configKey) => {
  const accountId = await svc.Config.resolveAccount(configKey);
  const rows = await svc.LedgerEntry.aggregate([
    { $match: { accountId, isReversed: { $ne: true } } },
    { $group: { _id: null, dr: { $sum: "$debitAmount" }, cr: { $sum: "$creditAmount" } } },
  ]);
  return rows[0] ? Math.round((rows[0].dr - rows[0].cr) * 100) / 100 : 0;
};
const vouchers = () => svc.LedgerEntry.find({ voucherType: "stock_adjustment" }).sort({ createdAt: 1 }).lean();

test("a gain enters at the cost given: pool, movement and ledger agree", { skip }, async () => {
  const updated = await svc.StockService.updateStock(item._id, { currentStock: 10 }, "tester", { unitCost: 12, referenceNumber: "COUNT-1" });
  assert.equal(updated.currentStock, 10);
  assert.equal(updated.costValue, 120);
  assert.equal(updated.purchasePrice, 12);

  const { movement, number, cost, posted } = updated.$locals.adjustment;
  assert.match(number, /^SA-\d{4}-0001$/);
  assert.equal(cost, 120);
  assert.equal(posted, true);
  assert.equal(movement.referenceNumber, "COUNT-1", "the reference the user typed is kept on the movement");
  assert.equal(movement.costBasis, "adjustment");
  assert.equal(movement.rateAfter, 12);
  assert.equal(movement.poolQtyAfter, 10);
  assert.equal(await svc.Movement.countDocuments({ stockId: "MILK" }), 1, "one movement, not two");

  assert.equal(await net("inventory-asset"), 120, "Inventory is debited");
  assert.equal(await net("stock-adjustment"), -120, "Stock adjustment is credited");
  assert.equal((await vouchers()).length, 2);
});

test("a loss leaves at the average cost; the average does not move", { skip }, async () => {
  const updated = await svc.StockService.updateStock(item._id, { currentStock: 6 }, "tester");
  assert.equal(updated.currentStock, 6);
  assert.equal(updated.costValue, 72);
  assert.equal(updated.purchasePrice, 12);
  const { cost, number } = updated.$locals.adjustment;
  assert.equal(cost, 48);
  assert.match(number, /-0002$/, "numbers are issued in sequence, never reused");
  assert.equal(await net("inventory-asset"), 72);
  assert.equal(await net("stock-adjustment"), -72);
});

test("a gain with no cost given enters at the current average, so the average is unchanged", { skip }, async () => {
  const updated = await svc.StockService.updateStock(item._id, { currentStock: 8 }, "tester");
  assert.equal(updated.purchasePrice, 12);
  assert.equal(updated.costValue, 96);
  assert.equal(await net("inventory-asset"), 96);
});

test("a gain at a different cost re-averages the pool", { skip }, async () => {
  const updated = await svc.StockService.updateStock(item._id, { currentStock: 12 }, "tester", { unitCost: 14 });
  assert.equal(updated.costValue, 96 + 56);
  assert.equal(updated.purchasePrice, Math.round((152 / 12) * 1e5) / 1e5);
  assert.equal(await net("inventory-asset"), 152, "the ledger equals the cost pool");
});

test("an edit that leaves the quantity alone records nothing", { skip }, async () => {
  const before = await svc.Movement.countDocuments({ stockId: "MILK" });
  const entries = await svc.LedgerEntry.countDocuments({});
  const updated = await svc.StockService.updateStock(item._id, { itemName: "Fresh Milk", currentStock: 12 }, "tester");
  assert.equal(updated.itemName, "Fresh Milk");
  assert.equal(updated.$locals.adjustment, undefined);
  assert.equal(await svc.Movement.countDocuments({ stockId: "MILK" }), before);
  assert.equal(await svc.LedgerEntry.countDocuments({}), entries);
});

test("a decrease takes the batches first-expiry-first-out; a gain with a batch number creates the batch", { skip }, async () => {
  await svc.Batch.deleteMany({});
  const mk = (batchNumber, qty, days) => svc.Batch.create({
    companyId: require("../../utils/tenant").getTenant().companyId, stockId: item._id, itemCode: "MILK", batchNumber,
    expiryDate: new Date(Date.now() + days * DAY), receivedQty: qty, qtyOnHand: qty, unitCost: 12,
  });
  await mk("LATE", 6, 90);
  await mk("SOON", 6, 10);
  await svc.StockService.updateStock(item._id, { currentStock: 7 }, "tester"); // 12 -> 7: takes 5
  assert.equal((await svc.Batch.findOne({ batchNumber: "SOON" })).qtyOnHand, 1, "the earlier expiry goes first");
  assert.equal((await svc.Batch.findOne({ batchNumber: "LATE" })).qtyOnHand, 6);

  await svc.StockService.updateStock(item._id, { currentStock: 10 }, "tester", { batchNumber: "RECOUNT", expiryDate: new Date(Date.now() + 40 * DAY) });
  const added = await svc.Batch.findOne({ batchNumber: "RECOUNT" });
  assert.equal(added.qtyOnHand, 3);
  assert.equal(String(added.stockId), String(item._id));
});

test("with posting off the pool and movement still move, and nothing reaches the ledger", { skip }, async () => {
  await svc.CompanySettings.updateMany({}, { ledgerPostingEnabled: false });
  const entries = await svc.LedgerEntry.countDocuments({});
  const updated = await svc.StockService.updateStock(item._id, { currentStock: 9 }, "tester");
  assert.equal(updated.currentStock, 9);
  assert.equal(updated.$locals.adjustment.posted, false);
  assert.equal(await svc.LedgerEntry.countDocuments({}), entries);
  await svc.CompanySettings.updateMany({}, { ledgerPostingEnabled: true });
});

test("a closed period refuses the adjustment and leaves the stock untouched", { skip }, async () => {
  const now = new Date();
  await svc.Fiscal.deleteMany({});
  const companyId = require("../../utils/tenant").getTenant().companyId;
  await svc.Fiscal.create({
    companyId, code: "FY-OLD", startDate: new Date(now.getFullYear() - 1, 0, 1), endDate: new Date(now.getFullYear() - 1, 11, 31), status: "closed",
  });
  await svc.Fiscal.create({
    companyId, code: "FY-NOW", startDate: new Date(now.getFullYear(), 0, 1), endDate: new Date(now.getFullYear(), 11, 31), status: "closed",
  });
  const before = await svc.Stock.findById(item._id);
  await assert.rejects(() => svc.StockService.updateStock(item._id, { currentStock: 1 }, "tester"), { code: "PERIOD_CLOSED" });
  const after = await svc.Stock.findById(item._id);
  assert.equal(after.currentStock, before.currentStock);
  await svc.Fiscal.deleteMany({});
});
