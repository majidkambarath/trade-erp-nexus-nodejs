// Van sales phase 5 against a throwaway database: the shop pinned from the van and a sale far from it flagged (never
// refused), the odometer, fuel paid from the van's own cash taking the cash expected down and the books still
// balancing at settlement, the supervisor's board, and route profitability tying to the trip's own figures.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vp5_${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Tx: require("../orderPurchase/transactionService"),
    StockService: require("../stock/stockService"),
    Van: require("../vansales/vanService"),
    Trip: require("../vansales/vanTripService"),
    Sales: require("../vansales/vanTripSales"),
    Settle: require("../vansales/vanTripSettlement"),
    Visits: require("../vansales/vanVisitService"),
    Fleet: require("../vansales/vanFleetService"),
    Report: require("../vansales/vanSalesReportService"),
    Chart: require("../financial/defaultChartService"),
    VanTrip: require("../../models/modules/vansales/vanTripModel"),
    Customer: require("../../models/modules/customerModel"),
    Category: require("../../models/modules/categoryModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Admin: require("../../models/core/adminModel"),
    fin: require("../../models/modules/financial/financialModels"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Chart.provision();
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

let salesman, A, B, rice, route, van, trip;
const by = () => String(salesman._id);
const SHOP = { lat: 25.2048, lng: 55.2708, accuracy: 10 };
const FAR = { lat: 25.2048, lng: 55.2808, accuracy: 10 }; // about a kilometre east

test("setup: rice bought at 10, two customers on a route, a van out at 12,000 km", { skip }, async () => {
  salesman = await svc.Admin.create({ name: "Rashid", email: `rashid5.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Wholesale Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  const mk = (id, name) => svc.Customer.create({ customerId: id, customerName: name, contactPerson: name, phone: "0500000000", shippingAddress: "Dubai", paymentTerms: "Net 30" });
  [A, B] = await Promise.all([mk("C1", "Al Noor"), mk("C2", "Bin Zayed")]);
  const cat = await svc.Category.create({ name: "Food" });
  rice = await svc.StockService.createStock({ categoryId: cat._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku: "RICE", itemName: "Rice 5kg", salesPrice: 20 }, "tester");
  const po = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: rice._id, description: "Rice", qty: 100, price: 10, vatPercent: 0 }] }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");
  route = await svc.Van.createRoute({ name: "North", customers: [{ customerId: String(A._id) }, { customerId: String(B._id) }] }, "tester");
  van = await svc.Van.create({ code: "VAN-1", name: "Van One", salesmanId: by(), defaultRouteId: route.id }, "tester");
  trip = await svc.Trip.open({ vanId: van._id }, "tester");
  await svc.Trip.load(trip._id, { lines: [{ stockId: String(rice._id), qty: 40 }] }, "tester");
  await assert.rejects(() => svc.Trip.depart(trip._id, "tester", { odometer: "-5" }), { code: "ODOMETER_INVALID" });
  await svc.Trip.depart(trip._id, "tester", { odometer: 12000 });
  const t = await svc.VanTrip.findById(trip._id);
  assert.equal(t.odometer.out, 12000);
  assert.ok(t.departedAt);
});

test("a shop is pinned once from the van; moving the pin is a supervisor's call", { skip }, async () => {
  await assert.rejects(() => svc.Fleet.pinCustomer(trip._id, A._id, { lat: 999, lng: 1 }, by()), { code: "LOCATION_REQUIRED" });
  const pinned = await svc.Fleet.pinCustomer(trip._id, A._id, SHOP, by());
  assert.equal(pinned.location.lat, SHOP.lat);
  await assert.rejects(() => svc.Fleet.pinCustomer(trip._id, A._id, FAR, by()), { code: "LOCATION_ALREADY_SET" });
  const outsider = await svc.Customer.create({ customerId: "C9", customerName: "Elsewhere", contactPerson: "x", phone: "0500000000", shippingAddress: "x", paymentTerms: "Net 30" });
  await assert.rejects(() => svc.Fleet.pinCustomer(trip._id, outsider._id, SHOP, by()), { code: "CUSTOMER_NOT_ON_ROUTE" });
  const t = await svc.Trip.getById(trip._id);
  assert.deepEqual(t.route.map((s) => s.pinned), [true, false]);
});

test("a sale at the shop is fine, one a kilometre away is flagged and still made, and a sale with no location is just a sale", { skip }, async () => {
  await svc.Sales.sell(trip._id, { customerId: A._id, items: [{ itemId: rice._id, qty: 10, vatPercent: 0 }], payNow: { mode: "cash", full: true }, location: SHOP }, by());
  const far = await svc.Sales.sell(trip._id, { customerId: A._id, items: [{ itemId: rice._id, qty: 5, vatPercent: 0 }], payNow: { mode: "cash", full: true }, location: FAR }, by());
  assert.equal(far.invoice.status, "APPROVED", "a far sale is never refused");
  await svc.Sales.sell(trip._id, { customerId: B._id, items: [{ itemId: rice._id, qty: 5, vatPercent: 0 }], payNow: { mode: "cash", full: true } }, by());
  await svc.Visits.record(trip._id, { customerId: B._id, reason: "has_stock", location: FAR }, by());
  const t = await svc.VanTrip.findById(trip._id).lean();
  assert.deepEqual(t.pings.map((p) => [p.kind, p.far]), [["sale", false], ["sale", true], ["visit", undefined]], "B was never pinned: nothing to compare");
  assert.ok(t.pings[1].distanceM > 900 && t.pings[1].distanceM < 1100);
});

test("fuel is paid from the van's own cash: the cash it holds and must hand in goes down by it", { skip }, async () => {
  await assert.rejects(() => svc.Fleet.expense(trip._id, { kind: "lunch", amount: 10 }, by()), { code: "EXPENSE_KIND_REQUIRED" });
  await assert.rejects(() => svc.Fleet.expense(trip._id, { kind: "fuel", amount: 0 }, by()), { code: "AMOUNT_REQUIRED" });
  const v = await svc.Fleet.expense(trip._id, { kind: "fuel", amount: 60, note: "ENOC Deira" }, by());
  assert.equal(v.status, "approved");
  assert.equal(String(v.vanTripRef.tripId), String(trip._id));
  const t = await svc.Trip.getById(trip._id);
  assert.equal(t.totals.cash, 400, "20 x 20 taken in cash");
  assert.equal(t.totals.expenses, 60);
  assert.equal(t.totals.cashInHand, 340);
  const list = await svc.Fleet.tripExpenses(trip._id);
  assert.deepEqual(list.map((e) => [e.kind, e.amount]), [["fuel", 60]]);
});

test("the board shows the van out, where it is on its route, its cash and the far sale", { skip }, async () => {
  const b = await svc.Fleet.board();
  const row = b.rows.find((r) => r.tripNo === trip.tripNo);
  assert.equal(b.counts.out, 1);
  assert.deepEqual([row.done, row.total], [2, 2]);
  assert.equal(row.totals.cashInHand, 340);
  assert.equal(row.far.length, 1);
  assert.equal(row.quiet, false, "it just sold");
  assert.equal(b.counts.far, 1);
  const later = await svc.Fleet.board({ now: new Date(Date.now() + 3 * 3600 * 1000) });
  assert.equal(later.rows.find((r) => r.tripNo === trip.tripNo).quiet, false, "every stop is served, so it is not quiet but done");
});

test("count in at 12,086 km and settle: the cash expected is net of the fuel, and the van's cash account comes back to zero", { skip }, async () => {
  const t = await svc.Trip.getById(trip._id);
  await assert.rejects(() => svc.Settle.unload(trip._id, { odometer: 11999, counts: [] }, by()), { code: "ODOMETER_BELOW_OUT" });
  await svc.Settle.unload(trip._id, { odometer: 12086, counts: t.sellable.map((l) => ({ stockId: l.stockId, good: l.qty, damaged: 0 })) }, by());
  const plan = await svc.Settle.preview(trip._id, { cashHanded: 330 });
  assert.equal(plan.cash.expected, 340);
  assert.equal(plan.expenses, 60);
  await svc.Settle.settle(trip._id, { cashHanded: 330, acknowledge: plan.warnings.map((w) => w.code) }, by());
  const vanCash = await svc.fin.LedgerAccount.findById((await svc.VanTrip.findById(trip._id)).cashAccountId).lean();
  assert.equal(r2(vanCash.currentBalance), 0, "taken 400, spent 60, settled 340");
  const settled = await svc.VanTrip.findById(trip._id).lean();
  assert.equal(settled.settlement.expenses, 60);
  assert.equal(settled.odometer.in, 12086);
});

test("route profitability: sales less cost of goods, the fuel and the cash short, per route and per km", { skip }, async () => {
  const r = await svc.Report.routeProfit({});
  assert.equal(r.trips, 1);
  const north = r.rows[0];
  assert.equal(north.name, "North");
  assert.deepEqual([north.sales, north.cost, north.expenses, north.cashVariance, north.km], [400, 200, 60, -10, 86]);
  assert.equal(north.grossMargin, 200);
  assert.equal(north.contribution, 130, "200 margin - 60 fuel - 10 short");
  assert.equal(north.perKm, 1.51);
  const bySalesman = await svc.Report.routeProfit({ by: "salesman" });
  assert.equal(bySalesman.rows[0].name, "Rashid");
});
