// Expired and damaged goods brought back on a van, against a throwaway database: each is written off to its own loss
// account when the trip is settled, the expired batch is the one that leaves the books (not a fresh one), a count
// difference still goes to Stock Adjustment, the stock value still agrees with the ledger, and the unit cost kept for
// the loss reports never reaches a van screen.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vex_${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  const fin = require("../../models/modules/financial/financialModels");
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Org: require("../core/organisationService"),
    Tx: require("../orderPurchase/transactionService"),
    StockService: require("../stock/stockService"),
    Reports: require("../reports/stockReportsService"),
    Van: require("../vansales/vanService"),
    Trip: require("../vansales/vanTripService"),
    Sales: require("../vansales/vanTripSales"),
    Settle: require("../vansales/vanTripSettlement"),
    Config: require("../financial/accountConfigService"),
    Chart: require("../financial/defaultChartService"),
    LedgerEntry: fin.LedgerEntry,
    Batch: require("../../models/modules/stockBatchModel"),
    Stock: require("../../models/modules/stockModel"),
    VanTrip: require("../../models/modules/vansales/vanTripModel"),
    Customer: require("../../models/modules/customerModel"),
    Category: require("../../models/modules/categoryModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Admin: require("../../models/core/adminModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Chart.provision();
  await svc.Org.ensureDefault();
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const orgDay = (n = 0) => {
  const today = require("../../utils/documentExpiry").todayInOrg();
  return new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
};
const batches = async (stockId) => Object.fromEntries((await svc.Batch.find({ stockId }).lean()).map((b) => [b.batchNumber, b.qtyOnHand]));
const posted = async (key, voucherType) => {
  const accountId = await svc.Config.resolveAccount(key);
  const rows = await svc.LedgerEntry.find({ accountId, voucherType, isReversed: { $ne: true } }).lean();
  return r2(rows.reduce((t, e) => t + e.debitAmount - e.creditAmount, 0));
};

let salesman, shop, milk, trip, sale;
const by = () => String(salesman._id);

test("setup: milk in an old batch and a fresh one, sold from the old one, brought back expired and damaged", { skip }, async () => {
  salesman = await svc.Admin.create({ name: "Rashid", email: `rashid-ex.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Dairy Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  shop = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", shippingAddress: "Dubai", paymentTerms: "Net 30" });
  const cat = await svc.Category.create({ name: "Dairy" });
  milk = await svc.StockService.createStock({ categoryId: cat._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku: "MILK", itemName: "Milk 1L", salesPrice: 15 }, "tester");
  const po = await svc.Tx.createTransaction({
    type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor",
    items: [
      { itemId: milk._id, description: "Milk 1L", qty: 10, price: 10, vatPercent: 0, batchNumber: "OLD", expiryDate: orgDay(0) },
      { itemId: milk._id, description: "Milk 1L", qty: 40, price: 10, vatPercent: 0, batchNumber: "FRESH", expiryDate: orgDay(200) },
    ],
  }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");
  const van = await svc.Van.create({ code: "VAN-1", name: "Van One", salesmanId: by() }, "tester");
  trip = await svc.Trip.open({ vanId: van._id }, "tester");
  await svc.Trip.load(trip._id, { lines: [{ stockId: String(milk._id), qty: 20 }] }, "tester");
  await svc.Trip.depart(trip._id, "tester");
  sale = (await svc.Sales.sell(trip._id, { customerId: shop._id, items: [{ itemId: milk._id, qty: 8, vatPercent: 0 }] }, by())).invoice;
  assert.deepEqual(await batches(milk._id), { OLD: 2, FRESH: 40 }, "sold first-expiry-first-out");
  // time passes: the old batch is now past its date
  await svc.Batch.updateOne({ batchNumber: "OLD" }, { expiryDate: new Date(`${day(-2)}T00:00:00.000Z`) });
  await svc.Sales.returnItems(trip._id, { customerId: shop._id, lines: [{ stockId: String(milk._id), qty: 3, condition: "expired" }, { stockId: String(milk._id), qty: 1, condition: "damaged" }], reason: "Expired" }, by());
  assert.deepEqual(await batches(milk._id), { OLD: 6, FRESH: 40 }, "the return goes back into the batch it came from");
  const t = await svc.Trip.getById(trip._id);
  assert.deepEqual([t.sellable.map((l) => l.qty), t.damaged.map((l) => l.qty), t.expired.map((l) => [l.itemName, l.qty])], [[12], [1], [["Milk 1L", 3]]]);
});

test("counted in and settled: expired and damaged to their own accounts, the expired batch reduced, a shortage still a difference", { skip }, async () => {
  await svc.Settle.unload(trip._id, { counts: [{ stockId: String(milk._id), good: 11, damaged: 1, expired: 3 }] }, "tester");
  const plan = await svc.Settle.preview(trip._id, {});
  assert.deepEqual([plan.expiredValue, plan.damagedValue, plan.stockVarianceValue], [30, 10, -10]);
  assert.deepEqual([plan.rows[0].expectedExpired, plan.rows[0].countedExpired], [3, 3]);
  const { trip: settled } = await svc.Settle.settle(trip._id, { cashHanded: 0, acknowledge: plan.warnings.map((w) => w.code) }, "tester");
  assert.equal(settled.settlement.expiredValue, 30);

  assert.deepEqual(await batches(milk._id), { OLD: 2, FRESH: 39 }, "the expired and damaged units left the old batch; the missing one a fresh one");
  assert.equal((await svc.Stock.findById(milk._id).lean()).currentStock, 41);
  assert.equal(await posted("write-off-expiry", "stock_writeoff"), 30);
  assert.equal(await posted("damage-loss", "stock_writeoff"), 10);
  assert.equal(await posted("stock-adjustment", "stock_adjustment"), 10);
  const check = await svc.Reports.ledgerCheck();
  assert.equal(check.reconciles, true, JSON.stringify(check.lines));
});

test("the unit cost is kept for the loss reports and never sent to a van screen", { skip }, async () => {
  const stored = await svc.VanTrip.findById(trip._id).lean();
  assert.equal(stored.unload.lines[0].unitCost, 10);
  const shown = await svc.Trip.getById(trip._id);
  assert.equal("unitCost" in shown.unload.lines[0], false);
  const [listed] = await svc.Trip.list({});
  assert.equal("unitCost" in listed.unload.lines[0], false);
  assert.equal(sale.status, "APPROVED");
});

test("with nothing named, a write-off of expired stock still takes the expired batch first; damage keeps to usable stock", { skip }, () => {
  const BatchService = require("../stock/batchService");
  const b = (id, qtyOnHand, expiry) => ({ _id: id, batchNumber: id, qtyOnHand, status: "active", expiryDate: expiry ? new Date(`${expiry}T00:00:00.000Z`) : null, receivedAt: new Date(0) });
  const all = [b("fresh", 5, day(100)), b("old", 2, day(-5)), b("open", 4, null)];
  const took = (r) => r.takes.map((t) => [t.batch._id, t.qty]);
  assert.deepEqual(took(BatchService.preferred(all, 4, { includeExpired: true, orderDate: new Date() })), [["old", 2], ["fresh", 2]]);
  assert.deepEqual(took(BatchService.preferred(all, 4, { orderDate: new Date() })), [["fresh", 4]]);
  // a named batch first, up to what was named, even when expired; the rest in the usual order
  assert.deepEqual(took(BatchService.preferred(all, 4, { prefer: [{ batchId: "old", qty: 1 }], orderDate: new Date() })), [["old", 1], ["fresh", 3]]);
  assert.deepEqual(took(BatchService.preferred(all, 9, { prefer: [{ batchId: "open", qty: 9 }], includeExpired: true })), [["open", 4], ["old", 2], ["fresh", 3]]);
  const short = BatchService.preferred(all, 20, { includeExpired: true });
  assert.equal(short.unallocated, 9);
});
