// Counting a van back in at the warehouse, against a throwaway database: a count must cover every item; what a van
// counted in holds back (damaged, expired, missing) is not free for another van or a job worker until it is settled;
// the batches a van's damaged returns went back into are not handed to an office sale meanwhile; goods taken back with
// no invoice carry the expiry printed on the pack, one batch per condition; settling keeps the numbers of the stock
// documents it wrote, and - where the organisation chose so - charges missing goods to the salesman.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vci_${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  const fin = require("../../models/modules/financial/financialModels");
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Org: require("../core/organisationService"),
    Tx: require("../orderPurchase/transactionService"),
    StockService: require("../stock/stockService"),
    Reservations: require("../stock/reservationService"),
    Reports: require("../reports/stockReportsService"),
    Van: require("../vansales/vanService"),
    Trip: require("../vansales/vanTripService"),
    Sales: require("../vansales/vanTripSales"),
    Settle: require("../vansales/vanTripSettlement"),
    Settings: require("../vansales/vanSettingsService"),
    Config: require("../financial/accountConfigService"),
    Chart: require("../financial/defaultChartService"),
    LedgerEntry: fin.LedgerEntry,
    Batch: require("../../models/modules/stockBatchModel"),
    Stock: require("../../models/modules/stockModel"),
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

const orgDay = (n = 0) => {
  const today = require("../../utils/documentExpiry").todayInOrg();
  return new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
};
const batches = async (stockId) => Object.fromEntries((await svc.Batch.find({ stockId }).lean()).map((b) => [b.batchNumber, b.qtyOnHand]));

let salesman, shopA, shopB, vendor, rice, oil, van, van2, trip;
const by = () => String(salesman._id);

test("setup: rice in an early and a late batch, oil, a van out with 20 rice and 6 oil", { skip }, async () => {
  salesman = await svc.Admin.create({ name: "Rashid", email: `rashid-ci.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Mill Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  shopA = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", shippingAddress: "Dubai", paymentTerms: "Net 30" });
  shopB = await svc.Customer.create({ customerId: "C2", customerName: "Bin Zayed", contactPerson: "x", shippingAddress: "Dubai", paymentTerms: "Net 30" });
  const cat = await svc.Category.create({ name: "Food" });
  const item = (sku, name, price) => svc.StockService.createStock({ categoryId: cat._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku, itemName: name, salesPrice: price }, "tester");
  rice = await item("RICE", "Rice 5kg", 20);
  oil = await item("OIL", "Oil 1L", 8);
  const po = await svc.Tx.createTransaction({
    type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor",
    items: [
      { itemId: rice._id, description: "Rice", qty: 10, price: 10, vatPercent: 0, batchNumber: "EARLY", expiryDate: orgDay(30) },
      { itemId: rice._id, description: "Rice", qty: 50, price: 10, vatPercent: 0, batchNumber: "LATE", expiryDate: orgDay(200) },
      { itemId: oil._id, description: "Oil", qty: 10, price: 4, vatPercent: 0 },
    ],
  }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");
  await svc.Settings.save({ returnsWithoutInvoice: true });
  van = await svc.Van.create({ code: "VAN-1", name: "Van One", salesmanId: by() }, "tester");
  van2 = await svc.Van.create({ code: "VAN-2", name: "Van Two", salesmanId: by() }, "tester");
  trip = await svc.Trip.open({ vanId: van._id }, "tester");
  await svc.Trip.load(trip._id, { lines: [{ stockId: String(rice._id), qty: 20 }, { stockId: String(oil._id), qty: 6 }] }, "tester");
  await svc.Trip.depart(trip._id, "tester");
});

test("goods taken back with no invoice carry the expiry printed on the pack, a batch per condition", { skip }, async () => {
  const { creditNotes } = await svc.Sales.returnItems(trip._id, {
    customerId: shopB._id, reason: "Expired",
    lines: [
      { stockId: String(rice._id), qty: 2, condition: "expired", expiryDate: orgDay(-3) },
      { stockId: String(rice._id), qty: 1, condition: "good", expiryDate: orgDay(90) },
    ],
  }, by());
  assert.equal(creditNotes.length, 1, "Bin Zayed never bought rice: one credit note with no invoice");
  const made = await svc.Batch.find({ sourceTransactionId: creditNotes[0]._id }).sort({ expiryDate: 1 }).lean();
  assert.deepEqual(made.map((b) => [b.qtyOnHand, b.expiryDate.toISOString().slice(0, 10)]), [[2, orgDay(-3)], [1, orgDay(90)]], "each condition its own batch, with the date on the pack");
  await assert.rejects(
    () => svc.Sales.returnItems(trip._id, { customerId: shopB._id, reason: "Expired", lines: [{ stockId: String(rice._id), qty: 1, condition: "expired", expiryDate: "2026-02-30" }] }, by()),
    { code: "EXPIRY_DATE_INVALID" }
  );
});

test("the batch a damaged return went back into is not handed to an office sale before the van is settled", { skip }, async () => {
  await svc.Sales.sell(trip._id, { customerId: shopA._id, items: [{ itemId: rice._id, qty: 5, vatPercent: 0 }] }, by());
  assert.equal((await batches(rice._id)).EARLY, 5, "the van's sale took the early batch first");
  await svc.Sales.returnItems(trip._id, { customerId: shopA._id, reason: "Damaged", lines: [{ stockId: String(rice._id), qty: 2, condition: "damaged" }] }, by());
  assert.equal((await batches(rice._id)).EARLY, 7, "the damaged rice went back into the batch it came from");
  const held = await svc.Settle.heldReturnBatches(rice._id);
  const early = await svc.Batch.findOne({ stockId: rice._id, batchNumber: "EARLY" }).lean();
  assert.equal(held.get(String(early._id)), 2, "the 2 damaged units in the early batch");
  assert.equal([...held.values()].reduce((t, q) => t + q, 0), 4, "and the 2 expired ones taken back with no invoice, in their own batch");
  // an office sale of 7: the 2 damaged units in EARLY are not on offer, so 5 come from EARLY and 2 from LATE
  const office = await svc.Tx.createTransaction({ type: "sales_order", partyId: shopA._id, partyType: "Customer", partyTypeRef: "Customer", items: [{ itemId: rice._id, description: "Rice", qty: 7, price: 20, vatPercent: 0 }] }, "tester");
  const approved = await svc.Tx.processTransaction(office._id, "approve", "tester");
  const doc = approved?.items ? approved : await require("../../models/modules/transactionModel").findById(office._id).lean();
  const took = Object.fromEntries((doc.items[0].allocations || []).map((a) => [a.batchNumber, a.qty]));
  assert.equal(took.EARLY, 5, "the 2 damaged units in the early batch were left alone");
  // the good rice taken back with no invoice is dated (90 days) so it goes before the late batch (200 days): it used to
  // have no date at all and was always taken last
  const goodBack = Object.keys(took).find((k) => /-R2$/.test(k));
  assert.deepEqual([took[goodBack], took.LATE], [1, 1]);
});

test("a count must cover every item on the van", { skip }, async () => {
  await assert.rejects(
    () => svc.Settle.unload(trip._id, { counts: [{ stockId: String(rice._id), good: 15, damaged: 2, expired: 2 }] }, "tester"),
    (err) => err.code === "COUNT_INCOMPLETE" && /Oil 1L/.test(err.message)
  );
});

test("what a counted-in van holds back is not free for another van until it is settled", { skip }, async () => {
  // the van should hold 18 sellable rice (20 - 5 + 1 good back + 2 ... ) as the trip works it out; count 1 short
  const t = await svc.Trip.getById(trip._id);
  const riceGood = t.sellable.find((l) => l.stockId === String(rice._id)).qty;
  await svc.Settle.unload(trip._id, { counts: [
    { stockId: String(rice._id), good: riceGood - 1, damaged: 2, expired: 2 },
    { stockId: String(oil._id), good: 6 },
  ] }, "tester");
  const free = (await svc.Reservations.free([String(rice._id)])).get(String(rice._id));
  assert.equal(free.countedIn, 5, "2 damaged + 2 expired + 1 missing");
  assert.equal(free.onVans, 0, "the van is back: nothing is on it");
  assert.equal(free.free, r2(free.onHand - 5));
  const trip2 = await svc.Trip.open({ vanId: van2._id }, "tester");
  await assert.rejects(
    () => svc.Trip.load(trip2._id, { lines: [{ stockId: String(rice._id), qty: free.free + 1 }] }, "tester"),
    (err) => err.code === "INSUFFICIENT_STOCK" && /waiting to be settled/.test(err.message)
  );
  await svc.Trip.load(trip2._id, { lines: [{ stockId: String(rice._id), qty: free.free }] }, "tester");
});

test("settling: missing goods charged to the salesman by choice, each stock document's number kept, nothing held back after", { skip }, async () => {
  await svc.Settings.save({ chargeMissingStock: true });
  const plan = await svc.Settle.preview(trip._id, {});
  assert.equal(plan.missingCharged, 10, "1 rice short at a cost of 10");
  const { trip: settled } = await svc.Settle.settle(trip._id, { cashHanded: plan.cash.expected, acknowledge: plan.warnings.map((w) => w.code) }, "tester");
  const docs = settled.settlement.stockDocs.map((d) => [d.kind, d.qty]);
  assert.deepEqual(docs.sort(), [["damaged", -2], ["difference", -1], ["expired", -2]]);
  assert.ok(settled.settlement.stockDocs.every((d) => /^(WO|SA)-/.test(d.number)), "each carries its number");
  assert.equal(settled.settlement.missingCharged, 10);
  const shortage = await svc.Config.resolveAccount("salesman-shortages");
  const charged = await svc.LedgerEntry.find({ accountId: shortage, voucherNo: settled.settlement.stockDocs.find((d) => d.kind === "difference").number }).lean();
  assert.equal(r2(charged.reduce((t, e) => t + e.debitAmount - e.creditAmount, 0)), 10, "the missing rice is the salesman's to make good");
  const free = (await svc.Reservations.free([String(rice._id)])).get(String(rice._id));
  assert.equal(free.countedIn, 0, "a settled van holds nothing back");
  assert.equal((await svc.Settle.heldReturnBatches(rice._id)).size, 0, "nor any batch");
  const check = await svc.Reports.ledgerCheck();
  assert.equal(check.reconciles, true, JSON.stringify(check.lines));
  await svc.Settings.save({ chargeMissingStock: false });
});
