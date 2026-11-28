// A van with NO route, against a throwaway database: the salesman loads at the warehouse and sells to any shop he
// finds. 250 customers, so the one he sells to is past the 200 a plain list returns; found by name and by phone
// digits; his own shops (sold to, visited) are what his phone carries offline, priced with one price-list read; a pin,
// an order for next time and the next suggested load all work with no route; a "route only" van cannot go out
// without one.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vnr_${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;

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
    Plan: require("../vansales/vanPlanningService"),
    Fleet: require("../vansales/vanFleetService"),
    Visits: require("../vansales/vanVisitService"),
    Prices: require("../vansales/priceListService"),
    Settings: require("../vansales/vanSettingsService"),
    VanCustomers: require("../vansales/vanCustomers"),
    Chart: require("../financial/defaultChartService"),
    Stock: require("../../models/modules/stockModel"),
    TradeOrder: require("../../models/modules/tradeOrderModel"),
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

let salesman, rice, van, trip1, trip2, shops;
const by = () => String(salesman._id);
const pad = (n) => String(n).padStart(3, "0");
const shop = (n) => shops[n - 1];

test("setup: rice in the warehouse, 250 shops, a van with no route", { skip }, async () => {
  salesman = await svc.Admin.create({ name: "Rashid", email: `rashid.nr.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Wholesale Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  shops = await svc.Customer.insertMany(Array.from({ length: 250 }, (_, i) => ({
    customerId: `C${pad(i + 1)}`, customerName: `Shop ${pad(i + 1)}`, contactPerson: "x", phone: `+971500000${pad(i + 1)}`,
    shippingAddress: "Dubai", paymentTerms: "Net 30",
  })));
  const cat = await svc.Category.create({ name: "Food" });
  rice = await svc.StockService.createStock({ categoryId: cat._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku: "RICE", itemName: "Rice 5kg", salesPrice: 20 }, "tester");
  const po = await svc.Tx.createTransaction({
    type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor",
    items: [{ itemId: rice._id, description: "Rice", qty: 200, price: 10, vatPercent: 0 }],
  }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");
  van = await svc.Van.create({ code: "VAN-7", name: "Van Seven", salesmanId: by() }, "tester");
});

test("a van that may sell only to its route's customers cannot go out with no route", { skip }, async () => {
  await svc.Settings.save({ customers: "route" });
  await assert.rejects(() => svc.Trip.open({ vanId: van._id }, "tester"), { code: "ROUTE_REQUIRED" });
  await svc.Settings.save({ customers: "any" });
  trip1 = await svc.Trip.open({ vanId: van._id }, "tester");
  assert.equal(trip1.routeId, null);
  await svc.Trip.load(trip1._id, { lines: [{ stockId: String(rice._id), qty: 60 }] }, "tester");
  await svc.Trip.depart(trip1._id, "tester");
});

test("any shop can be found: past the first 200, by name, by code and by the phone's digits", { skip }, async () => {
  const plain = await svc.Van.customerChoices({});
  assert.equal(plain.length, 200, "a plain list stops at 200 (the reason a search is needed)");
  assert.ok(!plain.some((c) => c.name === "Shop 230"));
  const byName = await svc.Sales.shops(trip1._id, { search: "Shop 230" });
  assert.deepEqual(byName.shops.map((s) => s.name), ["Shop 230"]);
  const byCode = await svc.Sales.shops(trip1._id, { search: "C231" });
  assert.deepEqual(byCode.shops.map((s) => s.name), ["Shop 231"]);
  const byPhone = await svc.Sales.shops(trip1._id, { search: "050 000 0232" });
  assert.deepEqual(byPhone.shops.map((s) => s.name), ["Shop 232"], "typed the local way, stored as +971...");
  const none = await svc.Sales.shops(trip1._id, {});
  assert.deepEqual(none.shops, [], "a new van with no route has no shops of its own yet");
  assert.equal(byName.shops[0].mine, false);
});

test("the shops it sold to and called on become the van's own, the most recent first", { skip }, async () => {
  await svc.Sales.sell(trip1._id, { customerId: shop(230)._id, items: [{ itemId: rice._id, qty: 10, vatPercent: 0 }] }, by());
  await svc.Visits.record(trip1._id, { customerId: shop(7)._id, reason: "closed" }, by());
  await svc.Sales.sell(trip1._id, { customerId: shop(120)._id, items: [{ itemId: rice._id, qty: 5, vatPercent: 0 }] }, by());
  const mine = await svc.VanCustomers.vanCustomers(van._id);
  assert.deepEqual(mine.map((m) => m.customerId), [shop(120), shop(7), shop(230)].map((s) => String(s._id)));
  const list = await svc.Sales.shops(trip1._id, {});
  assert.deepEqual(list.shops.map((s) => [s.name, s.mine]), [["Shop 120", true], ["Shop 007", true], ["Shop 230", true]]);
  // a search puts the van's own shops first
  const found = await svc.Sales.shops(trip1._id, { search: "Shop 12" });
  assert.equal(found.shops[0].name, "Shop 120");
  assert.equal(found.shops[0].mine, true);
});

test("with no signal the phone carries the van's own shops, each priced, with one price-list read", { skip }, async () => {
  await svc.Prices.create({ name: "Shop 230 special", customerIds: [String(shop(230)._id)], lines: [{ stockId: String(rice._id), price: 18 }] }, "tester");
  const pack = await svc.Sales.offlinePack(trip1._id, { extraCustomerIds: [String(shop(245)._id)] });
  const names = pack.customers.map((c) => c.name);
  assert.deepEqual(names, ["Shop 245", "Shop 120", "Shop 007", "Shop 230"], "the one he asked for, then his own shops");
  assert.equal(pack.prices[String(shop(230)._id)][String(rice._id)], 18, "the customer's own list");
  assert.equal(pack.prices[String(shop(120)._id)][String(rice._id)], 20, "else the item's price");
  // the batch read gives exactly what the one-by-one read gives
  const one = await svc.Prices.pricesFor({ customerId: shop(230)._id, items: [{ stockId: rice._id, qty: 1, itemPrice: 20 }] });
  const many = await svc.Prices.pricesForCustomers({ customerIds: [shop(230)._id, shop(120)._id], items: [{ stockId: rice._id, qty: 1, itemPrice: 20 }] });
  assert.deepEqual(many.get(String(shop(230)._id)).get(String(rice._id)), one.get(String(rice._id)));
  assert.ok(pack.insight[String(shop(230)._id)].lastOrder, "what they bought last is there too");
});

test("with no route a shop is pinned once from the van; moving it is a supervisor's call", { skip }, async () => {
  const pinned = await svc.Fleet.pinCustomer(trip1._id, shop(230)._id, { lat: 25.2, lng: 55.3 }, by());
  assert.equal(pinned.customerName, "Shop 230");
  await assert.rejects(() => svc.Fleet.pinCustomer(trip1._id, shop(230)._id, { lat: 25.3, lng: 55.4 }, by()), { code: "LOCATION_ALREADY_SET" });
  await svc.Fleet.pinCustomer(trip1._id, shop(230)._id, { lat: 25.3, lng: 55.4 }, by(), { mayRepin: true });
});

test("the expiry check reads the shelf life the van's own shops ask for", { skip }, async () => {
  await svc.Customer.updateOne({ _id: shop(120)._id }, { $set: { minShelfLifeDays: 15 } });
  const check = await svc.Plan.loadCheck(trip1._id, { lines: [{ stockId: String(rice._id), qty: 1 }] });
  assert.equal(check.shelfLifeDays, 15);
});

test("an order for next time is kept by van, for tomorrow or the day the salesman names", { skip }, async () => {
  const order = await svc.Plan.createPreorder(trip1._id, { customerId: shop(7)._id, items: [{ itemId: rice._id, qty: 4 }] }, by());
  assert.equal(order.status, "CONFIRMED");
  assert.equal(String(order.source.vanId), String(van._id));
  assert.equal(order.source.routeId, undefined);
  await assert.rejects(() => svc.Plan.createPreorder(trip1._id, { customerId: shop(7)._id, items: [{ itemId: rice._id, qty: 1 }], expectedDate: "next week" }, by()), { code: "INVALID_DATE" });
  await assert.rejects(() => svc.Plan.createPreorder(trip1._id, { customerId: shop(7)._id, items: [{ itemId: rice._id, qty: 1 }], expectedDate: "2020-02-30" }, by()), { code: "INVALID_DATE" });
  // a day that does not exist, inside the 90 days: refused for not being a day, not for being out of range
  const { todayInOrg } = require("../../utils/documentExpiry");
  const noSuchDay = `${require("../../utils/vanSales").addDays(todayInOrg(), 10).slice(0, 7)}-32`;
  await assert.rejects(() => svc.Plan.createPreorder(trip1._id, { customerId: shop(7)._id, items: [{ itemId: rice._id, qty: 1 }], expectedDate: noSuchDay }, by()), { code: "INVALID_DATE" });
  const named = await svc.Plan.createPreorder(trip1._id, { customerId: shop(7)._id, items: [{ itemId: rice._id, qty: 2 }], expectedDate: require("../../utils/vanSales").addDays(todayInOrg(), 3) }, by());
  assert.equal(new Date(named.expectedDate).toISOString().slice(0, 10), require("../../utils/vanSales").addDays(todayInOrg(), 3), "the day the salesman named");
  await svc.TradeOrder.deleteOne({ _id: named._id });
  const list = await svc.Plan.preordersForTrip(trip1._id);
  assert.deepEqual(list.map((p) => [p.customerName, p.items[0].qty]), [["Shop 007", 4]]);
});

const settleTrip = async (t1, salesmanId) => {
  const t = await svc.Trip.getById(t1._id);
  await svc.Settle.unload(t1._id, { counts: t.sellable.map((l) => ({ stockId: l.stockId, good: l.qty, damaged: 0 })) }, salesmanId);
  const plan = await svc.Settle.preview(t1._id, {});
  await svc.Settle.settle(t1._id, { cashHanded: plan.cash.expected, acknowledge: plan.warnings.map((w) => w.code) }, salesmanId);
};

test("after the first trip is settled, the next load is suggested from the van's own last trip and its orders", { skip }, async () => {
  await settleTrip(trip1, by());
  // another van with no route sells a different amount: its trip must not be counted as this van's history
  const other = await svc.Admin.create({ name: "Maya", email: `maya.nr.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  const van2 = await svc.Van.create({ code: "VAN-8", name: "Van Eight", salesmanId: String(other._id) }, "tester");
  const tripB = await svc.Trip.open({ vanId: van2._id }, "tester");
  await svc.Trip.load(tripB._id, { lines: [{ stockId: String(rice._id), qty: 50 }] }, "tester");
  await svc.Trip.depart(tripB._id, "tester");
  await svc.Sales.sell(tripB._id, { customerId: shop(9)._id, items: [{ itemId: rice._id, qty: 45, vatPercent: 0 }] }, String(other._id));
  await settleTrip(tripB, String(other._id));

  trip2 = await svc.Trip.open({ vanId: van._id }, "tester");
  const s = await svc.Plan.suggestedLoad(trip2._id);
  assert.equal(s.runs, 1, "learnt from this van's last trip, not from a route nor from another van");
  const r = s.lines.find((l) => l.stockId === String(rice._id));
  assert.deepEqual([r.why.preorder, r.why.average], [4, 15], "15 sold last trip + 4 ordered");
  // and the other van's own shops are its own
  const shopsB = await svc.VanCustomers.vanCustomers(van2._id);
  assert.deepEqual(shopsB.map((c) => c.customerId), [String(shop(9)._id)]);
});
