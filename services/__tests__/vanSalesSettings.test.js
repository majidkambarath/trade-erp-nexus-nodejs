// The organisation's rules for its vans, against a throwaway database: every default is what van sales did before, each
// rule refuses with its own code, a supervisor and a van's own override are honoured, and the three defects found on the
// way (a typed discount past the price check, the count dated the settlement day) stay fixed.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const inDays = (n) => new Date(Date.now() + n * 86400000);

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
    Plan: require("../vansales/vanPlanningService"),
    Link: require("../vansales/vanCustomerLinkService"),
    Settings: require("../vansales/vanSettingsService"),
    Chart: require("../financial/defaultChartService"),
    Transaction: require("../../models/modules/transactionModel"),
    VanTrip: require("../../models/modules/vansales/vanTripModel"),
    Voucher: require("../../models/modules/financial/financialModels").Voucher,
    Movement: require("../../models/modules/inventoryMovementModel"),
    CompanySettings: require("../../models/modules/financial/companySettingsModel"),
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

let salesman, A, B, C, rice, milk, route, van1, van2, trip1, trip2, invoiceC;
const by = () => String(salesman._id);
const SHOP = { lat: 25.2048, lng: 55.2708 };
const sellable = async (t) => (await svc.Trip.getById(t._id)).sellable.find((l) => l.stockId === String(rice._id))?.qty || 0;
const invoicesOn = (t) => svc.Transaction.countDocuments({ "vanTripRef.tripId": t._id });
const line = (extra = {}) => ({ itemId: rice._id, qty: 1, vatPercent: 0, ...extra });
const sell = (trip, customer, body = {}, opts = {}) => svc.Sales.sell(trip._id, { customerId: customer._id, items: [line()], ...body }, by(), opts);
const rules = (changes) => svc.Settings.save(changes);
const reset = () => rules({ customers: "any", creditSales: "allowed", priceChange: "up_only", maxDiscountPercent: 0, paymentModes: ["cash", "cheque"], returnsAllowed: true, transfersAllowed: true, captureLocation: true, farMetres: 300, expiryCheck: "warn", cashTolerance: 0, customerOrdering: true, maxOpenRequests: 3 });

test("setup: rice and milk bought in, three customers (one cash, one off the route), a route, two vans out", { skip }, async () => {
  salesman = await svc.Admin.create({ name: "Rashid", email: `rashid.settings.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Wholesale Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  const mk = (id, name, terms, shelf = 0) => svc.Customer.create({ customerId: id, customerName: name, contactPerson: name, phone: "0500000000", shippingAddress: "Dubai", paymentTerms: terms, minShelfLifeDays: shelf });
  [A, B, C] = await Promise.all([mk("C1", "Al Noor", "Net 30"), mk("C2", "Bin Zayed", "Cash", 10), mk("C3", "Corner Shop", "Net 30")]);
  const cat = await svc.Category.create({ name: "Food" });
  const item = (sku, name, price) => svc.StockService.createStock({ categoryId: cat._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku, itemName: name, salesPrice: price }, "tester");
  [rice, milk] = [await item("RICE", "Rice 5kg", 20), await item("MILK", "Milk 1L", 5)];
  const po = await svc.Tx.createTransaction({
    type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor",
    items: [
      { itemId: rice._id, description: "Rice", qty: 200, price: 10, vatPercent: 0 },
      { itemId: milk._id, description: "Milk", qty: 10, price: 3, vatPercent: 0, batchNumber: "M-SHORT", expiryDate: inDays(4) },
      { itemId: milk._id, description: "Milk", qty: 40, price: 3, vatPercent: 0, batchNumber: "M-LONG", expiryDate: inDays(60) },
    ],
  }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");
  route = await svc.Van.createRoute({ name: "North", customers: [{ customerId: String(A._id) }, { customerId: String(B._id) }] }, "tester");
  van1 = await svc.Van.create({ code: "VAN-1", name: "Van One", salesmanId: by(), defaultRouteId: route.id }, "tester");
  van2 = await svc.Van.create({ code: "VAN-2", name: "Van Two", salesmanId: by(), defaultRouteId: route.id }, "tester");
  for (const [van, qty] of [[van1, 60], [van2, 30]]) {
    const t = await svc.Trip.open({ vanId: van._id }, "tester");
    await svc.Trip.load(t._id, { lines: [{ stockId: String(rice._id), qty }] }, "tester");
    await svc.Trip.depart(t._id, "tester");
    if (van === van1) trip1 = t; else trip2 = t;
  }
});

test("with nothing saved the rules are the old ones: off-route and credit sales work, a typed price may go up but not down", { skip }, async () => {
  assert.equal(await svc.CompanySettings.countDocuments({ vanSales: { $exists: true } }), 0, "nothing stored yet");
  assert.deepEqual(await svc.Settings.settings(), require("../../utils/vanSettings").normaliseSettings({}));
  const off = await sell(trip1, C); // not on the route, on credit
  invoiceC = off.invoice;
  assert.equal(off.receipt, null);
  await sell(trip1, A, { items: [line({ price: 25 })] });
  const before = await sellable(trip1);
  await assert.rejects(() => sell(trip1, A, { items: [line({ price: 19 })] }), { code: "PRICE_BELOW_LIST", details: { stockId: String(rice._id), listPrice: 20 } });
  assert.equal(await sellable(trip1), before, "a refused sale takes nothing off the van");
});

test("the defect: a typed discount no longer gets past the price check; a supervisor may still give one", { skip }, async () => {
  const before = await sellable(trip1);
  await assert.rejects(() => sell(trip1, A, { items: [line({ price: 20, discountPercent: 50 })] }), { code: "DISCOUNT_TOO_HIGH" });
  await assert.rejects(() => sell(trip1, A, { items: [line({ discountPercent: -10 })] }), { code: "DISCOUNT_INVALID" }, "a negative discount used to RAISE the price");
  await assert.rejects(() => sell(trip1, A, { items: [line({ discountPercent: 101 })] }), { code: "DISCOUNT_INVALID" });
  assert.equal(await sellable(trip1), before);
  const given = await sell(trip1, A, { items: [line({ discountPercent: 10 })] }, { mayUnderprice: true });
  assert.equal(given.invoice.items[0].discountPercent, 10);
});

test("saving the rules: merged key by key, validated, stored under vanSales and nowhere else", { skip }, async () => {
  const one = await rules({ customers: "route" });
  assert.equal(one.customers, "route");
  assert.equal(one.farMetres, 300);
  const two = await rules({ farMetres: 500 });
  assert.equal(two.customers, "route", "a second save does not undo the first");
  assert.equal(two.farMetres, 500);
  await assert.rejects(() => rules({ paymentModes: ["online"] }), { code: "VAN_SETTING_INVALID" });
  await assert.rejects(() => rules({ farMetres: 1 }), { code: "VAN_SETTING_INVALID" });
  await assert.rejects(() => rules(null), { code: "VAN_SETTING_INVALID" });
  await assert.rejects(() => rules([]), { code: "VAN_SETTING_INVALID" });
  const doc = await svc.CompanySettings.findOne({}).lean();
  assert.equal(doc.vanSales.customers, "route");
  assert.equal(doc.vanSales.farMetres, 500);
  assert.equal((await svc.Trip.getById(trip1._id)).rules.customers, "route", "the trip carries the rules in force, read live");
  await reset();
});

test("only the customers on the route: sell, return and pre-order are refused off it, a supervisor is not", { skip }, async () => {
  await rules({ customers: "route" });
  const count = await invoicesOn(trip1);
  await assert.rejects(() => sell(trip1, C), { code: "CUSTOMER_NOT_ON_ROUTE" });
  assert.equal(await invoicesOn(trip1), count, "nothing was made");
  await sell(trip1, A);
  const supervisor = await sell(trip1, C, {}, { mayUnderprice: true });
  assert.ok(supervisor.invoice.transactionNo);
  await assert.rejects(() => svc.Sales.returnGoods(trip1._id, { customerId: C._id, returnOfId: invoiceC._id, lines: [{ itemId: rice._id, qty: 1 }] }, by()), { code: "CUSTOMER_NOT_ON_ROUTE" });
  await assert.rejects(() => svc.Sales.assertCustomerAllowed(trip1._id, C._id), { code: "CUSTOMER_NOT_ON_ROUTE" });
  await svc.Sales.assertCustomerAllowed(trip1._id, C._id, { mayOverride: true });
  await svc.Sales.assertCustomerAllowed(trip1._id, A._id);
  await reset();
  await sell(trip1, C);
});

test("sell for payment at the door: with no money, or only part of it, nothing is sold; cash terms ask only cash customers", { skip }, async () => {
  await rules({ creditSales: "never" });
  const count = await invoicesOn(trip1);
  const before = await sellable(trip1);
  await assert.rejects(() => sell(trip1, A), { code: "VAN_PAYMENT_REQUIRED" });
  await assert.rejects(() => sell(trip1, A, { payNow: { amount: 5 } }), { code: "VAN_PAYMENT_REQUIRED" }, "part of the invoice is not the whole");
  assert.equal(await invoicesOn(trip1), count, "the invoice made before the amount was known was rolled back");
  assert.equal(await sellable(trip1), before);
  const paid = await sell(trip1, A, { payNow: { full: true } });
  assert.equal(paid.receipt.paymentMode, "cash");
  assert.equal(await invoicesOn(trip1), count + 1);

  await rules({ creditSales: "cashTerms" });
  await assert.rejects(() => sell(trip1, B), { code: "VAN_PAYMENT_REQUIRED" }); // terms: Cash
  const credit = await sell(trip1, A); // terms: Net 30, may still buy on credit
  assert.equal(credit.receipt, null);
  await sell(trip1, B, { payNow: { full: true } });
  await reset();
});

test("locked prices: the list price only; free prices: anything; a supervisor is never held", { skip }, async () => {
  await rules({ priceChange: "locked" });
  await assert.rejects(() => sell(trip1, A, { items: [line({ price: 25 })] }), { code: "PRICE_LOCKED" });
  await assert.rejects(() => sell(trip1, A, { items: [line({ price: 19 })] }), { code: "PRICE_LOCKED" });
  await sell(trip1, A, { items: [line({ price: 20 })] });
  await sell(trip1, A, { items: [line({ price: 5 })] }, { mayUnderprice: true });
  await rules({ priceChange: "free" });
  await sell(trip1, A, { items: [line({ price: 1 })] });
  await rules({ priceChange: "up_only", maxDiscountPercent: 10 });
  await sell(trip1, A, { items: [line({ discountPercent: 10 })] });
  await assert.rejects(() => sell(trip1, A, { items: [line({ discountPercent: 10.5 })] }), { code: "DISCOUNT_TOO_HIGH" });
  await reset();
});

test("the ways of taking money: a mode the organisation switched off is refused at the sale and at a collection", { skip }, async () => {
  await rules({ paymentModes: ["cash"] });
  await assert.rejects(() => sell(trip1, A, { payNow: { full: true, mode: "cheque", details: {} } }), { code: "VAN_MODE_NOT_ALLOWED", details: { allowed: ["cash"] } });
  await assert.rejects(() => svc.Sales.collect(trip1._id, { customerId: A._id, amount: 10, mode: "cheque", details: {} }, by()), { code: "VAN_MODE_NOT_ALLOWED" });
  const taken = await svc.Sales.collect(trip1._id, { customerId: A._id, amount: 10, mode: "cash" }, by());
  assert.equal(taken.receipt.paymentMode, "cash");
  await reset();
});

test("goods taken back, and goods handed to another van, can be switched off", { skip }, async () => {
  await rules({ returnsAllowed: false });
  await assert.rejects(() => svc.Sales.returnGoods(trip1._id, { customerId: A._id }, by()), { code: "VAN_RETURNS_OFF" });
  await reset();
  await assert.rejects(() => svc.Sales.returnGoods(trip1._id, { customerId: A._id }, by()), { code: "RETURN_LINK_REQUIRED" }, "on: the ordinary checks follow");

  await rules({ transfersAllowed: false });
  await assert.rejects(() => svc.Trip.transfer(trip1._id, { toTripId: trip2._id, lines: [{ stockId: String(rice._id), qty: 1 }] }, by()), { code: "VAN_TRANSFERS_OFF" });
  await reset();
  const { from } = await svc.Trip.transfer(trip1._id, { toTripId: trip2._id, lines: [{ stockId: String(rice._id), qty: 1 }] }, by());
  assert.equal(from.loads.at(-1).kind, "transfer_out");
});

test("a van's own rules win over the organisation's, live, and can be cleared", { skip }, async () => {
  await rules({ creditSales: "never" });
  await assert.rejects(() => sell(trip1, A), { code: "VAN_PAYMENT_REQUIRED" });
  const own = await svc.Van.update(van2.id, { name: "Van Two", rules: { creditSales: "allowed" } }, "tester");
  assert.equal(own.rules.creditSales, "allowed");
  const done = await sell(trip2, A);
  assert.equal(done.receipt, null, "van two sells on credit while the organisation does not");
  assert.equal((await svc.Trip.getById(trip2._id)).rules.creditSales, "allowed");
  assert.equal((await svc.Trip.getById(trip1._id)).rules.creditSales, "never");
  await assert.rejects(() => svc.Van.update(van2.id, { name: "Van Two", rules: { customers: "everyone" } }, "tester"), { code: "VAN_SETTING_INVALID" });
  assert.equal((await svc.Van.get(van2.id)).rules.creditSales, "allowed", "a refused change stored nothing");
  await svc.Van.update(van2.id, { name: "Van Two renamed" }, "tester");
  assert.equal((await svc.Van.get(van2.id)).rules.creditSales, "allowed", "an edit that names no rules leaves them alone");
  const cleared = await svc.Van.update(van2.id, { name: "Van Two", rules: { creditSales: "org" } }, "tester");
  assert.equal(cleared.rules, undefined, "back to following the organisation");
  await assert.rejects(() => sell(trip2, A), { code: "VAN_PAYMENT_REQUIRED" });
  await svc.Van.update(van2.id, { name: "Van Two" }, "tester");
  await reset();
  assert.equal((await svc.Van.get(van1.id)).rules, undefined, "a van that never set any holds none");
});

test("where the phone was: the distance that counts as far is the organisation's, and location can be switched off", { skip }, async () => {
  await svc.Fleet.pinCustomer(trip1._id, A._id, SHOP, by());
  const here = { lat: SHOP.lat + 0.0036, lng: SHOP.lng, accuracy: 10 }; // about 400 m north
  const lastPing = async () => (await svc.VanTrip.findById(trip1._id)).pings.at(-1);
  await sell(trip1, A, { location: here });
  assert.equal((await lastPing()).far, true, "400 m is far at the default 300 m");
  await rules({ farMetres: 1000 });
  await sell(trip1, A, { location: here });
  assert.equal((await lastPing()).far, false, "and not far at 1,000 m");
  await rules({ captureLocation: false });
  const pings = (await svc.VanTrip.findById(trip1._id)).pings.length;
  await sell(trip1, A, { location: here });
  assert.equal((await svc.VanTrip.findById(trip1._id)).pings.length, pings, "no location is kept");
  const visit = await svc.Visits.record(trip1._id, { customerId: A._id, reason: "closed", location: here }, by(), "Rashid");
  assert.equal(visit.location?.lat, undefined, "the visit keeps no location either");
  await assert.rejects(() => svc.Fleet.pinCustomer(trip1._id, B._id, SHOP, by()), { code: "LOCATION_OFF" });
  await reset();
});

test("the expiry check: warn tells, block refuses short-dated stock (a supervisor may load it), off says nothing", { skip }, async () => {
  const lines = [{ stockId: String(milk._id), qty: 15 }];
  const warned = await svc.Plan.loadCheck(trip1._id, { lines });
  assert.equal(warned.mode, "warn");
  assert.equal(warned.warnings.length, 1, "customers on the route ask for 10 days; 10 of the 15 expire in 4");
  await svc.Plan.assertExpiryOk(trip1._id, { lines });
  await rules({ expiryCheck: "block" });
  await assert.rejects(() => svc.Plan.assertExpiryOk(trip1._id, { lines }), { code: "EXPIRY_SOON" });
  await svc.Plan.assertExpiryOk(trip1._id, { lines }, { mayOverride: true });
  await svc.Plan.assertExpiryOk(trip1._id, { lines: [{ stockId: String(rice._id), qty: 5 }] }); // nothing short-dated: not refused
  await rules({ expiryCheck: "off" });
  const off = await svc.Plan.loadCheck(trip1._id, { lines });
  assert.deepEqual([off.mode, off.warnings], ["off", []]);
  await reset();
});

test("the customer's own link: ordering can be switched off, and the number of waiting requests is the organisation's", { skip }, async () => {
  const link = { sourceType: "Transaction", sourceId: invoiceC._id, companyId: "default", branchId: "main" };
  const page = await svc.Link.view({ ...link, sourceId: (await sell(trip1, A)).invoice._id });
  assert.equal(page.canRequest, true);
  const linkA = { ...link, sourceId: (await svc.Transaction.findOne({ "vanTripRef.tripId": trip1._id, partyId: A._id }))._id };
  await rules({ customerOrdering: false });
  const closed = await svc.Link.view(linkA);
  assert.deepEqual([closed.canRequest, closed.items], [false, []]);
  assert.ok(closed.statement, "what they owe is still shown");
  await assert.rejects(() => svc.Link.request(linkA, { lines: [{ stockId: String(rice._id), qty: 2 }] }), { code: "VAN_ORDERING_OFF" });
  await rules({ customerOrdering: true, maxOpenRequests: 1 });
  await svc.Link.request(linkA, { lines: [{ stockId: String(rice._id), qty: 2 }] });
  await assert.rejects(() => svc.Link.request(linkA, { lines: [{ stockId: String(rice._id), qty: 2 }] }), { code: "REQUEST_LIMIT" });
  await rules({ maxOpenRequests: 2 });
  await svc.Link.request(linkA, { lines: [{ stockId: String(rice._id), qty: 2 }] });
  await reset();
});

test("settlement: a cash difference inside the tolerance needs no tick but still posts; the count is dated the count day", { skip }, async () => {
  await svc.Settings.save({ creditSales: "allowed" });
  const taken = await sell(trip2, B, { payNow: { full: true } }); // 20 in cash on van two
  assert.equal(taken.receipt.totalAmount, 20);
  const t = await svc.Trip.getById(trip2._id);
  const one = t.sellable.find((l) => l.stockId === String(rice._id)).qty;
  await svc.Settle.unload(trip2._id, { counts: [{ stockId: String(rice._id), good: one - 1, damaged: 0 }] }, by());
  const strict = await svc.Settle.preview(trip2._id, { cashHanded: 19.5 });
  assert.ok(strict.warnings.some((w) => w.code === "CASH_SHORT"), "by default any difference needs a tick");
  await rules({ cashTolerance: 1 });
  const relaxed = await svc.Settle.preview(trip2._id, { cashHanded: 19.5 });
  assert.ok(!relaxed.warnings.some((w) => w.code === "CASH_SHORT"));
  assert.equal(relaxed.cash.short, 0.5, "it is still worked out, and still posted to the shortage account");
  assert.ok(relaxed.warnings.some((w) => w.code === "STOCK_DIFFERENCE"), "the stock count is not covered by the cash tolerance");
  await rules({ cashTolerance: 0.4 });
  assert.ok((await svc.Settle.preview(trip2._id, { cashHanded: 19.5 })).warnings.some((w) => w.code === "CASH_SHORT"), "just over the tolerance: ticked again");
  await rules({ cashTolerance: 1 });

  // the day the van was counted back in: yesterday, unless that is another year (no fiscal year to post into there)
  const now = new Date();
  let counted = new Date(now.getTime() - 86400000);
  if (counted.getUTCFullYear() !== now.getUTCFullYear()) counted = now;
  await svc.VanTrip.updateOne({ _id: trip2._id }, { $set: { "unload.at": counted } });
  const { trip } = await svc.Settle.settle(trip2._id, { cashHanded: 19.5, acknowledge: ["STOCK_DIFFERENCE"] }, by());
  assert.equal(trip.status, "SETTLED");
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  const moves = await svc.Movement.find({ referenceNumber: trip2.tripNo, eventType: "STOCK_ADJUSTMENT" }).lean();
  assert.equal(moves.length, 1);
  assert.equal(day(moves[0].date), day(counted), "the stock difference is dated the day it was counted");
  const journal = await svc.Voucher.findById(trip.settlement.voucherIds[0]).lean();
  assert.equal(day(journal.date), day(now), "the cash journal is the hand-in, dated today");
  await reset();
});
