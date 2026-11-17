// Van sales phase 2 against a throwaway database: price lists on the road, visits without a sale and the strike rate,
// goods handed from one van to another, the cash limit, and - the correctness gap closed - nothing done on a trip can
// be taken back once the van has been counted in.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Tx: require("../orderPurchase/transactionService"),
    Fin: require("../financial/financialService"),
    StockService: require("../stock/stockService"),
    Van: require("../vansales/vanService"),
    Trip: require("../vansales/vanTripService"),
    Sales: require("../vansales/vanTripSales"),
    Settle: require("../vansales/vanTripSettlement"),
    Visits: require("../vansales/vanVisitService"),
    Lists: require("../vansales/priceListService"),
    Report: require("../vansales/vanSalesReportService"),
    Chart: require("../financial/defaultChartService"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Category: require("../../models/modules/categoryModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Admin: require("../../models/core/adminModel"),
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

let salesman, A, B, C, rice, route, van, van2, trip, trip2, invoiceA, receiptA, invoiceB;
const by = () => String(salesman._id);
const sellable = async (t) => (await svc.Trip.getById(t._id)).sellable.find((l) => l.stockId === String(rice._id))?.qty || 0;

test("setup: three customers, rice at 20, a customer deal, a route list, a route", { skip }, async () => {
  salesman = await svc.Admin.create({ name: "Rashid", email: `rashid2.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Wholesale Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  const mk = (id, name) => svc.Customer.create({ customerId: id, customerName: name, contactPerson: name, phone: "0500000000", shippingAddress: "Dubai", paymentTerms: "Net 30" });
  [A, B, C] = await Promise.all([mk("C1", "Al Noor"), mk("C2", "Bin Zayed"), mk("C3", "Corner Shop")]);
  const cat = await svc.Category.create({ name: "Food" });
  rice = await svc.StockService.createStock({ categoryId: cat._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku: "RICE", itemName: "Rice 5kg", salesPrice: 20 }, "tester");
  const po = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: rice._id, description: "Rice", qty: 100, price: 10, rate: 10, vatPercent: 0 }] }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");

  await svc.Lists.create({ name: "Al Noor deal", customerIds: [String(A._id)], lines: [{ stockId: String(rice._id), price: 17 }, { stockId: String(rice._id), price: 15, minQty: 10 }] }, "tester");
  const routeList = await svc.Lists.create({ name: "North route", lines: [{ stockId: String(rice._id), price: 18 }] }, "tester");
  await assert.rejects(() => svc.Lists.create({ name: "Al Noor deal" }, "tester"), { code: "PRICE_LIST_NAME_TAKEN" });
  route = await svc.Van.createRoute({ name: "North", priceListId: routeList.id, customers: [{ customerId: String(A._id) }, { customerId: String(B._id) }, { customerId: String(C._id) }] }, "tester");
  assert.equal(String(route.priceListId), routeList.id);
});

test("a van with a cash limit goes out on the route", { skip }, async () => {
  van = await svc.Van.create({ code: "VAN-1", name: "Van One", salesmanId: by(), defaultRouteId: route.id, cashLimit: 100 }, "tester");
  assert.equal(van.cashLimit, 100);
  trip = await svc.Trip.open({ vanId: van._id }, "tester");
  await svc.Trip.load(trip._id, { lines: [{ stockId: String(rice._id), qty: 50 }] }, "tester");
  await svc.Trip.depart(trip._id, "tester");
});

test("each customer is offered their own price: their deal, else the route's list, else the item's", { skip }, async () => {
  const pa = await svc.Sales.prices(trip._id, A._id);
  assert.deepEqual([pa[0].price, pa[0].source], [17, "customer"]);
  const pb = await svc.Sales.prices(trip._id, B._id);
  assert.deepEqual([pb[0].price, pb[0].source], [18, "route"]);
});

test("a sale with no price typed is priced from the list, quantity break and all", { skip }, async () => {
  const { invoice, receipt } = await svc.Sales.sell(trip._id, { customerId: A._id, items: [{ itemId: rice._id, qty: 10, vatPercent: 0 }], payNow: { mode: "cash", full: true } }, by());
  invoiceA = invoice;
  receiptA = receipt;
  assert.equal(invoice.items[0].price, 15, "10 or more is 15 on Al Noor's deal");
  assert.equal(r2(invoice.totalAmount), 150);
});

test("selling under the customer's list needs a supervisor", { skip }, async () => {
  await assert.rejects(() => svc.Sales.sell(trip._id, { customerId: B._id, items: [{ itemId: rice._id, qty: 2, price: 16, vatPercent: 0 }] }, by()), { code: "PRICE_BELOW_LIST" });
  const { invoice } = await svc.Sales.sell(trip._id, { customerId: B._id, items: [{ itemId: rice._id, qty: 2, price: 16, vatPercent: 0 }] }, by(), { mayUnderprice: true });
  invoiceB = invoice;
  assert.equal(invoice.items[0].price, 16);
  const above = await svc.Sales.sell(trip._id, { customerId: B._id, items: [{ itemId: rice._id, qty: 1, price: 19, vatPercent: 0 }] }, by());
  assert.equal(above.invoice.items[0].price, 19, "selling above the list is the salesman's own call");
});

test("the van past its cash limit is flagged, never refused", { skip }, async () => {
  const t = await svc.Trip.getById(trip._id);
  assert.equal(t.totals.cash, 150);
  assert.equal(t.totals.cashLimit, 100);
  assert.equal(t.totals.cashOverLimit, true);
});

test("a stop without a sale is recorded with its reason and shows on the route", { skip }, async () => {
  await assert.rejects(() => svc.Visits.record(trip._id, { customerId: C._id }, by()), { code: "VISIT_REASON_REQUIRED" });
  await svc.Visits.record(trip._id, { customerId: C._id, reason: "closed", note: "Shutter down", location: { lat: 25.2, lng: 55.3, accuracy: 20 } }, by(), "Rashid");
  const bad = await svc.Visits.record(trip._id, { customerId: C._id, reason: "has_stock", location: { lat: 999, lng: 0 } }, by());
  assert.equal(bad.location?.lat, undefined, "a location that is not real is dropped, the visit is kept");
  const t = await svc.Trip.getById(trip._id);
  const stop = t.route.find((s) => s.customerId === String(C._id));
  assert.equal(stop.visit.reason, "has_stock", "the latest visit wins");
  assert.equal(t.route.find((s) => s.customerId === String(A._id)).sold, true);
});

test("goods handed from one van to another follow on both, and only what the first can sell can go", { skip }, async () => {
  van2 = await svc.Van.create({ code: "VAN-2", name: "Van Two" }, "tester");
  trip2 = await svc.Trip.open({ vanId: van2._id, salesmanId: by() }, "tester");
  const before = await sellable(trip);
  await assert.rejects(() => svc.Trip.transfer(trip._id, { toTripId: trip2._id, lines: [{ stockId: String(rice._id), qty: before + 1 }] }, "tester"), { code: "VAN_STOCK_SHORT" });
  await svc.Trip.transfer(trip._id, { toTripId: trip2._id, lines: [{ stockId: String(rice._id), qty: 5 }] }, "tester");
  assert.equal(await sellable(trip), before - 5);
  assert.equal(await sellable(trip2), 5);
  const onVans = await svc.Trip.withOnVans();
  assert.equal(onVans.get(String(rice._id)), before, "the two vans together hold what the first held");
  assert.equal((await svc.Stock.findById(rice._id)).currentStock, 100 - 13, "a transfer moves nothing in the books");
});

test("while the van is out, an invoice can still be taken back: the goods count as on the van again", { skip }, async () => {
  const before = await sellable(trip);
  await svc.Tx.deleteTransaction(invoiceB._id, by());
  assert.equal(await sellable(trip), before + 2);
});

test("once the van is counted in, nothing done on the trip can be taken back", { skip }, async () => {
  const t = await svc.Trip.getById(trip._id);
  await svc.Settle.unload(trip._id, { counts: t.sellable.map((l) => ({ stockId: l.stockId, good: l.qty, damaged: 0 })) }, by());
  await assert.rejects(() => svc.Tx.deleteTransaction(invoiceA._id, by()), { code: "VAN_TRIP_SETTLED" });
  await assert.rejects(() => svc.Fin.deleteVoucher(receiptA._id, by()), { code: "VAN_TRIP_SETTLED" });
  const plan = await svc.Settle.preview(trip._id, {});
  await svc.Settle.settle(trip._id, { acknowledge: plan.warnings.map((w) => w.code) }, by());
  await assert.rejects(() => svc.Tx.deleteTransaction(invoiceA._id, by()), { code: "VAN_TRIP_SETTLED" });
  assert.equal((await svc.Transaction.findById(invoiceA._id)).status, "APPROVED");
});

test("the report counts calls and the strike rate: two of three customers called on bought", { skip }, async () => {
  const r = await svc.Report.summary({});
  const row = r.rows.find((x) => x.tripNo === trip.tripNo);
  assert.equal(row.calls, 3);
  assert.equal(row.productive, 2);
  assert.equal(row.strikeRate, 66.7);
  assert.equal(r.bySalesman.find((s) => s.id === by()).strikeRate, 66.7);
});
