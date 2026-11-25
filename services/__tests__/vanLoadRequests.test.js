// A van load the salesman asks for, the storekeeper loads and the salesman accepts, against a throwaway database.
//
//   off by default   loading is exactly as before; a request is refused
//   on               no direct loads; REQUESTED -> LOADED (what really went on, which may differ) -> ACCEPTED (what the
//                    salesman counted: only that is on his van). While LOADED the goods are off the depot's shelf for
//                    every other van and for job work, but cannot be sold. The van cannot leave or be counted back in
//                    with a request open.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vlr_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;

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
    Settings: require("../vansales/vanSettingsService"),
    Requests: require("../vansales/vanLoadRequestService"),
    Checks: require("../core/notificationChecksService"),
    Notification: require("../../models/core/notificationModel"),
    ChartSeed: require("../financial/defaultChartService"),
    VanTrip: require("../../models/modules/vansales/vanTripModel"),
    Category: require("../../models/modules/categoryModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Admin: require("../../models/core/adminModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.ChartSeed.provision();
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

let salesman, keeper, A, rice, oil, van1, van2, trip1, trip2;
const by = () => String(salesman._id);
const keeperBy = () => String(keeper._id);
const sellable = async (trip, item) => (await svc.Trip.getById(trip._id)).sellable.find((l) => l.stockId === String(item._id))?.qty || 0;
const onVans = async (item) => (await svc.Trip.withOnVans()).get(String(item._id)) || 0;
const requestOf = async (trip, no) => (await svc.VanTrip.findById(trip._id).lean()).loadRequests.find((r) => r.no === no);

test("setup: 100 rice and 40 oil in the depot, two vans with trips waiting to load", { skip }, async () => {
  salesman = await svc.Admin.create({ name: "Rashid", email: `rashid.lr.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  keeper = await svc.Admin.create({ name: "Store Sam", email: `sam.lr.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Wholesale Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  A = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", phone: "0500000000", shippingAddress: "Dubai", paymentTerms: "Net 30" });
  const cat = await svc.Category.create({ name: "Food" });
  const item = (sku, name, price) => svc.StockService.createStock({ categoryId: cat._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku, itemName: name, salesPrice: price }, "tester");
  rice = await item("RICE", "Rice 5kg", 20);
  oil = await item("OIL", "Oil 1L", 30);
  const po = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [
    { itemId: rice._id, description: "Rice", qty: 100, price: 10, vatPercent: 0 },
    { itemId: oil._id, description: "Oil", qty: 40, price: 12, vatPercent: 0 },
  ] }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");
  van1 = await svc.Van.create({ code: "VAN-1", name: "Van One", salesmanId: by() }, "tester");
  van2 = await svc.Van.create({ code: "VAN-2", name: "Van Two", salesmanId: by() }, "tester");
  trip1 = await svc.Trip.open({ vanId: van1._id }, "tester");
  trip2 = await svc.Trip.open({ vanId: van2._id }, "tester");
});

test("off by default: a request is refused and loading works exactly as before", { skip }, async () => {
  assert.equal((await svc.Settings.settings()).loadRequests, false);
  await assert.rejects(() => svc.Requests.request(trip1._id, { lines: [{ stockId: rice._id, qty: 5 }] }, by()), { code: "VAN_LOAD_REQUESTS_OFF" });
  await svc.Trip.load(trip2._id, { lines: [{ stockId: String(oil._id), qty: 10 }] }, "tester");
  assert.equal(await sellable(trip2, oil), 10, "a direct load is on the van at once");
});

test("on: no direct loads; asked for, then loaded with changes - reserved for nobody else, sellable by nobody yet", { skip }, async () => {
  await svc.Settings.save({ loadRequests: true });
  await assert.rejects(() => svc.Trip.load(trip1._id, { lines: [{ stockId: String(rice._id), qty: 5 }] }, "tester"), { code: "VAN_LOAD_REQUEST_REQUIRED" });

  const asked = await svc.Requests.request(trip1._id, { lines: [{ stockId: rice._id, qty: 60 }, { stockId: oil._id, qty: 10 }], note: "Big day tomorrow" }, by(), { byName: "Rashid" });
  assert.equal(asked.request.no, 1);
  assert.equal(asked.request.status, "REQUESTED");
  assert.equal(await onVans(rice), 0, "asked for is not taken from the depot");
  await assert.rejects(() => svc.Requests.request(trip1._id, { lines: [{ stockId: rice._id, qty: 1 }] }, by()), { code: "LOAD_REQUEST_OPEN" }, "one at a time");
  await assert.rejects(() => svc.Trip.depart(trip1._id, "tester"), { code: "LOAD_REQUEST_OPEN" });

  // oil: 10 on van 2 already, so only 30 is free; the storekeeper gives 50 rice instead of 60, and no oil at all
  await assert.rejects(() => svc.Requests.load(trip1._id, 1, { lines: [{ stockId: oil._id, qty: 31 }] }, keeperBy()), { code: "INSUFFICIENT_STOCK" }, "the depot check is the direct load's");
  const loaded = await svc.Requests.load(trip1._id, 1, { lines: [{ stockId: rice._id, qty: 50 }, { stockId: oil._id, qty: 0 }] }, keeperBy(), { byName: "Store Sam" });
  assert.equal(loaded.request.status, "LOADED");
  const r = await requestOf(trip1, 1);
  assert.deepEqual(r.lines.map((l) => [l.itemName, l.requested, l.loaded]), [["Rice 5kg", 60, 50], ["Oil 1L", 10, 0]]);
  assert.equal(await sellable(trip1, rice), 0, "not the salesman's to sell until he accepts it");
  assert.equal(await onVans(rice), 50, "but it has left the depot");
  // another van, loaded the old way for a moment: the 50 waiting on van 1 are not the depot's to give
  await svc.Settings.save({ loadRequests: false });
  await assert.rejects(() => svc.Trip.load(trip2._id, { lines: [{ stockId: String(rice._id), qty: 51 }] }, "tester"), { code: "INSUFFICIENT_STOCK" }, "another van cannot be given what is waiting on this one");
  await svc.Settings.save({ loadRequests: true });
  const JobWork = require("../stock/jobWorkService");
  const free = require("../../utils/vanSales").freeDepot({ currentStock: 100, withJobWorker: (await JobWork.withJobWorker()).get(String(rice._id)) || 0, onVans: await onVans(rice) });
  assert.equal(free, 50, "job work and the stock list see the same reservation");
  await assert.rejects(() => svc.Requests.load(trip1._id, 1, { lines: [{ stockId: rice._id, qty: 1 }] }, keeperBy()), { code: "LOAD_REQUEST_NOT_OPEN" }, "loaded once");
});

test("the salesman counts it: only what he accepts is on his van; a shortfall needs a reason and goes back to the depot", { skip }, async () => {
  await assert.rejects(() => svc.Requests.accept(trip1._id, 1, { lines: [{ stockId: rice._id, accepted: 51 }] }, by()), { code: "ACCEPT_MORE_THAN_LOADED" });
  await assert.rejects(() => svc.Requests.accept(trip1._id, 1, { lines: [{ stockId: rice._id, accepted: 47 }] }, by()), { code: "SHORTFALL_REASON_REQUIRED" });
  const done = await svc.Requests.accept(trip1._id, 1, { lines: [{ stockId: rice._id, accepted: 47 }], reason: "Three bags torn, left at the dock" }, by(), { byName: "Rashid" });
  assert.equal(done.request.status, "ACCEPTED");
  assert.deepEqual(done.short.map((s) => s.missing), [3]);
  assert.equal(await sellable(trip1, rice), 47, "what he accepted is on his van");
  assert.equal(await onVans(rice), 47, "the three short are free in the depot again");
  const trip = await svc.VanTrip.findById(trip1._id).lean();
  assert.equal(trip.loads.at(-1).requestNo, 1);
  assert.equal(trip.loadRequests[0].loadNo, trip.loads.at(-1).no);
  assert.equal(trip.loadRequests[0].reason, "Three bags torn, left at the dock");
  await svc.Trip.depart(trip1._id, "tester");
  const sold = await svc.Sales.sell(trip1._id, { customerId: A._id, items: [{ itemId: rice._id, qty: 2, vatPercent: 0 }] }, by());
  assert.equal(sold.invoice.status, "APPROVED", "and he sells from it as from any load");
});

test("a top-up on the road the same way; refused and cancelled requests; count-in waits for an open one", { skip }, async () => {
  const two = await svc.Requests.request(trip1._id, { lines: [{ stockId: oil._id, qty: 4 }] }, by());
  await assert.rejects(() => svc.Requests.reject(trip1._id, two.request.no, {}, keeperBy()), { code: "REASON_REQUIRED" });
  const refused = await svc.Requests.reject(trip1._id, two.request.no, { reason: "Oil is promised to a wholesale order" }, keeperBy());
  assert.equal(refused.request.status, "REJECTED");
  const three = await svc.Requests.request(trip1._id, { lines: [{ stockId: oil._id, qty: 2 }] }, by());
  await assert.rejects(() => svc.Settle.unload(trip1._id, { counts: [] }, by()), { code: "LOAD_REQUEST_OPEN" });
  const gone = await svc.Requests.cancel(trip1._id, three.request.no, by());
  assert.equal(gone.request.status, "CANCELLED");
  await assert.rejects(() => svc.Requests.accept(trip1._id, three.request.no, {}, by()), { code: "LOAD_REQUEST_NOT_OPEN" });
  await assert.rejects(() => svc.Requests.load(trip1._id, 99, { lines: [{ stockId: oil._id, qty: 1 }] }, keeperBy()), { code: "LOAD_REQUEST_NOT_FOUND" });

  const four = await svc.Requests.request(trip1._id, { lines: [{ stockId: oil._id, qty: 3 }] }, by());
  await svc.Requests.load(trip1._id, four.request.no, { lines: [{ stockId: oil._id, qty: 3 }] }, keeperBy());
  await svc.Requests.accept(trip1._id, four.request.no, { lines: [] }, by());
  assert.equal(await sellable(trip1, oil), 3, "a top-up accepted in full");
});

test("the storekeeper's list and the badges; a cancelled trip closes its open request", { skip }, async () => {
  const trip3 = await svc.Trip.open({ vanId: (await svc.Van.create({ code: "VAN-3", name: "Van Three", salesmanId: by() }, "tester"))._id }, "tester");
  await svc.Requests.request(trip3._id, { lines: [{ stockId: rice._id, qty: 4 }] }, by());
  const list = await svc.Requests.waiting();
  const row = list.find((x) => x.tripId === String(trip3._id));
  assert.equal(row.status, "REQUESTED");
  assert.equal(row.lines[0].free, 98 - 45, "free depot stock beside what is asked for: 98 in the books (2 sold), 45 still on van 1");
  assert.deepEqual(await svc.Requests.counts(by(), { mayLoad: true }), { toLoad: 1, toAccept: 0 });
  assert.deepEqual(await svc.Requests.counts(by(), { mayLoad: false }), { toLoad: 0, toAccept: 0 }, "a salesman is not counted the storekeeper's work");
  await svc.Trip.cancel(trip3._id, "tester");
  assert.equal((await requestOf(trip3, 1)).status, "CANCELLED");
});

test("the notices: the storekeeper is told a load is asked for, the salesman alone that it is on his van, and a shortfall", { skip }, async () => {
  const t = await svc.Trip.open({ vanId: (await svc.Van.create({ code: "VAN-4", name: "Van Four", salesmanId: by() }, "tester"))._id }, "tester");
  await svc.Requests.request(t._id, { lines: [{ stockId: oil._id, qty: 2 }] }, by());
  await svc.Checks.checkVanLoadRequests();
  const asked = await svc.Notification.findOne({ kind: "van_load_requested", dedupeKey: `van_load_requested:${t._id}:1`, resolvedAt: null }).lean();
  assert.equal(asked.audience.permission, "vansales.load");
  const short = await svc.Notification.findOne({ kind: "van_load_short", dedupeKey: `van_load_short:${trip1._id}:1`, resolvedAt: null }).lean();
  assert.ok(short, "trip 1 accepted 3 fewer rice than loaded");

  await svc.Requests.load(t._id, 1, { lines: [{ stockId: oil._id, qty: 2 }] }, keeperBy());
  await svc.Checks.checkVanLoadRequests();
  assert.ok(await svc.Notification.findOne({ dedupeKey: `van_load_requested:${t._id}:1` }).lean().then((n) => n.resolvedAt), "loaded: the storekeeper's notice closes");
  const ready = await svc.Notification.findOne({ kind: "van_load_ready", dedupeKey: `van_load_ready:${t._id}:1`, resolvedAt: null }).lean();
  assert.equal(String(ready.audience.adminId), by(), "told to the salesman alone");
  await svc.Requests.accept(t._id, 1, {}, by());
  await svc.Checks.checkVanLoadRequests();
  assert.ok((await svc.Notification.findOne({ dedupeKey: `van_load_ready:${t._id}:1` }).lean()).resolvedAt);
});
