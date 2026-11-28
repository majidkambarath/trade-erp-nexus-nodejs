// The van analysis reports against a throwaway database: two vans, settled trips and one still out, sales, an old debt
// collected on the road, a damaged and expired return, road expenses and a garage bill the office tagged to a van. Each
// report is checked against figures worked out by hand, and the scorecard against the route profit report.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_van_${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;

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
    Fleet: require("../vansales/vanFleetService"),
    Report: require("../vansales/vanSalesReportService"),
    Analysis: require("../vansales/vanAnalysisService"),
    Fin: require("../financial/financialService"),
    Accounts: require("../financial/chartOfAccountsService"),
    Chart: require("../financial/defaultChartService"),
    Organisation: require("../../models/core/organisationModel"),
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
  await svc.Organisation.updateOne({ code: "default" }, { $set: { moduleOverrides: { vansales: true } } });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const today = () => require("../../utils/documentExpiry").todayInOrg();
const pick = (o, ...keys) => keys.map((k) => o[k]);
const all = { showCost: true };
let rashid, omar, A, B, C, D, milk, rice, route, van1, van2, trip1;
const by = () => String(rashid._id);
const period = (extra = {}) => ({ from: today(), to: today(), ...extra });

test("setup: two vans' day", { skip }, async () => {
  const mkAdmin = (name) => svc.Admin.create({ name, email: `${name.toLowerCase()}-an.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  rashid = await mkAdmin("Rashid");
  omar = await mkAdmin("Omar");
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Wholesale Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  const mk = (id, name) => svc.Customer.create({ customerId: id, customerName: name, contactPerson: name, phone: "0500000000", shippingAddress: "Dubai", paymentTerms: "Net 30" });
  A = await mk("C1", "Al Noor");
  B = await mk("C2", "Bin Zayed");
  C = await mk("C3", "Corner Shop");
  D = await mk("C4", "Dune Market");
  const dairy = await svc.Category.create({ name: "Dairy" });
  const grocery = await svc.Category.create({ name: "Grocery" });
  const item = (sku, itemName, salesPrice, categoryId) => svc.StockService.createStock({ categoryId, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku, itemName, salesPrice }, "tester");
  milk = await item("MILK", "Milk 1L", 10, dairy._id);
  rice = await item("RICE", "Rice 5kg", 20, grocery._id);
  const po = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: milk._id, description: "Milk", qty: 60, price: 5, vatPercent: 0 }, { itemId: rice._id, description: "Rice", qty: 20, price: 10, vatPercent: 0 }] }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");
  const yesterday = new Date(Date.parse(`${today()}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const old = await svc.Tx.createTransaction({ type: "sales_order", partyId: A._id, partyType: "Customer", partyTypeRef: "Customer", date: yesterday, items: [{ itemId: rice._id, description: "Rice", qty: 5, price: 20, vatPercent: 0 }] }, "tester");
  await svc.Tx.processTransaction(old._id, "approve", "tester");

  route = await svc.Van.createRoute({ name: "North", customers: [A, B, C, D].map((c) => ({ customerId: String(c._id) })) }, "tester");
  van1 = await svc.Van.create({ code: "VAN-1", name: "Van One", salesmanId: by(), defaultRouteId: route.id }, "tester");
  van2 = await svc.Van.create({ code: "VAN-2", name: "Van Two", salesmanId: String(omar._id) }, "tester");
  const open = async (van, lines, km) => {
    const t = await svc.Trip.open({ vanId: van._id ?? van.id }, "tester");
    await svc.Trip.load(t._id, { lines: lines.map(([s, qty]) => ({ stockId: String(s._id), qty })) }, "tester");
    await svc.Trip.depart(t._id, "tester", { odometer: km });
    return t;
  };
  const sell = (trip, customer, items, extra = {}, who = by()) => svc.Sales.sell(trip._id, { customerId: customer._id, items: items.map(([s, qty]) => ({ itemId: s._id, qty, vatPercent: 0 })), ...extra }, who);

  // van 1's day: a part-paid sale, an old debt collected, a credit sale, a closed shop, a return, fuel and a toll
  trip1 = await open(van1, [[milk, 30], [rice, 10]], 1000);
  await sell(trip1, A, [[milk, 10], [rice, 2]], { payNow: { mode: "cash", amount: 100 } });
  await svc.Sales.collect(trip1._id, { customerId: A._id, amount: 100, mode: "cash", invoiceIds: [String(old._id)] }, by());
  await sell(trip1, B, [[milk, 5]]);
  await svc.Visits.record(trip1._id, { customerId: C._id, reason: "closed" }, by());
  await svc.Sales.returnItems(trip1._id, { customerId: A._id, lines: [{ stockId: String(milk._id), qty: 2, condition: "damaged" }, { stockId: String(milk._id), qty: 1, condition: "expired" }], reason: "Expired" }, by());
  await svc.Fleet.expense(trip1._id, { kind: "fuel", amount: 40 }, by());
  await svc.Fleet.expense(trip1._id, { kind: "toll", amount: 8 }, by());
  await svc.Settle.unload(trip1._id, { odometer: 1100, counts: [{ stockId: String(milk._id), good: 13, damaged: 3, expired: 1 }, { stockId: String(rice._id), good: 8, damaged: 0 }] }, "tester");
  const plan = await svc.Settle.preview(trip1._id, { cashHanded: 150 });
  await svc.Settle.settle(trip1._id, { cashHanded: 150, acknowledge: plan.warnings.map((w) => w.code) }, by()); // the journal is a person's
  await svc.VanTrip.updateOne({ _id: trip1._id }, { departedAt: new Date(Date.now() - 5 * 3600000), "unload.at": new Date() });

  // van 2's day, with a garage bill the office tagged to it
  const trip2 = await open(van2, [[milk, 10]], 500);
  await sell(trip2, C, [[milk, 4]], { payNow: { mode: "cash", full: true } }, String(omar._id));
  await svc.Settle.unload(trip2._id, { odometer: 540, counts: [{ stockId: String(milk._id), good: 6, damaged: 0 }] }, "tester");
  await svc.Settle.settle(trip2._id, { cashHanded: 40 }, by());
  const account = String((await svc.Accounts.listPostable()).find((a) => a.category === "EXPENSE")._id);
  await svc.Fin.createVoucher({ voucherType: "expense", ledgerBased: true, expenseAccountId: account, description: "Gearbox", amount: 300, paymentMode: "cash", vanId: String(van2.id ?? van2._id), vanExpenseKind: "mechanical" }, by());

  // van 1 out again, not yet settled
  const trip3 = await open(van1, [[milk, 5]]);
  await sell(trip3, A, [[milk, 1]]);
});

test("the scorecard: each van's day, the office bill on van 2, the trip still out left out, and the same figures as route profit", { skip }, async () => {
  const r = await svc.Analysis.vans(period(), all);
  assert.deepEqual([r.officeExpenses, r.costHidden, r.unsettled], ["included", false, 1]);
  const [one, two] = ["VAN-1", "VAN-2"].map((c) => r.rows.find((x) => x.vanCode === c));
  assert.deepEqual(pick(one, "allTrips", "trips", "km", "sales", "returns", "netSales", "grossMargin"), [2, 1, 100, 190, 30, 160, 80]);
  assert.deepEqual(pick(one, "damagedValue", "expiredValue", "differenceValue", "road", "office", "cashVariance", "contribution"), [15, 5, -5, 48, 0, -2, 5]);
  assert.deepEqual([one.returnsPct, one.costPerKm, one.byKind.fuel, one.byKind.toll], [15.8, 0.48, 40, 8]);
  assert.deepEqual(pick(two, "netSales", "office", "expenses", "contribution", "km", "costPerKm"), [40, 300, 300, -280, 40, 7.5]);
  assert.equal(two.byKind.mechanical, 300);
  assert.equal(r.total.netSales, 200);
  assert.equal(r.rows[0].vanCode, "VAN-1", "best contribution first");

  const route = await svc.Report.routeProfit({ from: today(), to: today() });
  const north = route.rows.find((x) => x.name === "North");
  assert.deepEqual([north.netSales, north.grossMargin, north.expenses, north.contribution], [160, 80, 48, 5], "the two reports agree");
});

test("expenses: road and office by type, per km, and a salesman reads only his own trips' expenses", { skip }, async () => {
  const r = await svc.Analysis.expenses(period(), all);
  assert.deepEqual(r.kinds.map((k) => [k.kind, k.net]), [["mechanical", 300], ["fuel", 40], ["toll", 8]]);
  assert.equal(r.kinds[0].perKm, 2.14);
  assert.deepEqual(r.vans.map((v) => [v.vanCode, v.road, v.office, v.perKm]), [["VAN-2", 0, 300, 7.5], ["VAN-1", 48, 0, 0.48]]);
  assert.deepEqual([r.total.net, r.total.count, r.pending.count, r.rows.length, r.truncated], [348, 3, 0, 3, false]);
  assert.deepEqual(r.rows.map((x) => x.source).sort(), ["office", "road", "road"]);

  const mine = await svc.Analysis.expenses(period(), { onlySalesman: String(omar._id), showCost: true });
  assert.deepEqual([mine.officeExpenses, mine.total.net, mine.rows.length], ["hidden_seller", 0, 0]);
  const north = await svc.Analysis.expenses(period({ routeId: String(route.id) }), all);
  assert.deepEqual([north.officeExpenses, north.total.net], ["hidden_filter", 48]);
  const justTwo = await svc.Analysis.expenses(period({ vanId: String(van2.id ?? van2._id) }), all);
  assert.equal(justTwo.total.net, 300);
});

test("returns and losses: who sent goods back, what share of sales, what was lost, and what spoiled on the van", { skip }, async () => {
  const r = await svc.Analysis.returns(period(), all);
  assert.deepEqual(pick(r.total, "count", "qty", "credit", "damagedQty", "expiredQty", "lossValue"), [1, 3, 30, 2, 1, 15]);
  assert.deepEqual(r.groups.customer.map((x) => [x.name, x.credit, x.pct]), [["Al Noor", 30, 20]]);
  assert.deepEqual(r.groups.item.map((x) => [x.name, x.sales, x.pct]), [["Milk 1L", 200, 15]]);
  assert.deepEqual(r.groups.reason.map((x) => [x.name, x.pct]), [["Expired", 12.5]]);
  assert.deepEqual(r.onVan.map((x) => [x.vanCode, x.itemName, x.damagedQty, x.expiredQty, x.lossValue]), [["VAN-1", "Milk 1L", 1, 0, 5]]);
});

test("trend, items, loads, collections and coverage add up from the same documents", { skip }, async () => {
  const trend = await svc.Analysis.trend(period({ months: "6" }), all);
  assert.equal(trend.months.length, 6);
  const now = trend.fleet.rows[5];
  assert.deepEqual([now.netSales, now.grossMargin, now.lossValue, now.expenses, now.contribution], [200, 100, 25, 348, -275]);

  const items = await svc.Analysis.items(period(), all);
  assert.deepEqual(items.rows.map((x) => [x.name, x.qty, x.netSales]), [["Milk 1L", 17, 170], ["Rice 5kg", 2, 40]]);
  const customers = await svc.Analysis.items(period({ by: "customer" }), all);
  assert.deepEqual(customers.rows.map((x) => [x.name, x.netSales]), [["Al Noor", 120], ["Bin Zayed", 50], ["Corner Shop", 40]]);
  const routes = await svc.Analysis.items(period({ by: "route" }), all);
  assert.deepEqual(routes.rows.map((x) => [x.name, x.netSales]), [["North", 170], ["No route", 40]]);

  const load = await svc.Analysis.load(period(), all);
  const l1 = load.rows.find((x) => x.name.startsWith("VAN-1"));
  assert.deepEqual(pick(l1, "trips", "uncounted", "loaded", "sold", "good", "damaged", "expired", "differenceUnits", "differenceValue", "backValue", "sellThrough"), [1, 1, 40, 17, 21, 3, 1, -1, -5, 145, 42.5]);

  const money = await svc.Analysis.collections(period(), all);
  const m1 = money.rows.find((x) => x.name.startsWith("VAN-1"));
  assert.deepEqual(pick(m1, "invoiced", "atDoor", "onCredit", "oldCollected", "cash", "collected", "openNow", "cashShort"), [200, 100, 100, 100, 200, 200, 70, 2]);
  assert.deepEqual(money.days, [{ day: today(), short: 2, over: 0 }]);

  const cover = await svc.Analysis.coverage(period(), all);
  const c1 = cover.rows.find((x) => x.name.startsWith("VAN-1"));
  assert.deepEqual(pick(c1, "trips", "planned", "calledOnRoute", "called", "bought", "coveragePct", "strikeRate", "hours", "salesPerHour"), [2, 8, 4, 4, 3, 50, 75, 5, 32]);
  assert.match(c1.firstSale, /^\d\d:\d\d$/);
  assert.deepEqual(cover.reasons, [{ reason: "closed", count: 1 }]);
  assert.deepEqual(cover.notCalled.map((x) => [x.name, x.routeName]), [["Dune Market", "North"]]);
});

test("without the cost permission no cost-made figure is sent; the choices are narrowed for a salesman", { skip }, async () => {
  for (const report of ["vans", "expenses", "returns", "trend", "items", "load", "collections", "coverage"]) {
    const r = await svc.Analysis[report](period(), { showCost: false });
    assert.equal(r.costHidden, true, report);
    const text = JSON.stringify(r);
    for (const field of ["cost", "grossMargin", "contribution", "lossValue", "damagedValue", "backValue"]) assert.equal(text.includes(`"${field}"`), false, `${report} ${field}`);
  }
  const everyone = await svc.Analysis.choices(all);
  assert.deepEqual([everyone.vans.map((v) => v.code), everyone.salesmen.map((s) => s.name), everyone.routes.map((x) => x.name)], [["VAN-1", "VAN-2"], ["Omar", "Rashid"], ["North"]]);
  const omars = await svc.Analysis.choices({ onlySalesman: String(omar._id) });
  assert.deepEqual([omars.vans.map((v) => v.code), omars.salesmen.map((s) => s.name)], [["VAN-2"], ["Omar"]]);
  await assert.rejects(() => svc.Analysis.vans({ from: "2026-13-01" }, all), { code: "INVALID_DATE" });
});
