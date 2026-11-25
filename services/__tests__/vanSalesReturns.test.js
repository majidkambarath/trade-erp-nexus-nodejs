// Goods taken back on the van WITHOUT an invoice, and a reason on every return, against a throwaway database.
//
//   off by default   a salesman must name the invoice; a supervisor (vansales.manage) never has to
//   on               priced at what THIS customer pays today (their list, else the route's, else the item's price),
//                    locked; any goods item, even one never on the van; up to the organisation's limit (tax included)
//   the reason       in the organisation's own wording; required where no invoice stands behind the return
//   what is reused   ReturnService (no link, no invoice touched), costing (back at the average cost), the van's stock
//                    arithmetic (good back on the van, damaged apart)
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vret_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
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
    Report: require("../vansales/vanSalesReportService"),
    Settings: require("../vansales/vanSettingsService"),
    Lists: require("../vansales/priceListService"),
    ChartSeed: require("../financial/defaultChartService"),
    Transaction: require("../../models/modules/transactionModel"),
    VanTrip: require("../../models/modules/vansales/vanTripModel"),
    Stock: require("../../models/modules/stockModel"),
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

let salesman, A, B, rice, oil, sample, service, trip;
const by = () => String(salesman._id);
const SUPERVISOR = { mayUnderprice: true };
const giveBack = (input, opts) => svc.Sales.returnGoods(trip._id, { customerId: A._id, ...input }, by(), ...(opts ? [opts] : []));
const quote = (input, opts = {}) => svc.Sales.returnQuote(trip._id, { customerId: A._id, ...input }, opts);
const returnsCount = () => svc.Transaction.countDocuments({ type: "sales_return" });
const onHand = async (item) => r2((await svc.Stock.findById(item._id)).currentStock);

test("setup: rice on the van, oil and a free sample in the depot only, a service, Al Noor on its own price list", { skip }, async () => {
  salesman = await svc.Admin.create({ name: "Rashid", email: `rashid.ret.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Wholesale Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  const mk = (id, name) => svc.Customer.create({ customerId: id, customerName: name, contactPerson: name, phone: "0500000000", shippingAddress: "Dubai", paymentTerms: "Net 30" });
  [A, B] = await Promise.all([mk("C1", "Al Noor"), mk("C2", "Bin Zayed")]);
  const cat = await svc.Category.create({ name: "Food" });
  const item = (sku, name, salesPrice, extra = {}) => svc.StockService.createStock({ categoryId: cat._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku, itemName: name, salesPrice, ...extra }, "tester");
  rice = await item("RICE", "Rice 5kg", 20);
  oil = await item("OIL", "Oil 1L", 30);
  sample = await item("SMP", "Sample sachet", 0);
  service = await item("SRV", "Delivery charge", 15, { itemType: "service" });
  const po = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [
    { itemId: rice._id, description: "Rice", qty: 200, price: 10, vatPercent: 0 },
    { itemId: oil._id, description: "Oil", qty: 50, price: 12, vatPercent: 0 },
  ] }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");
  await svc.Lists.create({ name: "Al Noor deal", customerIds: [String(A._id)], lines: [{ stockId: String(rice._id), price: 17 }] }, "tester");

  const van = await svc.Van.create({ code: "VAN-R", name: "Van R", salesmanId: by() }, "tester");
  trip = await svc.Trip.open({ vanId: van._id }, "tester");
  await svc.Trip.load(trip._id, { lines: [{ stockId: String(rice._id), qty: 50 }] }, "tester");
  await svc.Trip.depart(trip._id, "tester");
});

test("off by default: a salesman must name the invoice; a supervisor never has to", { skip }, async () => {
  assert.equal((await svc.Settings.settings()).returnsWithoutInvoice, false);
  const before = await returnsCount();
  await assert.rejects(() => giveBack({ reason: "Expired", lines: [{ stockId: rice._id, qty: 1 }] }), { code: "VAN_RETURN_LINK_REQUIRED" });
  await assert.rejects(() => quote({ lines: [{ stockId: rice._id, qty: 1 }] }), { code: "VAN_RETURN_LINK_REQUIRED" });
  assert.equal(await returnsCount(), before, "nothing written");

  const { creditNote } = await giveBack({ reason: "expired", lines: [{ stockId: rice._id, qty: 1 }] }, SUPERVISOR);
  assert.equal(creditNote.status, "APPROVED");
  assert.ok(!creditNote.returnOf?.transactionId, "no invoice stands behind it");
  const rec = (await svc.VanTrip.findById(trip._id).lean()).returns.at(-1);
  assert.equal(rec.reason, "Expired", "stored in the organisation's own wording");
  assert.equal(rec.withoutInvoice, true);
  assert.equal(rec.amount, r2(creditNote.totalAmount));
});

test("switched on: priced at the customer's own price, locked; the books, the van and no invoice touched", { skip }, async () => {
  await svc.Settings.save({ returnsWithoutInvoice: true, maxReturnWithoutInvoice: 1000 });
  const sale = await svc.Sales.sell(trip._id, { customerId: A._id, items: [{ itemId: rice._id, qty: 4, vatPercent: 0 }] }, by());
  const owedBefore = r2(sale.invoice.outstandingAmount);
  const riceBooks = await onHand(rice);
  const oilBooks = await onHand(oil);
  const oilCost = r2((await svc.Stock.findById(oil._id)).purchasePrice);
  const vanBefore = await svc.Trip.getById(trip._id);
  const riceOnVan = vanBefore.sellable.find((l) => l.stockId === String(rice._id)).qty;

  const lines = [{ stockId: rice._id, qty: 2 }, { stockId: oil._id, qty: 1, condition: "damaged" }];
  const q = await quote({ lines });
  assert.deepEqual(q.lines.map((l) => l.price), [17, 30], "Al Noor's list price for rice; oil (never on the van) at its own price");
  assert.equal(q.overLimit, false);

  const { creditNote } = await giveBack({ reason: "Not selling", note: "Slow line", lines });
  assert.equal(r2(creditNote.totalAmount), q.total, "the quote is what was credited");
  assert.match(creditNote.notes, /Not selling\. Slow line/);
  assert.equal(r2((await svc.Transaction.findById(sale.invoice._id)).outstandingAmount), owedBefore, "no invoice is touched: the credit sits on the account");

  assert.equal(await onHand(rice), riceBooks + 2, "both lines come back into the books");
  assert.equal(await onHand(oil), oilBooks + 1);
  assert.equal(r2((await svc.Stock.findById(oil._id)).purchasePrice), oilCost, "back at the average cost: the average does not move");
  const after = await svc.Trip.getById(trip._id);
  assert.equal(after.sellable.find((l) => l.stockId === String(rice._id)).qty, riceOnVan + 2, "sellable rice goes back on the van");
  assert.equal(after.damaged.find((l) => l.stockId === String(oil._id)).qty, 1, "the damaged oil is kept apart for the count-in");
});

test("the reason: required with no invoice, must be on the list; optional against an invoice, kept when given", { skip }, async () => {
  const lines = [{ stockId: rice._id, qty: 1 }];
  await assert.rejects(() => giveBack({ lines }), { code: "RETURN_REASON_REQUIRED" });
  await assert.rejects(() => giveBack({ reason: ["Expired"], lines }), { code: "RETURN_REASON_REQUIRED" });
  await assert.rejects(() => giveBack({ reason: "Fell off the van", lines }), { code: "RETURN_REASON_UNKNOWN" });

  const sale = await svc.Sales.sell(trip._id, { customerId: A._id, items: [{ itemId: rice._id, qty: 3, vatPercent: 0 }] }, by());
  const lineId = String(sale.invoice.items[0]._id);
  const plain = await giveBack({ returnOfId: sale.invoice._id, lines: [{ lineId, qty: 1 }] });
  assert.equal(String(plain.creditNote.returnOf.transactionId), String(sale.invoice._id), "an older caller with no reason still works");
  await giveBack({ returnOfId: sale.invoice._id, reason: "Wrong item delivered", lines: [{ lineId, qty: 1 }] });
  const recs = (await svc.VanTrip.findById(trip._id).lean()).returns.slice(-2);
  assert.equal(recs[0].reason, undefined);
  assert.equal(recs[0].withoutInvoice, false);
  assert.equal(recs[1].reason, "Wrong item delivered");
  await assert.rejects(() => giveBack({ returnOfId: sale.invoice._id, reason: "Nope", lines: [{ lineId, qty: 1 }] }), { code: "RETURN_REASON_UNKNOWN" }, "a reason given must still be a real one");

  await svc.Settings.save({ returnReasons: ["Expired", "Short dated"] });
  const { creditNote } = await giveBack({ reason: "short DATED", lines });
  assert.equal((await svc.VanTrip.findById(trip._id).lean()).returns.at(-1).reason, "Short dated", "an edited list is the list");
  assert.ok(creditNote);
  await assert.rejects(() => giveBack({ reason: "Not selling", lines }), { code: "RETURN_REASON_UNKNOWN" }, "a reason taken off the list is no longer offered");
  await svc.Settings.save({ returnReasons: require("../../utils/vanSettings").RETURN_REASONS });
});

test("the limit: over it a salesman is refused and nothing is written; the quote says so first; a supervisor goes through", { skip }, async () => {
  await svc.Settings.save({ maxReturnWithoutInvoice: 50 });
  const lines = [{ stockId: rice._id, qty: 3 }]; // 3 x 17 = 51 before any tax
  const q = await quote({ lines });
  assert.ok(q.total > 50 && q.overLimit, "the screen is told before anything is saved");
  assert.equal((await quote({ lines }, SUPERVISOR)).overLimit, false, "never over a supervisor's limit");
  const before = await returnsCount();
  const recordsBefore = (await svc.VanTrip.findById(trip._id).lean()).returns.length;
  const books = await onHand(rice);
  await assert.rejects(() => giveBack({ reason: "Expired", lines }), (e) => e.code === "VAN_RETURN_OVER_LIMIT" && e.details.limit === 50 && e.details.amount === q.total);
  assert.equal(await returnsCount(), before, "the priced draft rolled back");
  assert.equal((await svc.VanTrip.findById(trip._id).lean()).returns.length, recordsBefore);
  assert.equal(await onHand(rice), books, "no stock came back");

  const ok = await giveBack({ reason: "Expired", lines: [{ stockId: rice._id, qty: 2 }] });
  assert.ok(ok.creditNote.totalAmount <= 50, "under the limit a salesman goes through");
  const sup = await giveBack({ reason: "Expired", lines }, SUPERVISOR);
  assert.equal(r2(sup.creditNote.totalAmount), q.total);
  await svc.Settings.save({ maxReturnWithoutInvoice: 1000 });
});

test("the price is locked, the lines are goods, each once, with a price to credit", { skip }, async () => {
  await assert.rejects(() => giveBack({ reason: "Expired", lines: [{ stockId: rice._id, qty: 1, price: 25 }] }), (e) => e.code === "PRICE_LOCKED" && e.details.listPrice === 17);
  await assert.rejects(() => quote({ lines: [{ stockId: rice._id, qty: 1, price: 5 }] }), { code: "PRICE_LOCKED" });
  const sup = await giveBack({ reason: "Expired", lines: [{ stockId: rice._id, qty: 1, price: 5 }] }, SUPERVISOR);
  assert.equal(sup.creditNote.items[0].price, 5, "a supervisor may set the price");
  await assert.rejects(() => giveBack({ reason: "Expired", lines: [{ stockId: sample._id, qty: 1 }] }), { code: "RETURN_NO_PRICE" });
  await assert.rejects(() => giveBack({ reason: "Expired", lines: [{ stockId: service._id, qty: 1 }] }), { code: "VAN_GOODS_ONLY" });
  await assert.rejects(() => giveBack({ reason: "Expired", lines: [{ stockId: rice._id, qty: 1 }, { stockId: rice._id, qty: 2 }] }), { code: "ITEM_REPEATED" });
  await assert.rejects(() => giveBack({ reason: "Expired", lines: [{ stockId: rice._id, qty: { $gt: 0 } }] }), { code: "QTY_INVALID" });
  await assert.rejects(() => giveBack({ reason: "Expired", lines: [{ stockId: "nope", qty: 1 }] }), { code: "ITEM_INVALID" });
  await assert.rejects(() => giveBack({ reason: "Expired", lines: [] }), { code: "ITEMS_REQUIRED" });
  await assert.rejects(() => giveBack({ returnOfId: "nope", reason: "Expired", lines: [{ lineId: "x", qty: 1 }] }), { code: "ORIGINAL_NOT_FOUND" });
});

test("switched off again: goods taken back at all, and without an invoice, follow the organisation", { skip }, async () => {
  await svc.Settings.save({ returnsWithoutInvoice: false });
  await assert.rejects(() => giveBack({ reason: "Expired", lines: [{ stockId: rice._id, qty: 1 }] }), { code: "VAN_RETURN_LINK_REQUIRED" });
  await svc.Settings.save({ returnsAllowed: false });
  await assert.rejects(() => giveBack({ reason: "Expired", lines: [{ stockId: rice._id, qty: 1 }] }, SUPERVISOR), { code: "VAN_RETURNS_OFF" }, "the business takes none back on the van, whoever asks");
  await svc.Settings.save({ returnsAllowed: true, returnsWithoutInvoice: true });
});

test("the owner's report: returns by reason, from the credit notes that still stand", { skip }, async () => {
  const { returnsByReason } = await svc.Report.summary({});
  const stored = (await svc.VanTrip.findById(trip._id).lean()).returns;
  assert.equal(returnsByReason.reduce((n, r) => n + r.count, 0), stored.length, "every return on the trip is counted once");
  const expired = returnsByReason.find((r) => r.reason === "Expired");
  assert.ok(expired.withoutInvoice >= 1);
  const notGiven = returnsByReason.find((r) => r.reason === "Not given");
  assert.equal(notGiven.count, 1, "the invoice return made without a reason");
  const credited = await svc.Transaction.find({ _id: { $in: stored.map((r) => r.transactionId) } }).select("totalAmount").lean();
  assert.equal(r2(returnsByReason.reduce((t, r) => t + r.amount, 0)), r2(credited.reduce((t, d) => t + d.totalAmount, 0)), "the amounts are the credit notes'");
});
