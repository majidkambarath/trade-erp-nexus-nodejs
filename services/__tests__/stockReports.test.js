// Stock reports: valuation, movement, item ledger, sales / purchase analysis, expiry, slow stock and
// reorder, read from InventoryMovement / Stock / StockBatch / Transaction and reconciled to the
// Inventory account of the ledger. Throwaway database; see ledgerReports.test.js.
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
const DAY = 86400000;

const inDays = (n) => new Date(Date.now() + n * DAY);
const ago = (n) => new Date(Date.now() - n * DAY);
// Dubai calendar day, the way the reports read dates
const orgDay = (offset = 0) => new Date(Date.now() + 4 * 3600e3 + offset * DAY).toISOString().slice(0, 10);
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const dubaiDayOf = (d) => new Date(new Date(d).getTime() + 4 * 3600e3).toISOString().slice(0, 10);

let svc;
let vendorA, vendorB, customerA, customerB;
let rice, oil, grains, oils;
let docs = {};

// The story, oldest first (the costing is a weighted average, so the order matters):
//   -60d  buy 100 rice @10 (batch R1, expires in 200d) and 50 oil @20 (batch O1, expires in 25d)   vendor A
//   -45d  buy 100 rice @14 (batch R2, expires in 120d)                                              vendor B
//   -30d  sell 60 rice @18 and 10 oil @30                                                           customer A
//   -20d  customer A returns 10 rice                                                                (restored at the 12.00 it cost)
//   -15d  return 20 rice @14 to vendor B
//   -10d  buy 20 oil @22 (batch O-OLD, already expired)                                             vendor A
//    -5d  sell 20 rice @19                                                                          customer B
//     0d  write off 15 of the expired oil
// Rice: 100 @10 + 100 @14 -> 200 / 2400 (avg 12) ... sold 60 (720) ... closes 110 / 1286.15.
// Oil: 50 / 1000, sold 10 (200), +20 / 440 -> 60 / 1240 (avg 20.66667), write-off 15 (310) -> 45 / 930.
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Financial: require("../financial/financialService"),
    Tx: require("../orderPurchase/transactionService"),
    Config: require("../financial/accountConfigService"),
    CompanySettings: require("../../models/modules/financial/companySettingsModel"),
    WriteOff: require("../stock/writeOffService"),
    StockService: require("../stock/stockService"),
    Reports: require("../reports/stockReportsService"),
    ...require("../../models/modules/financial/financialModels"),
    FiscalYear: require("../../models/modules/financial/fiscalYearModel"),
    Stock: require("../../models/modules/stockModel"),
    Category: require("../../models/modules/categoryModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
    Batch: require("../../models/modules/stockBatchModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Admin: require("../../models/core/adminModel"),
    tenant: require("../../utils/tenant"),
  };
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault(); // an account must belong to an organisation that exists, as the server arranges at start-up

  // one fiscal year spanning last year and this one, so back-dated documents are never refused
  const year = Number(orgDay().slice(0, 4));
  await svc.FiscalYear.create({
    companyId: svc.tenant.getTenant().companyId, code: "TEST", status: "open",
    startDate: new Date(Date.UTC(year - 1, 0, 1) - 4 * 3600e3), endDate: new Date(Date.UTC(year + 1, 0, 1) - 4 * 3600e3 - 1),
  });
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);

  [grains, oils] = await svc.Category.create([{ name: "Grains" }, { name: "Oils" }]);
  vendorA = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mills", contactPerson: "x", address: "y" });
  vendorB = await svc.Vendor.create({ vendorId: "V2", vendorName: "Delta Foods", contactPerson: "x", address: "y" });
  customerA = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x" });
  customerB = await svc.Customer.create({ customerId: "C2", customerName: "Bin Zayed", contactPerson: "x" });
  rice = await svc.Stock.create({ itemId: "RICE", sku: "RICE-5KG", itemName: "Basmati Rice", category: grains._id, reorderLevel: 150 });
  oil = await svc.Stock.create({ itemId: "OIL", sku: "OIL-1L", itemName: "Sunflower Oil", category: oils._id, reorderLevel: 20 });

  docs.p1 = await make("purchase_order", vendorA, "Vendor", [line(rice, 100, 10, { batchNumber: "R1", expiryDate: inDays(200) }), line(oil, 50, 20, { batchNumber: "O1", expiryDate: inDays(25) })], { date: ago(60) });
  docs.p2 = await make("purchase_order", vendorB, "Vendor", [line(rice, 100, 14, { batchNumber: "R2", expiryDate: inDays(120) })], { date: ago(45) });
  docs.s1 = await make("sales_order", customerA, "Customer", [line(rice, 60, 18), line(oil, 10, 30)], { date: ago(30) });
  docs.sr = await make("sales_return", customerA, "Customer", [line(rice, 10, 18, { returnOfLineId: docs.s1.items[0]._id })], { date: ago(20), returnOf: { transactionId: docs.s1._id } });
  docs.pr = await make("purchase_return", vendorB, "Vendor", [line(rice, 20, 14, { returnOfLineId: docs.p2.items[0]._id })], { date: ago(15), returnOf: { transactionId: docs.p2._id } });
  docs.p3 = await make("purchase_order", vendorA, "Vendor", [line(oil, 20, 22, { batchNumber: "O-OLD", expiryDate: inDays(-3) })], { date: ago(10) });
  docs.s2 = await make("sales_order", customerB, "Customer", [line(rice, 20, 19)], { date: ago(5) });
  const old = await svc.Batch.findOne({ batchNumber: "O-OLD" });
  docs.writeOff = await svc.WriteOff.writeOff({ batchId: old._id, qty: 15, reason: "expiry", note: "past date" }, { adminId: admin });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const line = (stock, qty, price, extra = {}) => ({ itemId: stock._id, description: stock.itemName, qty, price, rate: price, vatPercent: 5, ...extra });
async function make(type, party, partyType, items, extra = {}) {
  const t = await svc.Tx.createTransaction(
    { type, partyId: party._id, partyType, partyTypeRef: partyType, items, date: extra.date, returnOf: extra.returnOf }, "tester");
  await svc.Tx.processTransaction(t._id, "approve", "tester");
  return t;
}
const row = (report, itemId) => report.rows.find((r) => r.itemId === itemId);

// What the ledger holds on the Inventory account, read two independent ways
async function inventoryAccount() {
  const id = await svc.Config.resolveAccount("inventory-asset");
  return svc.LedgerAccount.findById(id).lean();
}
async function ledgerBalance(upToDay) {
  const id = await svc.Config.resolveAccount("inventory-asset");
  const [r] = await svc.LedgerEntry.aggregate([
    { $match: { accountId: id, isReversed: { $ne: true }, date: { $lte: new Date(`${upToDay}T23:59:59.999+04:00`) } } },
    { $group: { _id: null, net: { $sum: { $subtract: ["$debitAmount", "$creditAmount"] } } } },
  ]);
  return r2(r?.net || 0);
}

// ---------------------------------------------------------------- 1. valuation

test("valuation today: quantity, average cost and value per item agree with the item master and the ledger", { skip }, async () => {
  const v = await svc.Reports.valuation({ asOn: orgDay() });
  assert.deepEqual(v.rows.map((r) => r.itemId), ["RICE", "OIL"], "by item name");
  const ri = row(v, "RICE");
  const oi = row(v, "OIL");
  assert.deepEqual([ri.qty, ri.value, ri.avgCost, ri.categoryName], [110, 1286.15, 11.69231, "Grains"]);
  assert.deepEqual([oi.qty, oi.value, oi.avgCost, oi.categoryName], [45, 930, 20.66667, "Oils"]);
  assert.ok(Math.abs(ri.qty * ri.avgCost - ri.value) < 0.01, "quantity x average is the value, to a rounding fraction");
  assert.equal(v.totals.items, 2);
  assert.equal(v.totals.value, 2216.15);
  assert.equal(r2(ri.sharePct + oi.sharePct), 100, "shares add up");
  assert.equal(ri.outOfSync, undefined, "movements and the item master agree");

  // the item master holds the same running figures
  const master = await svc.Stock.findOne({ itemId: "RICE" });
  assert.deepEqual([master.currentStock, master.costValue], [ri.qty, ri.value]);
  assert.equal((await svc.Stock.findOne({ itemId: "OIL" })).costValue, oi.value);

  // the ledger, from the entries and from the trial balance
  const rec = v.reconciliation;
  assert.equal(rec.available, true);
  assert.equal(rec.postingEnabled, true);
  assert.equal(rec.stockValue, 2216.15);
  assert.equal(rec.ledgerBalance, 2216.15);
  assert.equal(rec.difference, 0);
  assert.equal(rec.reconciles, true);
  assert.equal(rec.unexplained, 0);
  assert.ok(rec.lines.every((l) => l.difference === 0), "every source agrees with its postings");
  assert.deepEqual(rec.lines.map((l) => l.key), ["purchases", "purchaseReturns", "sales", "salesReturns", "writeOffs"]);
  assert.equal(await ledgerBalance(orgDay()), 2216.15);
  const inv = await inventoryAccount();
  assert.equal(rec.account.name, inv.accountName);
  const tb = await svc.Financial.getTrialBalance(undefined, "2099-01-01");
  assert.equal(tb.trialBalance.find((x) => x.accountName === inv.accountName).balance, 2216.15);
});

test("valuation as on an earlier date counts only what had happened by then, and still reconciles", { skip }, async () => {
  // 25 days ago: both purchases and the first sale are in; the return, purchase return, oil purchase and sale B are not
  const mid = await svc.Reports.valuation({ asOn: orgDay(-25) });
  assert.deepEqual([row(mid, "RICE").qty, row(mid, "RICE").value], [140, 1680]);
  assert.deepEqual([row(mid, "OIL").qty, row(mid, "OIL").value], [40, 800]);
  assert.equal(mid.reconciliation.stockValue, 2480);
  assert.equal(mid.reconciliation.ledgerBalance, 2480);
  assert.equal(mid.reconciliation.reconciles, true);

  // 50 days ago: only the first purchase
  const early = await svc.Reports.valuation({ asOn: orgDay(-50) });
  assert.deepEqual([row(early, "RICE").qty, row(early, "RICE").value, row(early, "RICE").avgCost], [100, 1000, 10]);
  assert.deepEqual([row(early, "OIL").qty, row(early, "OIL").value], [50, 1000]);
  assert.equal(early.reconciliation.reconciles, true);

  // before anything happened there is nothing, on both sides
  const none = await svc.Reports.valuation({ asOn: orgDay(-70) });
  assert.deepEqual(none.rows, []);
  assert.equal(none.totals.value, 0);
  assert.equal(none.reconciliation.ledgerBalance, 0);
  assert.equal(none.reconciliation.reconciles, true);

  // a date is a Dubai day: documents dated that day are included
  const sameDay = await svc.Reports.valuation({ asOn: orgDay(-30) });
  assert.equal(row(sameDay, "RICE").qty, 140);
});

test("valuation by category, with the category / search filters narrowing the rows but never the ledger check", { skip }, async () => {
  const byCat = await svc.Reports.valuation({ groupBy: "category" });
  assert.deepEqual(byCat.rows.map((r) => [r.categoryName, r.items, r.value]), [["Grains", 1, 1286.15], ["Oils", 1, 930]]);
  assert.equal(byCat.rows.reduce((t, r) => t + r.value, 0), byCat.totals.value);

  const oilsOnly = await svc.Reports.valuation({ categoryId: String(oils._id) });
  assert.deepEqual(oilsOnly.rows.map((r) => r.itemId), ["OIL"]);
  assert.equal(oilsOnly.totals.value, 930);
  assert.equal(oilsOnly.reconciliation.filtered, true);
  assert.equal(oilsOnly.reconciliation.stockValue, 2216.15, "the ledger check always covers every item");
  assert.equal(oilsOnly.reconciliation.reconciles, true);

  assert.deepEqual((await svc.Reports.valuation({ search: "rice" })).rows.map((r) => r.itemId), ["RICE"]);
  assert.deepEqual((await svc.Reports.valuation({ search: "OIL-1L" })).rows.map((r) => r.itemId), ["OIL"]);
  assert.deepEqual((await svc.Reports.valuation({ search: "nothing like this" })).rows, []);
});

// ---------------------------------------------------------------- 2. movement

test("movement: opening + in - out = closing, for quantity and for value, item by item and in total", { skip }, async () => {
  const m = await svc.Reports.movement({ from: orgDay(-35), to: orgDay(-6) });
  const ri = row(m, "RICE");
  const oi = row(m, "OIL");
  assert.deepEqual(ri.opening, { qty: 200, value: 2400 });
  assert.deepEqual(ri.salesReturns, { qty: 10, value: 120 });
  assert.deepEqual(ri.purchaseReturns, { qty: 20, value: 280 });
  assert.deepEqual(ri.sales, { qty: 60, value: 720 });
  assert.deepEqual(ri.purchases, { qty: 0, value: 0 });
  assert.deepEqual(ri.closing, { qty: 130, value: 1520 });
  assert.deepEqual(oi.opening, { qty: 50, value: 1000 });
  assert.deepEqual(oi.purchases, { qty: 20, value: 440 });
  assert.deepEqual(oi.sales, { qty: 10, value: 200 });
  assert.deepEqual(oi.closing, { qty: 60, value: 1240 });
  assert.deepEqual(oi.writeOffs, { qty: 0, value: 0 }, "the write-off happens today, after the period");

  const identity = (x) => ({
    qty: x.opening.qty + x.purchases.qty + x.salesReturns.qty + x.adjustments.qty - x.purchaseReturns.qty - x.sales.qty - x.writeOffs.qty,
    value: r2(x.opening.value + x.purchases.value + x.salesReturns.value + x.adjustments.value - x.purchaseReturns.value - x.sales.value - x.writeOffs.value),
  });
  for (const x of [...m.rows, m.totals]) assert.deepEqual(identity(x), x.closing);
  assert.deepEqual(m.totals.opening, { qty: 250, value: 3400 });
  assert.deepEqual(m.totals.closing, { qty: 190, value: 2760 });

  // the closing value is the valuation on the last day, and the ledger agrees
  const val = await svc.Reports.valuation({ asOn: orgDay(-6) });
  assert.equal(val.totals.value, m.totals.closing.value);
  assert.equal(m.reconciliation.stockValue, 2760);
  assert.equal(m.reconciliation.ledgerBalance, 2760);
  assert.equal(m.reconciliation.reconciles, true);
});

test("movement up to today shows the write-off, and an opening balance carries the earlier history", { skip }, async () => {
  const m = await svc.Reports.movement({ from: orgDay(-6), to: orgDay() });
  const oi = row(m, "OIL");
  assert.deepEqual(oi.opening, { qty: 60, value: 1240 });
  assert.deepEqual(oi.writeOffs, { qty: 15, value: 310 });
  assert.deepEqual(oi.closing, { qty: 45, value: 930 });
  assert.deepEqual(row(m, "RICE").sales, { qty: 20, value: 233.85 });
  assert.equal(m.totals.closing.value, 2216.15);
  assert.equal(m.reconciliation.reconciles, true);

  // an item with nothing in the period but stock on hand still shows its opening and closing
  const later = await svc.Reports.movement({ from: orgDay(-2), to: orgDay() });
  assert.deepEqual(row(later, "RICE").opening, row(later, "RICE").closing);
  assert.deepEqual(row(later, "RICE").sales, { qty: 0, value: 0 });
});

// ---------------------------------------------------------------- 3. item ledger

test("item ledger: every movement with a running balance computed on the server", { skip }, async () => {
  const l = await svc.Reports.itemLedger({ itemId: "RICE", from: orgDay(-35), to: orgDay() });
  assert.equal(l.item.itemName, "Basmati Rice");
  assert.deepEqual(l.opening, { qty: 200, value: 2400 });
  assert.deepEqual(l.rows.map((r) => r.typeLabel), ["Sale", "Sales return", "Purchase return", "Sale"]);
  assert.deepEqual(l.rows.map((r) => r.documentNo), [docs.s1.transactionNo, docs.sr.transactionNo, docs.pr.transactionNo, docs.s2.transactionNo]);
  assert.deepEqual(l.rows.map((r) => [r.qtyIn, r.qtyOut]), [[0, 60], [10, 0], [0, 20], [0, 20]]);
  assert.deepEqual(l.rows.map((r) => r.balanceQty), [140, 150, 130, 110]);
  assert.deepEqual(l.rows.map((r) => r.balanceValue), [1680, 1800, 1520, 1286.15]);
  assert.deepEqual(l.rows.map((r) => r.unitCost), [12, 12, 14, 11.6925]);
  assert.deepEqual(l.rows.map((r) => r.partyName), ["Al Noor", "Al Noor", "Delta Foods", "Bin Zayed"]);
  assert.equal(l.rows[0].batchNo, "R2", "the sale took the soonest-expiring batch");
  assert.deepEqual(l.totals, { qtyIn: 10, qtyOut: 100, valueIn: 120, valueOut: 1233.85 });
  assert.deepEqual([l.closing.qty, l.closing.value], [110, 1286.15]);
  assert.equal(l.closing.qty, l.opening.qty + l.totals.qtyIn - l.totals.qtyOut);
  assert.equal(l.closing.value, r2(l.opening.value + l.totals.valueIn - l.totals.valueOut));
  assert.equal(l.truncated, false);

  // the whole history: no opening, receipts carry their batch, and it closes where the valuation does
  const all = await svc.Reports.itemLedger({ itemId: String(rice._id) });
  assert.deepEqual(all.opening, { qty: 0, value: 0 });
  assert.deepEqual(all.rows.map((r) => r.typeLabel), ["Purchase", "Purchase", "Sale", "Sales return", "Purchase return", "Sale"]);
  assert.deepEqual(all.rows.slice(0, 2).map((r) => r.batchNo), ["R1", "R2"]);
  assert.deepEqual(all.rows.map((r) => r.balanceQty), [100, 200, 140, 150, 130, 110]);
  assert.equal(all.closing.value, (await svc.Reports.valuation({})).rows.find((r) => r.itemId === "RICE").value);

  // a write-off shows with its batch
  const o = await svc.Reports.itemLedger({ itemId: "OIL", from: orgDay() });
  const wo = o.rows.find((r) => r.typeLabel === "Write-off");
  assert.deepEqual([wo.qtyOut, wo.valueOut, wo.batchNo, wo.documentNo], [15, 310, "O-OLD", docs.writeOff.number]);
  assert.deepEqual(o.opening, { qty: 60, value: 1240 });
  assert.deepEqual([o.closing.qty, o.closing.value], [45, 930]);
});

// ---------------------------------------------------------------- 4. sales analysis

test("sales analysis: net revenue without VAT, returns subtracted, cost of goods sold from the movements themselves", { skip }, async () => {
  const period = { from: orgDay(-35), to: orgDay() };
  const a = await svc.Reports.salesAnalysis({ ...period, groupBy: "item" });
  const ri = a.rows.find((r) => r.key === "RICE");
  const oi = a.rows.find((r) => r.key === "OIL");
  assert.deepEqual([ri.soldQty, ri.returnedQty, ri.quantity], [80, 10, 70]);
  assert.deepEqual([ri.revenue, ri.returns, ri.netRevenue], [1460, 180, 1280], "VAT (5%) is not revenue");
  assert.equal(ri.cogs, 833.85, "720 + 233.85 - the 120 restored on the return");
  assert.equal(ri.grossProfit, r2(1280 - 833.85));
  assert.equal(ri.marginPct, r2(((1280 - 833.85) / 1280) * 100));
  assert.deepEqual([oi.quantity, oi.netRevenue, oi.cogs, oi.grossProfit, oi.marginPct], [10, 300, 200, 100, 33.33]);
  assert.deepEqual(a.rows.map((r) => r.key), ["RICE", "OIL"], "largest revenue first");
  assert.equal(r2(ri.sharePct + oi.sharePct), 100);
  assert.equal(ri.sharePct, r2((1280 / 1580) * 100));

  // the cost is the sum of the cogsAmount stamped on the movements, not an estimate
  const sold = await svc.Movement.find({ eventType: "SALES_DISPATCH" }).lean();
  const back = await svc.Movement.find({ eventType: "SALES_RETURN" }).lean();
  const actual = r2(sold.reduce((t, m) => t + m.cogsAmount, 0) - back.reduce((t, m) => t + m.totalValue, 0));
  assert.equal(a.totals.cogs, actual);
  assert.deepEqual([a.totals.netRevenue, a.totals.cogs, a.totals.grossProfit, a.totals.marginPct], [1580, 1033.85, 546.15, r2((546.15 / 1580) * 100)]);
  assert.equal(a.totals.documents, 3);

  const cat = await svc.Reports.salesAnalysis({ ...period, groupBy: "category" });
  assert.deepEqual(cat.rows.map((r) => [r.name, r.netRevenue, r.cogs]), [["Grains", 1280, 833.85], ["Oils", 300, 200]]);

  const cust = await svc.Reports.salesAnalysis({ ...period, groupBy: "customer" });
  assert.equal(cust.groupBy, "customer");
  assert.deepEqual(cust.rows.map((r) => [r.name, r.netRevenue, r.cogs, r.grossProfit]), [["Al Noor", 1200, 800, 400], ["Bin Zayed", 380, 233.85, 146.15]]);
  assert.equal(cust.rows[0].documents, 2, "the sale and its return");

  // a narrower period leaves out what is outside it
  const late = await svc.Reports.salesAnalysis({ from: orgDay(-6), to: orgDay(), groupBy: "item" });
  assert.deepEqual(late.rows.map((r) => [r.key, r.netRevenue, r.cogs]), [["RICE", 380, 233.85]]);
  assert.deepEqual((await svc.Reports.salesAnalysis({ from: orgDay(-3), to: orgDay(), groupBy: "item" })).rows, []);
});

test("purchase analysis: net purchase value, average price paid and vendor count", { skip }, async () => {
  const p = await svc.Reports.salesAnalysis({ from: orgDay(-65), to: orgDay(), direction: "purchases", groupBy: "item" });
  const ri = p.rows.find((r) => r.key === "RICE");
  const oi = p.rows.find((r) => r.key === "OIL");
  assert.deepEqual([ri.purchasedQty, ri.returnedQty, ri.quantity], [200, 20, 180]);
  assert.deepEqual([ri.purchased, ri.returned, ri.netValue], [2400, 280, 2120]);
  assert.equal(ri.avgPrice, 11.77778);
  assert.equal(ri.vendors, 2);
  assert.deepEqual([oi.quantity, oi.netValue, oi.avgPrice, oi.vendors], [70, 1440, 20.57143, 1]);
  assert.deepEqual([p.totals.netValue, p.totals.vendors], [3560, 2]);
  assert.equal(p.rows[0].key, "RICE", "largest first");

  const byVendor = await svc.Reports.salesAnalysis({ from: orgDay(-65), to: orgDay(), direction: "purchases", groupBy: "customer" });
  assert.equal(byVendor.groupBy, "vendor");
  assert.deepEqual(byVendor.rows.map((r) => [r.name, r.netValue, r.vendors]), [["Gulf Mills", 2440, 1], ["Delta Foods", 1120, 1]]);

  const none = await svc.Reports.salesAnalysis({ from: orgDay(-3), to: orgDay(), direction: "purchases" });
  assert.deepEqual(none.rows, []);
  assert.equal(none.totals.avgPrice, null);
});

// ---------------------------------------------------------------- 5. expiry

test("expiry: batches on hand that expire within N days or already have, soonest first, valued at cost", { skip }, async () => {
  const e = await svc.Reports.expiry({ withinDays: 30 });
  assert.deepEqual(e.rows.map((r) => r.batchNumber), ["O-OLD", "O1"], "first-expiry-first-out; the rice batches are further out");
  const [old, o1] = e.rows;
  assert.equal(old.expired, true);
  assert.ok(old.daysToExpiry < 0);
  assert.deepEqual([old.qtyOnHand, old.unitCost, old.receiptCost, old.valueAtCost], [5, 20.66667, 22, 103.33]);
  assert.equal(o1.expired, false);
  assert.ok(o1.daysToExpiry >= 24 && o1.daysToExpiry <= 25);
  assert.deepEqual([o1.qtyOnHand, o1.valueAtCost], [40, 826.67]);
  assert.deepEqual([old.fefoRank, o1.fefoRank], [1, 2]);
  assert.deepEqual(e.totals.expired, { batches: 1, qty: 5, value: 103.33 });
  assert.deepEqual(e.totals.expiring, { batches: 1, qty: 40, value: 826.67 });
  assert.deepEqual([e.totals.batches, e.totals.qty, e.totals.value], [2, 45, 930]);

  // already expired only
  assert.deepEqual((await svc.Reports.expiry({ withinDays: 0 })).rows.map((r) => r.batchNumber), ["O-OLD"]);
  // a longer horizon reaches the rice, nearest first; a written-off or emptied batch never appears
  const wide = await svc.Reports.expiry({ withinDays: 150 });
  assert.deepEqual(wide.rows.map((r) => r.batchNumber), ["O-OLD", "O1", "R2"]);
  assert.deepEqual([wide.rows[2].qtyOnHand, wide.rows[2].valueAtCost], [10, 116.92]);
  assert.equal((await svc.Reports.expiry({ withinDays: 400 })).rows.find((r) => r.batchNumber === "R1").qtyOnHand, 100);
  assert.deepEqual((await svc.Reports.expiry({ withinDays: 150, search: "rice" })).rows.map((r) => r.batchNumber), ["R2"]);
});

// ---------------------------------------------------------------- 6. slow stock and reorder

test("slow stock: stock on hand with no sale in N days, biggest value first; never-sold stock is aged from its receipt", { skip }, async () => {
  await svc.Stock.create({ itemId: "SALT", sku: "SALT-1KG", itemName: "Sea Salt", category: (await svc.Category.create({ name: "Spices" }))._id });
  const salt = await svc.Stock.findOne({ itemId: "SALT" });
  docs.salt = await make("purchase_order", vendorA, "Vendor", [line(salt, 30, 2, { batchNumber: "S1", expiryDate: inDays(400) })], { date: ago(100) });

  const s90 = await svc.Reports.slowMoving({ days: 90 });
  assert.deepEqual(s90.rows.map((r) => r.itemId), ["SALT"], "rice sold 5 days ago and oil 30 days ago are moving");
  const st = s90.rows[0];
  assert.deepEqual([st.qty, st.value, st.neverSold, st.lastSaleDate, st.daysSince], [30, 60, true, null, 100]);
  assert.equal(s90.totals.neverSold, 1);

  const s10 = await svc.Reports.slowMoving({ days: 10 });
  assert.deepEqual(s10.rows.map((r) => r.itemId), ["OIL", "SALT"], "ranked by value");
  const oi = s10.rows[0];
  assert.deepEqual([oi.qty, oi.value, oi.neverSold, oi.daysSince], [45, 930, false, 30]);
  assert.equal(dubaiDayOf(oi.lastSaleDate), orgDay(-30));
  assert.equal(s10.totals.value, 990);
  assert.equal(s10.totals.stockValue, 2276.15);
  assert.equal(s10.totals.pctOfStockValue, r2((990 / 2276.15) * 100));

  // just received and never sold is not dead stock
  const fresh = await svc.Reports.slowMoving({ days: 120 });
  assert.deepEqual(fresh.rows, []);
});

test("reorder: active items at or below their reorder level, the emptiest first", { skip }, async () => {
  let r = await svc.Reports.reorder();
  assert.deepEqual(r.rows.map((x) => x.itemId), ["RICE"], "oil is above its level; salt has none set");
  const rice = r.rows[0];
  assert.deepEqual([rice.qty, rice.reorderLevel, rice.shortfall, rice.status, rice.avgCost, rice.shortfallValue], [110, 150, 40, "below", 11.69231, 467.69]);
  assert.deepEqual([r.totals.items, r.totals.outOfStock, r.totals.shortfallValue], [1, 0, 467.69]);

  await svc.Stock.updateOne({ itemId: "SALT" }, { reorderLevel: 30 });
  await svc.Stock.updateOne({ itemId: "OIL" }, { reorderLevel: 100, status: "Inactive" });
  r = await svc.Reports.reorder();
  assert.deepEqual(r.rows.map((x) => [x.itemId, x.status]), [["RICE", "below"], ["SALT", "at"]], "an inactive item is not reordered");
  await svc.Stock.updateOne({ itemId: "OIL" }, { reorderLevel: 20, status: "Active" });
  await svc.Stock.updateOne({ itemId: "RICE" }, { currentStock: 0 });
  assert.equal((await svc.Reports.reorder()).rows[0].status, "out");
  await svc.Stock.updateOne({ itemId: "RICE" }, { currentStock: 110 });
  assert.deepEqual((await svc.Reports.reorder({ categoryId: String(grains._id) })).rows.map((x) => x.itemId), ["RICE"]);
});

// ---------------------------------------------------------------- history edits and the ledger

test("a deleted (reversed) document disappears from every report, exactly as it does from the ledger", { skip }, async () => {
  const before = await svc.Reports.valuation({});
  const beforeLedger = await svc.Reports.itemLedger({ itemId: "RICE" });
  const buy = await make("purchase_order", vendorB, "Vendor", [line(rice, 5, 9, { batchNumber: "TMP", expiryDate: inDays(300) })], { date: ago(3) });

  const during = await svc.Reports.valuation({});
  assert.equal(during.totals.value, r2(before.totals.value + 45));
  assert.equal(row(during, "RICE").qty, 115);
  assert.equal(during.reconciliation.reconciles, true);

  await svc.Tx.deleteTransaction(buy._id, "tester");
  assert.equal(await svc.Movement.countDocuments({ referenceNumber: /^REV-/ }), 1, "the reversal row exists in the audit trail");

  const after = await svc.Reports.valuation({});
  assert.equal(after.totals.value, before.totals.value);
  assert.equal(row(after, "RICE").qty, 110);
  assert.equal(after.reconciliation.ledgerBalance, before.reconciliation.ledgerBalance);
  assert.equal(after.reconciliation.reconciles, true);
  const ledger = await svc.Reports.itemLedger({ itemId: "RICE" });
  assert.equal(ledger.rows.length, beforeLedger.rows.length, "neither the original nor its reversal is listed");
  assert.ok(ledger.rows.every((r) => !/^REV-/.test(r.documentNo)));
  // a period spanning the day shows no purchase either
  const m = await svc.Reports.movement({ from: orgDay(-4), to: orgDay(-2) });
  assert.deepEqual(row(m, "RICE")?.purchases ?? { qty: 0, value: 0 }, { qty: 0, value: 0 });
  assert.equal((await svc.Reports.valuation({})).rows.find((r) => r.itemId === "RICE").outOfSync, undefined);
});

test("stock that predates its history is carried as an implicit opening and listed as not posted to the ledger", { skip }, async () => {
  const before = await svc.Reports.valuation({});
  // created with 12 on hand at 30 and no INITIAL_STOCK movement, as an import or a seed would
  const ghee = await svc.Stock.create({ itemId: "GHEE", sku: "GHEE-1KG", itemName: "Ghee", category: oils._id, currentStock: 12, purchasePrice: 30 });
  const unmoved = await svc.Reports.valuation({});
  const g0 = row(unmoved, "GHEE");
  assert.deepEqual([g0.qty, g0.value, g0.outOfSync, g0.recordedQty], [0, 0, true, 12], "the item master has stock the history cannot see");

  await make("purchase_order", vendorA, "Vendor", [line(ghee, 8, 31, { batchNumber: "G1", expiryDate: inDays(90) })], { date: ago(2) });
  const after = await svc.Reports.valuation({});
  const g = row(after, "GHEE");
  assert.deepEqual([g.qty, g.value, g.outOfSync], [20, 608, undefined], "12 @ 30 carried over, 8 @ 31 bought");
  assert.equal(after.totals.value, r2(before.totals.value + 608));

  const rec = after.reconciliation;
  assert.equal(rec.reconciles, false);
  assert.equal(rec.difference, 360, "the carried-over stock was never posted to the ledger");
  const opening = rec.lines.find((l) => l.key === "opening");
  assert.deepEqual([opening.stock, opening.ledger, opening.difference], [360, 0, 360]);
  assert.equal(rec.unexplained, 0);

  // a period report keeps it in the opening balance, never in the period's movement
  const m = await svc.Reports.movement({ from: orgDay(-1), to: orgDay() });
  assert.deepEqual(row(m, "GHEE").opening, { qty: 20, value: 608 });
  assert.deepEqual(row(m, "GHEE").purchases, { qty: 0, value: 0 });
  const l = await svc.Reports.itemLedger({ itemId: "GHEE" });
  assert.deepEqual(l.opening, { qty: 12, value: 360 });
  assert.deepEqual([l.closing.qty, l.closing.value], [20, 608]);

  // post it properly (Dr Inventory / Cr Opening Balance Equity) and the report agrees again
  const equity = await svc.LedgerAccount.findOne({ accountName: "Opening Balance Equity" });
  const inv = await svc.Config.resolveAccount("inventory-asset");
  await svc.Financial.createVoucher({ voucherType: "journal", date: new Date(), narration: "Opening stock: ghee", lines: [{ accountId: inv, debit: 360 }, { accountId: equity._id, credit: 360 }] }, admin);
  const fixed = await svc.Reports.valuation({});
  assert.equal(fixed.reconciliation.reconciles, true);
  const j = fixed.reconciliation.lines.find((x) => x.key === "journals");
  assert.deepEqual([j.stock, j.ledger, j.difference], [0, 360, -360], "the journal is the ledger-only side");
  assert.equal(fixed.reconciliation.difference, 0, "the two sources net to nothing: opening +360, journal -360");
});

test("a manual stock adjustment is posted, so stock and the Inventory account still agree", { skip }, async () => {
  const before = (await svc.Reports.valuation({})).reconciliation;
  assert.equal(before.reconciles, true);

  await svc.StockService.updateStock(String(rice._id), { currentStock: 112 }, "tester"); // +2 rice at the average
  const after = (await svc.Reports.valuation({})).reconciliation;
  assert.equal(after.reconciles, true, JSON.stringify(after.lines));
  assert.ok(after.stockValue > before.stockValue);
  const gap = (rec) => rec.lines.find((l) => l.key === "opening").difference;
  assert.equal(gap(after), gap(before), "the adjustment is on both sides of the opening / adjustments line: its gap is unchanged");

  await svc.StockService.updateStock(String(rice._id), { currentStock: 110 }, "tester"); // and back out again
  assert.equal((await svc.Reports.valuation({})).reconciliation.reconciles, true);
});

test("when stock and ledger disagree, the difference is split by source: unposted adjustments and manual journals", { skip }, async () => {
  const before = (await svc.Reports.valuation({})).reconciliation;
  assert.equal(before.reconciles, true);

  // a stock adjustment made while posting was off (+5 rice) is a movement with no entry; a journal to Inventory is posted but moves no stock
  await svc.CompanySettings.updateMany({}, { ledgerPostingEnabled: false });
  await svc.StockService.updateStock(String(rice._id), { currentStock: 115 }, "tester");
  await svc.CompanySettings.updateMany({}, { ledgerPostingEnabled: true });
  const adj = await svc.Movement.findOne({ eventType: "STOCK_ADJUSTMENT" }).sort({ createdAt: -1 }).lean();
  assert.ok(adj.totalValue > 0);
  const equity = await svc.LedgerAccount.findOne({ accountName: "Opening Balance Equity" });
  const inv = await svc.Config.resolveAccount("inventory-asset");
  await svc.Financial.createVoucher({ voucherType: "journal", date: new Date(), narration: "Stock count correction", lines: [{ accountId: inv, debit: 100 }, { accountId: equity._id, credit: 100 }] }, admin);

  const v = await svc.Reports.valuation({});
  const rec = v.reconciliation;
  assert.equal(row(v, "RICE").qty, 115);
  assert.equal(rec.stockValue, r2(before.stockValue + adj.totalValue));
  assert.equal(rec.ledgerBalance, r2(before.ledgerBalance + 100));
  assert.equal(rec.difference, r2(adj.totalValue - 100));
  assert.equal(rec.reconciles, false);

  const bySource = Object.fromEntries(rec.lines.map((l) => [l.key, l]));
  assert.deepEqual([bySource.opening.stock, bySource.opening.ledger], [r2(adj.totalValue + 360), 0], "the ghee carried over plus the adjustment");
  assert.deepEqual([bySource.journals.stock, bySource.journals.ledger], [0, 460], "the ghee journal and the correction");
  for (const key of ["purchases", "purchaseReturns", "sales", "salesReturns", "writeOffs"]) assert.equal(bySource[key].difference, 0, `${key} still agrees`);
  assert.equal(rec.unexplained, 0, "every fils of the difference is attributed");
  assert.equal(r2(rec.lines.reduce((t, l) => t + l.difference, 0)), rec.difference);

  // the same difference at the closing date of a movement report
  const m = await svc.Reports.movement({ from: orgDay(-1), to: orgDay() });
  assert.equal(m.reconciliation.difference, rec.difference);
  assert.equal(m.totals.closing.value, rec.stockValue);
  assert.equal(row(m, "RICE").adjustments.qty, 5);
});

// ---------------------------------------------------------------- input and routes

test("bad input is refused with a clear message", { skip }, async () => {
  const { Reports } = svc;
  await assert.rejects(() => Reports.valuation({ groupBy: "colour" }), { code: "INVALID_GROUP", statusCode: 400 });
  await assert.rejects(() => Reports.valuation({ asOn: "not-a-date" }), { code: "INVALID_DATE" });
  await assert.rejects(() => Reports.valuation({ categoryId: "nope" }), { code: "INVALID_ID" });
  await assert.rejects(() => Reports.movement({ from: orgDay(), to: orgDay(-3) }), { code: "INVALID_RANGE" });
  await assert.rejects(() => Reports.itemLedger({}), { code: "ITEM_REQUIRED" });
  await assert.rejects(() => Reports.itemLedger({ itemId: "NO-SUCH-ITEM" }), { code: "ITEM_NOT_FOUND", statusCode: 404 });
  await assert.rejects(() => Reports.salesAnalysis({ direction: "sideways" }), { code: "INVALID_DIRECTION" });
  await assert.rejects(() => Reports.salesAnalysis({ groupBy: "colour" }), { code: "INVALID_GROUP" });
  await assert.rejects(() => Reports.expiry({ withinDays: -1 }), { code: "INVALID_PARAMETER" });
  await assert.rejects(() => Reports.slowMoving({ days: 0 }), { code: "INVALID_PARAMETER" });
  await assert.rejects(() => Reports.slowMoving({ days: "abc" }), { code: "INVALID_PARAMETER" });
});

test("lookups list items and categories for the filters", { skip }, async () => {
  const l = await svc.Reports.lookups();
  assert.deepEqual(l.categories.map((c) => c.name), ["Grains", "Oils", "Spices"]);
  const ri = l.items.find((i) => i.code === "RICE");
  assert.deepEqual([ri.name, ri.sku, ri.categoryId, ri.id], ["Basmati Rice", "RICE-5KG", String(grains._id), String(rice._id)]);
});

test("over HTTP: the routes need a login and return { success, data }", { skip }, async () => {
  const express = require("express");
  const errorHandler = require("../../utils/errorHandler");
  const router = require("../../routes/reports/stockReportRoutes");
  const { generateTokens } = require("../core/adminService");

  const boss = await new svc.Admin({ name: "Boss", email: "boss@test.uae", password: "12312312", type: "super_admin", status: "active", isActive: true }).save();
  const { accessToken } = generateTokens({ id: boss._id, email: boss.email, type: boss.type, permissions: boss.permissions, name: boss.name });

  const app = express();
  app.use("/api/v1/stock-reports", router);
  app.use(errorHandler);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/stock-reports`;
  const get = async (url, token = accessToken) => {
    const res = await fetch(`${base}${url}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json() };
  };
  try {
    assert.equal((await get("/valuation", null)).status, 401);

    const val = await get(`/valuation?asOn=${orgDay()}&groupBy=item`);
    assert.equal(val.status, 200);
    assert.equal(val.body.success, true);
    assert.ok(val.body.data.rows.length >= 2);
    assert.equal(typeof val.body.data.reconciliation.reconciles, "boolean");

    for (const [url, key] of [
      [`/movement?from=${orgDay(-35)}&to=${orgDay()}`, "totals"], [`/item-ledger?itemId=RICE`, "closing"],
      [`/sales-analysis?from=${orgDay(-35)}&to=${orgDay()}&groupBy=customer`, "rows"], [`/sales-analysis?direction=purchases&groupBy=category`, "rows"],
      [`/expiry?withinDays=30`, "totals"], [`/slow-moving?days=90`, "totals"], [`/reorder`, "totals"], [`/lookups`, "items"],
    ]) {
      const res = await get(url);
      assert.equal(res.status, 200, url);
      assert.ok(res.body.data[key] !== undefined, `${url} returns ${key}`);
    }

    const bad = await get("/item-ledger");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.success, false);
    assert.equal(bad.body.errorCode, "ITEM_REQUIRED");
    assert.equal((await get("/valuation?groupBy=colour")).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
