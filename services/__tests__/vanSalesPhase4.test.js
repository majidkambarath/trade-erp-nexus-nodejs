// Van sales phase 4 against a throwaway database: promotions applied on the server (a slab, buy-X-get-Y with the free
// goods leaving the van and the books at cost), a pre-order taken on the road and delivered on the next trip, the load
// suggested from the route's history and its pre-orders with the reason for each figure, and the warning when the
// stock FEFO would put on the van expires before the route's customers will take it.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vp4_${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;
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
    Promos: require("../vansales/promotionService"),
    Plan: require("../vansales/vanPlanningService"),
    Chart: require("../financial/defaultChartService"),
    Transaction: require("../../models/modules/transactionModel"),
    TradeOrder: require("../../models/modules/tradeOrderModel"),
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

let salesman, A, B, rice, bag, milk, route, van, trip1, trip2, preorder;
const by = () => String(salesman._id);
const onVan = async (t, item) => (await svc.Trip.getById(t._id)).sellable.find((l) => l.stockId === String(item._id))?.qty || 0;
const inDays = (n) => new Date(Date.now() + n * 86400000);

test("setup: rice, bags and milk bought in, two customers on a Tuesday-and-Thursday route", { skip }, async () => {
  salesman = await svc.Admin.create({ name: "Rashid", email: `rashid4.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Wholesale Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  const mk = (id, name, shelf = 0) => svc.Customer.create({ customerId: id, customerName: name, contactPerson: name, phone: "0500000000", shippingAddress: "Dubai", paymentTerms: "Net 30", minShelfLifeDays: shelf });
  [A, B] = await Promise.all([mk("C1", "Al Noor"), mk("C2", "Bin Zayed", 10)]);
  const cat = await svc.Category.create({ name: "Food" });
  const item = (sku, name, price) => svc.StockService.createStock({ categoryId: cat._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku, itemName: name, salesPrice: price }, "tester");
  [rice, bag, milk] = [await item("RICE", "Rice 5kg", 20), await item("BAG", "Shopping bag", 1), await item("MILK", "Milk 1L", 5)];
  const po = await svc.Tx.createTransaction({
    type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor",
    items: [
      { itemId: rice._id, description: "Rice", qty: 100, price: 10, vatPercent: 0 },
      { itemId: bag._id, description: "Bag", qty: 50, price: 0.5, vatPercent: 0 },
      { itemId: milk._id, description: "Milk", qty: 10, price: 3, vatPercent: 0, batchNumber: "M-SHORT", expiryDate: inDays(4) },
      { itemId: milk._id, description: "Milk", qty: 40, price: 3, vatPercent: 0, batchNumber: "M-LONG", expiryDate: inDays(60) },
    ],
  }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");
  route = await svc.Van.createRoute({ name: "North", days: [2, 4], customers: [{ customerId: String(A._id) }, { customerId: String(B._id) }] }, "tester");
  van = await svc.Van.create({ code: "VAN-1", name: "Van One", salesmanId: by(), defaultRouteId: route.id }, "tester");
});

test("promotions are checked when saved", { skip }, async () => {
  await svc.Promos.create({ name: "Rice 10+ 5% off", kind: "slab", stockIds: [String(rice._id)], minQty: 10, percent: 5 }, "tester");
  await svc.Promos.create({ name: "A bag with every 10 rice", kind: "bxgy", stockIds: [String(rice._id)], buyQty: 10, freeQty: 1, freeStockId: String(bag._id) }, "tester");
  await assert.rejects(() => svc.Promos.create({ name: "Rice 10+ 5% off", kind: "slab", minQty: 1, percent: 1 }, "tester"), { code: "PROMOTION_NAME_TAKEN" });
  await assert.rejects(() => svc.Promos.create({ name: "Bad", kind: "bxgy", stockIds: [String(rice._id), String(bag._id)], buyQty: 2, freeQty: 1 }, "tester"), { code: "FREE_ITEM_REQUIRED" });
  assert.equal((await svc.Promos.list()).length, 2);
});

test("loading warns about stock that would expire before the route's customers take it, and never refuses", { skip }, async () => {
  trip1 = await svc.Trip.open({ vanId: van._id }, "tester");
  const check = await svc.Plan.loadCheck(trip1._id, { lines: [{ stockId: String(milk._id), qty: 15 }, { stockId: String(rice._id), qty: 40 }] });
  assert.equal(check.shelfLifeDays, 10, "the longest shelf life asked on the route");
  assert.equal(check.warnings.length, 1);
  assert.equal(check.warnings[0].code, "EXPIRY_SOON");
  assert.deepEqual(check.warnings[0].batches.map((b) => [b.batchNo, b.qty]), [["M-SHORT", 10]], "FEFO hands out the short batch first");
  await svc.Trip.load(trip1._id, { lines: [{ stockId: String(rice._id), qty: 40 }, { stockId: String(bag._id), qty: 10 }] }, "tester");
  await svc.Trip.depart(trip1._id, "tester");
});

test("the offers are applied on the server: 5% from ten rice, and a free bag that leaves the van and the books", { skip }, async () => {
  const bagsBefore = (await svc.Stock.findById(bag._id)).currentStock;
  const { invoice, promotions } = await svc.Sales.sell(trip1._id, { customerId: A._id, items: [{ itemId: rice._id, qty: 20, vatPercent: 0 }] }, by());
  const riceLine = invoice.items.find((l) => String(l.itemId) === String(rice._id));
  const bagLine = invoice.items.find((l) => String(l.itemId) === String(bag._id));
  assert.equal(riceLine.discountPercent, 5);
  assert.equal(r2(invoice.totalAmount), 380, "20 x 20 less 5%");
  assert.equal(bagLine.qty, 2);
  assert.equal(bagLine.price, 0);
  assert.match(bagLine.description, /free/);
  assert.equal(promotions.length, 2);
  assert.equal(await onVan(trip1, bag), 8, "the free bags left the van");
  assert.equal((await svc.Stock.findById(bag._id)).currentStock, bagsBefore - 2, "and the books, at cost");
  // under ten rice: no offer
  const small = await svc.Sales.sell(trip1._id, { customerId: B._id, items: [{ itemId: rice._id, qty: 5, vatPercent: 0 }] }, by());
  assert.equal(small.invoice.items.length, 1);
  assert.equal(small.invoice.items[0].discountPercent, 0);
});

test("free goods the van does not carry stop the sale with the van's own message", { skip }, async () => {
  const milkFree = await svc.Promos.create({ name: "Milk with rice", kind: "bxgy", stockIds: [String(rice._id)], buyQty: 1, freeQty: 1, freeStockId: String(milk._id) }, "tester");
  await assert.rejects(() => svc.Sales.sell(trip1._id, { customerId: A._id, items: [{ itemId: rice._id, qty: 1, vatPercent: 0 }] }, by()), { code: "VAN_STOCK_SHORT" });
  await svc.Promos.update(milkFree.id, { ...milkFree, active: false }, "tester");
  assert.equal(await onVan(trip1, rice), 15, "nothing was sold");
});

test("an order for the next visit is a confirmed sales order for the route's next run day, priced for the customer", { skip }, async () => {
  preorder = await svc.Plan.createPreorder(trip1._id, { customerId: B._id, items: [{ itemId: rice._id, qty: 6 }] }, by());
  assert.equal(preorder.status, "CONFIRMED");
  assert.equal(preorder.source.kind, "van");
  assert.equal(String(preorder.source.routeId), String(route.id));
  assert.ok(preorder.expectedDate, "dated for the next run");
  const list = await svc.Plan.preordersForRoute(route.id);
  assert.deepEqual(list.map((p) => [p.customerName, p.items[0].qty]), [["Bin Zayed", 6]]);
  await assert.rejects(() => svc.Plan.createPreorder(trip1._id, { customerId: B._id, items: [] }, by()), { code: "ITEMS_REQUIRED" });
});

test("the first trip is settled", { skip }, async () => {
  const t = await svc.Trip.getById(trip1._id);
  await svc.Settle.unload(trip1._id, { counts: t.sellable.map((l) => ({ stockId: l.stockId, good: l.qty, damaged: 0 })) }, by());
  const plan = await svc.Settle.preview(trip1._id, {});
  await svc.Settle.settle(trip1._id, { acknowledge: plan.warnings.map((w) => w.code) }, by());
});

test("the next load is suggested from the route's history and its pre-orders, each figure with its reason", { skip }, async () => {
  trip2 = await svc.Trip.open({ vanId: van._id }, "tester");
  const s = await svc.Plan.suggestedLoad(trip2._id);
  assert.equal(s.runs, 1);
  const r = s.lines.find((l) => l.stockId === String(rice._id));
  assert.deepEqual([r.qty, r.why.preorder, r.why.average, r.why.onVan], [31, 6, 25, 0], "25 sold last run + 6 ordered");
  const b = s.lines.find((l) => l.stockId === String(bag._id));
  assert.equal(b.qty, 2, "the free bags count as sold");
});

test("the pre-order is delivered by selling against it, which closes it", { skip }, async () => {
  await svc.Trip.load(trip2._id, { lines: [{ stockId: String(rice._id), qty: 31 }] }, "tester");
  await svc.Trip.depart(trip2._id, "tester");
  await assert.rejects(() => svc.Sales.sell(trip2._id, { customerId: A._id, preorderId: preorder._id, items: [{ itemId: rice._id, qty: 6 }] }, by()), { code: "PREORDER_NOT_FOUND" });
  const { preorder: closed } = await svc.Sales.sell(trip2._id, { customerId: B._id, preorderId: preorder._id, items: [{ itemId: rice._id, qty: 6, vatPercent: 0 }] }, by());
  assert.equal(closed, preorder.orderNo);
  assert.equal((await svc.TradeOrder.findById(preorder._id)).status, "CLOSED");
  assert.deepEqual(await svc.Plan.preordersForRoute(route.id), []);
  await assert.rejects(() => svc.Sales.sell(trip2._id, { customerId: B._id, preorderId: preorder._id, items: [{ itemId: rice._id, qty: 1 }] }, by()), { code: "PREORDER_NOT_OPEN" });
});
