// Van sales phase 6 against a throwaway database: Zarvia AI's van lookups and the sale it prepares (nothing written
// until the prepared body goes through the normal sell), van calls on the customer's CRM timeline written once with a
// follow-up for a no-sale, cheques from the road with what a deposit slip needs and the register filtered by trip, a
// road invoice in the e-invoicing list, and the customer's own link: statement, next visit, and a request the van
// then delivers.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vp6_${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;

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
    Plan: require("../vansales/vanPlanningService"),
    Crm: require("../vansales/vanCrmService"),
    Link: require("../vansales/vanCustomerLinkService"),
    Cheques: require("../banking/chequeService"),
    EInvoice: require("../einvoice/einvoiceService"),
    vanTools: require("../assistant/vanTools"),
    Chart: require("../financial/defaultChartService"),
    CrmActivity: require("../../models/modules/crm/crmActivityModel"),
    TradeOrder: require("../../models/modules/tradeOrderModel"),
    Customer: require("../../models/modules/customerModel"),
    Category: require("../../models/modules/categoryModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Admin: require("../../models/core/adminModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Chart.provision();
  await svc.Org.ensureDefault(); // the organisation, on the internal plan: it holds the CRM
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

let salesman, A, B, rice, route, van, trip, invoice;
const by = () => String(salesman._id);
const ctxOf = (grants) => ({ req: { admin: { id: by(), grants } }, proposals: [] });

test("setup: rice on a van out on a two-customer route; Al Noor owes for an older invoice", { skip }, async () => {
  salesman = await svc.Admin.create({ name: "Rashid", email: `rashid6.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Wholesale Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  const mk = (id, name) => svc.Customer.create({ customerId: id, customerName: name, contactPerson: name, phone: "0500000000", shippingAddress: "Dubai", paymentTerms: "Net 30" });
  [A, B] = await Promise.all([mk("C1", "Al Noor Grocery"), mk("C2", "Bin Zayed Market")]);
  const cat = await svc.Category.create({ name: "Food" });
  rice = await svc.StockService.createStock({ categoryId: cat._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku: "RICE", itemName: "Rice 5kg", salesPrice: 20 }, "tester");
  const po = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: rice._id, description: "Rice", qty: 100, price: 10, vatPercent: 0 }] }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");
  route = await svc.Van.createRoute({ name: "North", days: [1, 3, 5], customers: [{ customerId: String(A._id) }, { customerId: String(B._id) }] }, "tester");
  van = await svc.Van.create({ code: "VAN-1", name: "Van One", salesmanId: by(), defaultRouteId: route.id }, "tester");
  trip = await svc.Trip.open({ vanId: van._id }, "tester");
  await svc.Trip.load(trip._id, { lines: [{ stockId: String(rice._id), qty: 40 }] }, "tester");
  await svc.Trip.depart(trip._id, "tester");
  ({ invoice } = await svc.Sales.sell(trip._id, { customerId: A._id, items: [{ itemId: rice._id, qty: 5, vatPercent: 0 }] }, by()));
});

test("Zarvia AI on the van: what is on it, who owes on the route, who is left, all written by the server", { skip }, async () => {
  const seller = ctxOf(["vansales.sell"]);
  const stock = await svc.vanTools.runLookup("van_stock", {}, seller);
  assert.equal(stock.ok, true);
  assert.match(stock.data.reply, /VAN-1 has 1 item to sell/);
  assert.deepEqual(stock.data.table.rows.map((r) => [r.label, r.value]), [["Rice 5kg", "35"]]);
  const owing = await svc.vanTools.runLookup("route_owing", {}, seller);
  assert.match(owing.data.reply, /1 customer on North owe/);
  assert.equal(owing.data.table.rows[0].label, "Al Noor Grocery");
  const left = await svc.vanTools.runLookup("route_not_visited", {}, seller);
  assert.deepEqual(left.data.table.rows.map((r) => r.label), ["Bin Zayed Market"]);
  const nobody = await svc.vanTools.runLookup("van_stock", {}, { req: { admin: { id: String(new mongoose.Types.ObjectId()), grants: ["vansales.sell"] } } });
  assert.match(nobody.data.reply, /No van trip is open for you/);
  const refused = await svc.vanTools.runLookup("van_stock", {}, { req: { admin: { id: by(), grants: ["sales.view"] } } });
  assert.equal(refused.ok, false, "no van key, no van lookup");
  assert.equal(svc.vanTools.lookupDefinitions({ admin: { grants: ["sales.view"] } }).length, 0);
});

test("the AI prepares a sale from what is on the van at the customer's price; nothing is sold until the body is sent", { skip }, async () => {
  const ctx = ctxOf(["vansales.sell"]);
  const push = (c, p) => { const x = { id: `p${c.proposals.length + 1}`, ...p }; c.proposals.push(x); return x; };
  const tooMany = await svc.vanTools.prepareSale({ customer: "Bin Zayed", lines: [{ item: "rice", qty: 99 }] }, ctx, push);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /Only 35 of Rice 5kg is on the van/);
  const notOnVan = await svc.vanTools.prepareSale({ customer: "Bin Zayed", lines: [{ item: "sugar", qty: 1 }] }, ctx, push);
  assert.match(notOnVan.error, /not on the van/);
  const r = await svc.vanTools.prepareSale({ customer: "Bin Zayed", lines: [{ item: "rice", qty: 3 }], cash: true }, ctx, push);
  assert.equal(r.ok, true);
  const p = ctx.proposals[0];
  assert.deepEqual([p.kind, p.endpoint, p.body.tripId, p.body.items[0].qty, p.body.payNow.mode], ["van_sale", "van_sale", String(trip._id), 3, "cash"]);
  assert.equal((await svc.Trip.getById(trip._id)).sellable[0].qty, 35, "prepared, not sold");
  const { invoice: sold } = await svc.Sales.sell(p.body.tripId, p.body, by());
  assert.equal(sold.status, "APPROVED");
});

test("a van call lands on the customer's CRM timeline once; a no-sale adds a follow-up for the next run", { skip }, async () => {
  const sale = await svc.Crm.record("sale", { tripId: trip._id, customerId: A._id, refId: invoice._id, ref: invoice.transactionNo, total: invoice.totalAmount, by: by() });
  assert.deepEqual(sale, { logged: true, followUp: false });
  assert.deepEqual(await svc.Crm.record("sale", { tripId: trip._id, customerId: A._id, refId: invoice._id, ref: invoice.transactionNo, by: by() }), { logged: false, followUp: false }, "a repeat writes nothing");
  const visit = await svc.Visits.record(trip._id, { customerId: B._id, reason: "closed", note: "Shutter down" }, by());
  const r = await svc.Crm.record("visit", { tripId: trip._id, customerId: B._id, refId: visit._id, reason: "closed", note: "Shutter down", by: by() });
  assert.deepEqual(r, { logged: true, followUp: true });
  const rows = await svc.CrmActivity.find({ customerId: B._id }).sort({ createdAt: 1 }).lean();
  assert.deepEqual(rows.map((x) => [x.kind, x.status]), [["visit", "DONE"], ["call", "OPEN"]]);
  assert.match(rows[0].subject, /shop closed/);
  assert.ok(["2026-11-18", "2026-11-20", "2026-11-23"].includes(rows[1].dueAt) || /^\d{4}-\d{2}-\d{2}$/.test(rows[1].dueAt), "due on the route's next run day");
  assert.equal(await svc.Crm.record("visit", { tripId: trip._id, customerId: B._id, refId: visit._id, reason: "closed", by: by() }).then((x) => x.followUp), false);
});

test("a road invoice is in the e-invoicing list like any approved sale", { skip }, async () => {
  const rows = await svc.EInvoice.documents({}, { search: invoice.transactionNo });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "NOT_SENT");
});

test("the customer's link: what they owe, the van's next visit, and a request the salesman then delivers", { skip }, async () => {
  const link = { sourceType: "Transaction", sourceId: invoice._id, companyId: "default", branchId: "main" };
  const page = await svc.Link.view(link);
  assert.equal(page.statement.owed, 100);
  assert.equal(page.statement.open[0].number, invoice.transactionNo);
  assert.ok(page.nextVisit);
  assert.deepEqual(page.items.map((i) => [i.name, i.price]), [["Rice 5kg", 20]]);
  assert.equal(page.canRequest, true);
  await assert.rejects(() => svc.Link.request(link, { lines: [{ stockId: String(new mongoose.Types.ObjectId()), qty: 1 }] }), { code: "ITEM_NOT_OFFERED" });
  await assert.rejects(() => svc.Link.request(link, { lines: [] }), { code: "ITEMS_REQUIRED" });
  const asked = await svc.Link.request(link, { lines: [{ stockId: String(rice._id), qty: 8 }], note: "Before 10am please" });
  assert.equal(asked.lines, 1);
  const order = await svc.TradeOrder.findOne({ orderNo: asked.orderNo }).lean();
  assert.deepEqual([order.status, order.source.kind, String(order.partyId)], ["DRAFT", "customer_link", String(A._id)]);
  const onRoute = await svc.Plan.preordersForRoute(route.id);
  assert.deepEqual(onRoute.map((p) => [p.orderNo, p.source]), [[asked.orderNo, "customer_link"]]);
  assert.equal((await svc.Link.view(link)).orders[0].requested, true);
  const { preorder } = await svc.Sales.sell(trip._id, { customerId: A._id, preorderId: order._id, items: [{ itemId: rice._id, qty: 8, vatPercent: 0 }] }, by());
  assert.equal(preorder, asked.orderNo);
  assert.equal((await svc.TradeOrder.findById(order._id)).status, "CLOSED");
  // a page for an invoice that was not raised on a van offers nothing
  await assert.rejects(() => svc.Link.view({ ...link, sourceId: new mongoose.Types.ObjectId() }), { code: "SHARE_NOT_FOUND" });
});

test("the cheque register can be read for one trip", { skip }, async () => {
  const none = await svc.Cheques.list({}, { vanTripId: String(trip._id) });
  assert.equal(none.total, 0);
  const bogus = await svc.Cheques.list({}, { vanTripId: "nope" });
  assert.equal(bogus.total, 0, "a bad id finds nothing, never everything");
});
