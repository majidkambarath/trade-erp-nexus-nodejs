// Goods taken back item by item, against a throwaway database: the customer's own invoices are found (newest first, paid
// or not), each gets its credit note, what none of them covers goes without one only where that is allowed and within the
// limit, a refusal writes nothing at all, and the trip records what came back, in what condition, on which line.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vri_${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

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
    Slips: require("../vansales/vanSlipService"),
    Settings: require("../vansales/vanSettingsService"),
    Config: require("../financial/accountConfigService"),
    Chart: require("../financial/defaultChartService"),
    Transaction: require("../../models/modules/transactionModel"),
    Batch: require("../../models/modules/stockBatchModel"),
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
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

let salesman, A, milk, rice, sugar, trip, paid, open;
const by = () => String(salesman._id);
const returns = () => svc.Transaction.countDocuments({ type: "sales_return" });
const stored = (id) => svc.Transaction.findById(id).lean();
const line = (stockId, qty, condition) => ({ stockId: String(stockId), qty, ...(condition ? { condition } : {}) });
const onVan = async () => {
  const t = await svc.Trip.getById(trip._id);
  return { sellable: Object.fromEntries(t.sellable.map((l) => [l.itemName, l.qty])), damaged: Object.fromEntries((t.damaged || []).map((l) => [l.itemName, l.qty])) };
};

test("setup: milk and rice sold twice to one shop on a trip, one sale paid, one on credit", { skip }, async () => {
  salesman = await svc.Admin.create({ name: "Rashid", email: `rashid-ri.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Dairy Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  A = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", phone: "0500000000", shippingAddress: "Dubai", paymentTerms: "Net 30" });
  const cat = await svc.Category.create({ name: "Food" });
  const item = (sku, itemName, salesPrice) => svc.StockService.createStock({ categoryId: cat._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku, itemName, salesPrice }, "tester");
  milk = await item("MILK", "Milk 1L", 10);
  rice = await item("RICE", "Rice 5kg", 20);
  sugar = await item("SUGAR", "Sugar 10kg", 30);
  const po = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [milk, rice, sugar].map((s) => ({ itemId: s._id, description: s.itemName, qty: 50, price: 5, vatPercent: 0 })) }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");
  const van = await svc.Van.create({ code: "VAN-1", name: "Van One", salesmanId: by() }, "tester");
  trip = await svc.Trip.open({ vanId: van._id }, "tester");
  await svc.Trip.load(trip._id, { lines: [{ stockId: String(milk._id), qty: 20 }, { stockId: String(rice._id), qty: 5 }] }, "tester");
  await svc.Trip.depart(trip._id, "tester");
  const sell = (items, extra) => svc.Sales.sell(trip._id, { customerId: A._id, items: items.map(([s, qty]) => ({ itemId: s._id, qty, vatPercent: 0 })), ...extra }, by());
  paid = (await sell([[milk, 4], [rice, 2]], { payNow: { mode: "cash", full: true } })).invoice;
  open = (await sell([[milk, 3]])).invoice;
});

test("what they bought can come back: each item with how many, newest first", { skip }, async () => {
  const r = await svc.Sales.returnableItems(trip._id, A._id);
  assert.deepEqual(r.items.map((i) => [i.name, i.returnable]), [["Milk 1L", 7], ["Rice 5kg", 2]]);
  assert.deepEqual([r.looseAllowed, r.limit], [false, 500]);
});

test("the preview shows the invoice each part comes off, and refuses what is on none where it may not come back so", { skip }, async () => {
  const lines = [line(milk._id, 3, "good"), line(milk._id, 2, "damaged"), line(rice._id, 1), line(sugar._id, 1)];
  const p = await svc.Sales.returnPlan(trip._id, { customerId: A._id, lines });
  assert.deepEqual(p.groups.map((g) => [g.number, g.total, g.lines.map((l) => [l.name, l.qty, l.condition, l.total])]), [
    [open.transactionNo, 30, [["Milk 1L", 3, "good", 30]]],
    [paid.transactionNo, 40, [["Milk 1L", 2, "damaged", 20], ["Rice 5kg", 1, "good", 20]]],
  ]);
  assert.equal(p.rest.allowed, false);
  assert.match(p.rest.why, /Sugar 10kg/);
  const before = await returns();
  await assert.rejects(() => svc.Sales.returnItems(trip._id, { customerId: A._id, lines, reason: "Expired" }, by()), { code: "VAN_RETURN_NOT_ON_INVOICE" });
  assert.equal(await returns(), before, "nothing at all is written");
});

test("a reason is needed, and the lines are read strictly", { skip }, async () => {
  const send = (lines, extra = { reason: "Expired" }) => svc.Sales.returnItems(trip._id, { customerId: A._id, lines, ...extra }, by());
  await assert.rejects(() => send([line(milk._id, 1)], {}), { code: "RETURN_REASON_REQUIRED" });
  await assert.rejects(() => send([]), { code: "ITEMS_REQUIRED" });
  await assert.rejects(() => send([line("nope", 1)]), { code: "ITEM_INVALID" });
  await assert.rejects(() => send([{ stockId: String(milk._id), qty: [1] }]), { code: "QTY_INVALID" });
  await assert.rejects(() => send([line(milk._id, 1, "lost")]), { code: "CONDITION_INVALID" });
  await assert.rejects(() => send([line(milk._id, 1, "good"), line(milk._id, 2)]), { code: "ITEM_REPEATED" });
  assert.equal(await returns(), 0);
});

test("taking it back makes one credit note against each invoice, approved, and the books and the van follow", { skip }, async () => {
  const result = await svc.Sales.returnItems(trip._id, { customerId: A._id, lines: [line(milk._id, 3, "good"), line(milk._id, 2, "damaged"), line(rice._id, 1)], reason: "Expired", note: "Fridge failed" }, by());
  assert.deepEqual(result.creditNotes.map((n) => [n.against, n.totalAmount]), [[open.transactionNo, 30], [paid.transactionNo, 40]]);
  assert.equal(result.total, 70);
  const [onOpen, onPaid] = await Promise.all(result.creditNotes.map((n) => stored(n._id)));
  assert.equal(onOpen.status, "APPROVED");
  assert.equal(String(onOpen.returnOf.transactionId), String(open._id));
  assert.deepEqual(onPaid.items.map((l) => [l.description, l.qty]), [["Milk 1L", 2], ["Rice 5kg", 1]], "one line per invoice line");
  assert.equal((await stored(open._id)).outstandingAmount, 0, "the unpaid invoice owes nothing more");
  assert.equal((await stored(paid._id)).creditedAmount, 40, "the paid one's credit goes on account");
  assert.deepEqual(await onVan(), { sellable: { "Milk 1L": 16, "Rice 5kg": 4 }, damaged: { "Milk 1L": 2 } }, "20 less 7 sold plus 3 good back; 2 damaged kept apart");
  const t = await svc.VanTrip.findById(trip._id).lean();
  assert.deepEqual(t.returns.map((x) => [x.no, x.matched, x.withoutInvoice, x.reason, x.lines.map((l) => [l.qty, l.condition])]), [
    [onOpen.transactionNo, true, false, "Expired", [[3, "good"]]],
    [onPaid.transactionNo, true, false, "Expired", [[2, "damaged"], [1, "good"]]],
  ]);
  assert.equal(String(t.returns[1].lines[0].docLineId), String(onPaid.items[0]._id), "each part knows the line it came back on");
  const batches = await svc.Batch.find({ stockId: milk._id }).lean();
  assert.equal(r2(batches.reduce((s, b) => s + b.qtyOnHand, 0)), 50 - 7 + 5, "returned milk is back in its batches");
  assert.deepEqual((await svc.Sales.returnableItems(trip._id, A._id)).items.map((i) => [i.name, i.returnable]), [["Milk 1L", 2], ["Rice 5kg", 1]]);
});

test("the credit note's slip names the invoice and the reason, and the trip lists it", { skip }, async () => {
  const t = await svc.VanTrip.findById(trip._id).lean();
  const slip = await svc.Slips.forReturn(trip._id, t.returns[0].transactionId);
  assert.equal(slip.kind, "credit");
  assert.equal(slip.invoice.against, open.transactionNo);
  assert.equal(slip.invoice.reason, "Expired. Fridge failed");
  assert.deepEqual(slip.lines.map((l) => [l.description, l.qty]), [["Milk 1L", 3]]);
  await assert.rejects(() => svc.Slips.forReturn(trip._id, open._id), { code: "VAN_RETURN_NOT_FOUND" });
  const list = await svc.Slips.invoices(trip._id);
  assert.deepEqual(list.map((r) => r.type).sort(), ["sales_order", "sales_order", "sales_return", "sales_return"]);
});

test("without an invoice, where allowed: the rest goes loose at the customer's price, up to the limit", { skip }, async () => {
  await svc.Settings.save({ returnsWithoutInvoice: true, maxReturnWithoutInvoice: 50 });
  const p = await svc.Sales.returnPlan(trip._id, { customerId: A._id, lines: [line(milk._id, 3), line(sugar._id, 1)] });
  assert.deepEqual([p.rest.allowed, p.rest.total, p.rest.overLimit], [true, 42, false], "milk 1 and sugar 1 loose at today's price, with the standard tax");
  const result = await svc.Sales.returnItems(trip._id, { customerId: A._id, lines: [line(milk._id, 3), line(sugar._id, 1)], reason: "Not selling" }, by());
  assert.deepEqual(result.creditNotes.map((n) => [n.against, n.totalAmount]), [[paid.transactionNo, 20], ["", 42]]);
  const before = await returns();
  await assert.rejects(() => svc.Sales.returnItems(trip._id, { customerId: A._id, lines: [line(rice._id, 1), line(sugar._id, 2)], reason: "Not selling" }, by()), { code: "VAN_RETURN_OVER_LIMIT" });
  assert.equal(await returns(), before, "the part against an invoice is not left behind");
  const over = await svc.Sales.returnItems(trip._id, { customerId: A._id, lines: [line(sugar._id, 2)], reason: "Not selling" }, by(), { mayUnderprice: true });
  assert.equal(over.total, 63, "a supervisor may");
});

test("the business's return window and its need for an invoice are kept", { skip }, async () => {
  await svc.Config.updateSettings({ returnWindowDays: 3 });
  await svc.Transaction.collection.updateOne({ _id: paid._id }, { $set: { date: new Date(Date.now() - 10 * 86400000) } });
  assert.deepEqual((await svc.Sales.returnableItems(trip._id, A._id)).items.map((i) => i.name), [], "milk on the open invoice has all come back; the older one is past the window");
  await svc.Config.updateSettings({ returnWindowDays: 0, requireReturnLink: true });
  const p = await svc.Sales.returnPlan(trip._id, { customerId: A._id, lines: [line(sugar._id, 1)] });
  assert.equal(p.rest.allowed, false);
  assert.match(p.rest.why, /needs an invoice/);
  await assert.rejects(() => svc.Sales.returnItems(trip._id, { customerId: A._id, lines: [line(sugar._id, 1)], reason: "Not selling" }, by()), { code: "RETURN_LINK_REQUIRED" });
  await svc.Config.updateSettings({ requireReturnLink: false });
});
