// Van sales phase 7 against a throwaway database: what the salesman sees at a customer's door (last order, usual items,
// what they owe, all cut to what is on the van), the daily targets copied onto a trip and the progress against them,
// and the owner's figures (drop size, lines per call, cost per drop, sales by day) tying to the invoices themselves.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vp7_${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Org: require("../core/organisationService"),
    Tx: require("../orderPurchase/transactionService"),
    StockService: require("../stock/stockService"),
    Van: require("../vansales/vanService"),
    Trip: require("../vansales/vanTripService"),
    Sales: require("../vansales/vanTripSales"),
    Settle: require("../vansales/vanTripSettlement"),
    Visits: require("../vansales/vanVisitService"),
    Report: require("../vansales/vanSalesReportService"),
    Chart: require("../financial/defaultChartService"),
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

let salesman, A, B, rice, sugar, route, van, trip;
const by = () => String(salesman._id);

test("setup: a van with daily targets, out on a two-customer route with rice and sugar on it", { skip }, async () => {
  salesman = await svc.Admin.create({ name: "Rashid", email: `rashid7.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Wholesale Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  const mk = (id, name) => svc.Customer.create({ customerId: id, customerName: name, contactPerson: name, phone: "0500000000", shippingAddress: "Dubai", paymentTerms: "Net 30" });
  [A, B] = await Promise.all([mk("C1", "Al Noor Grocery"), mk("C2", "Bin Zayed Market")]);
  const cat = await svc.Category.create({ name: "Food" });
  const item = (sku, itemName, salesPrice) => svc.StockService.createStock({ categoryId: cat._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku, itemName, salesPrice }, "tester");
  rice = await item("RICE", "Rice 5kg", 20);
  sugar = await item("SUGAR", "Sugar 10kg", 30);
  const po = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [rice, sugar].map((s) => ({ itemId: s._id, description: s.itemName, qty: 100, price: 10, vatPercent: 0 })) }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");
  route = await svc.Van.createRoute({ name: "North", days: [1, 3, 5], customers: [{ customerId: String(A._id) }, { customerId: String(B._id) }] }, "tester");
  van = await svc.Van.create({ code: "VAN-1", name: "Van One", salesmanId: by(), defaultRouteId: route.id, dailySalesTarget: "250", dailyCallsTarget: 2 }, "tester");
  assert.deepEqual([van.dailySalesTarget, van.dailyCallsTarget], [250, 2]);
  trip = await svc.Trip.open({ vanId: van._id }, "tester");
  await svc.Trip.load(trip._id, { lines: [{ stockId: String(rice._id), qty: 40 }, { stockId: String(sugar._id), qty: 10 }] }, "tester");
  await svc.Trip.depart(trip._id, "tester");
});

test("at the door: the last order, the usual items and what they owe, cut to what the van holds", { skip }, async () => {
  const blank = await svc.Sales.insight(trip._id, A._id);
  assert.equal(blank.lastOrder, null, "a new customer has no history");
  assert.deepEqual([blank.usual, blank.notLately], [[], []]);
  const sell = (customer, items) => svc.Sales.sell(trip._id, { customerId: customer._id, items: items.map(([s, qty]) => ({ itemId: s._id, qty, vatPercent: 0 })) }, by());
  await sell(A, [[rice, 5]]);
  await sell(A, [[rice, 3], [sugar, 2]]);
  const r = await svc.Sales.insight(trip._id, A._id);
  assert.deepEqual(r.lastOrder.lines.map((l) => [l.name, l.qty]).sort(), [["Rice 5kg", 3], ["Sugar 10kg", 2]], "the latest invoice, by item name");
  assert.equal(r.lastOrder.lines.find((l) => l.name === "Rice 5kg").onVan, 32, "40 loaded less 8 sold");
  assert.deepEqual(r.usual.map((x) => [x.name, x.times, x.avgQty]), [["Rice 5kg", 2, 4]], "usual needs two invoices once there are two");
  assert.equal(r.position.owed, 5 * 20 + 3 * 20 + 2 * 30, "what they owe comes from the books");
  assert.equal((await svc.Sales.insight(trip._id, B._id)).lastOrder, null, "another customer's history never shows");
  await assert.rejects(() => svc.Sales.insight(trip._id, "nope"), { code: "CUSTOMER_REQUIRED" });
});

test("the trip carries the van's targets and says how far along it is", { skip }, async () => {
  await svc.Sales.sell(trip._id, { customerId: B._id, items: [{ itemId: rice._id, qty: 10, vatPercent: 0 }] }, by());
  await svc.Visits.record(trip._id, { customerId: B._id, reason: "closed" }, by());
  const t = await svc.Trip.getById(trip._id);
  assert.deepEqual(t.totals.target, { sales: 250, calls: 2 });
  assert.equal(t.totals.sales, 420, "100 + 120 to Al Noor, 200 to Bin Zayed");
  assert.deepEqual([t.totals.calls, t.totals.productive], [2, 2]);
  assert.deepEqual([t.totals.progress.sales.pct, t.totals.progress.sales.toGo, t.totals.progress.sales.hit], [168, 0, true]);
  assert.deepEqual([t.totals.progress.calls.pct, t.totals.progress.calls.hit], [100, true]);
  // changing the van's target later does not re-judge a trip that already opened with the old one
  await svc.Van.update(van.id, { name: "Van One", dailySalesTarget: "9999" }, "tester");
  assert.equal((await svc.Trip.getById(trip._id)).totals.target.sales, 250);
  // a blank target takes it away from the NEXT trip, and an update naming no target leaves the van's alone
  assert.equal((await svc.Van.get(van.id)).dailySalesTarget, 9999);
  await svc.Van.update(van.id, { name: "Van One" }, "tester");
  assert.equal((await svc.Van.get(van.id)).dailySalesTarget, 9999);
});

test("the owner's figures tie to the invoices: drop size, lines per call, cost per drop and sales by day", { skip }, async () => {
  await svc.Settle.unload(trip._id, { lines: [{ stockId: String(rice._id), countedGood: 22, countedDamaged: 0 }, { stockId: String(sugar._id), countedGood: 8, countedDamaged: 0 }] }, "tester");
  const day = new Date().toISOString().slice(0, 10);
  const r = await svc.Report.summary({ from: day, to: day });
  assert.deepEqual([r.total.invoices, r.total.lines, r.total.sales], [3, 4, 420]);
  assert.equal(r.total.dropSize, 140, "420 over 3 invoices");
  assert.equal(r.total.linesPerCall, 2, "4 lines over 2 productive calls");
  assert.equal(r.total.strikeRate, 100);
  assert.equal(r.total.costPerDrop, 0, "no road expenses were taken");
  assert.equal(r.byDay.length, 1);
  assert.deepEqual([r.byDay[0].day, r.byDay[0].sales, r.byDay[0].invoices], [day, 420, 3]);
  const row = r.bySalesman[0];
  assert.deepEqual([row.invoices, row.lines, row.dropSize], [3, 4, 140]);
  assert.deepEqual([r.rows[0].salesTarget, r.rows[0].targetHit, row.targetDays, row.targetTrips], [250, true, 1, 1], "the trip's own copy of the target (250, not the 9999 the van has now)");
});
