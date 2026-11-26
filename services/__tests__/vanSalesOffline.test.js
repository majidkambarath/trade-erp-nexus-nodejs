// Van sales phase 3 against a throwaway database: working with no signal.
//
// A van set up for it takes a block of invoice numbers when it goes out; the phone keeps an offline pack (the van's
// stock, the customers, their prices, the free numbers); what it did offline is sent back as operations, each applied
// in one transaction with its operation record, so sending the same operations twice makes nothing twice; one refused
// operation does not stop the others; a number from outside the block, or one already used, is refused; the numbers
// the van did not use are retired with a reason when it is counted in.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

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
    Sync: require("../vansales/vanSyncService"),
    Chart: require("../financial/defaultChartService"),
    Transaction: require("../../models/modules/transactionModel"),
    Category: require("../../models/modules/categoryModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Admin: require("../../models/core/adminModel"),
    VanVisit: require("../../models/modules/vansales/vanVisitModel"),
    IssuedNumber: require("../../models/modules/financial/issuedNumberModel"),
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

let salesman, A, rice, trip, pack, ops;
const by = () => String(salesman._id);

test("setup: a van that may sell with no signal goes out with five invoice numbers of its own", { skip }, async () => {
  salesman = await svc.Admin.create({ name: "Rashid", email: `rashid3.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Wholesale Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  A = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "Noor", phone: "0500000000", shippingAddress: "Dubai", paymentTerms: "Cash" });
  const cat = await svc.Category.create({ name: "Food" });
  rice = await svc.StockService.createStock({ categoryId: cat._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku: "RICE", itemName: "Rice 5kg", salesPrice: 20 }, "tester");
  const po = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: rice._id, description: "Rice", qty: 100, price: 10, rate: 10, vatPercent: 0 }] }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");

  await assert.rejects(() => svc.Van.create({ code: "BAD", name: "x", offlineBlock: 500 }, "tester"), { code: "VAN_OFFLINE_BLOCK_INVALID" });
  const van = await svc.Van.create({ code: "VAN-1", name: "Van One", salesmanId: by(), offlineBlock: 5 }, "tester");
  trip = await svc.Trip.open({ vanId: van._id }, "tester");
  await svc.Trip.load(trip._id, { lines: [{ stockId: String(rice._id), qty: 20 }] }, "tester");
  trip = await svc.Trip.depart(trip._id, "tester");
  assert.equal(trip.numberBlock.length, 5);
  for (const n of trip.numberBlock) assert.match(n, /^SO-/);
  assert.equal(await svc.IssuedNumber.countDocuments({ number: { $in: trip.numberBlock }, status: "issued" }), 5, "issued by the counter: nobody else can be given them");
});

test("a van that works online takes no numbers with it", { skip }, async () => {
  const van = await svc.Van.create({ code: "VAN-2", name: "Van Two", salesmanId: by() }, "tester");
  const t = await svc.Trip.open({ vanId: van._id }, "tester");
  await svc.Trip.load(t._id, { lines: [{ stockId: String(rice._id), qty: 1 }] }, "tester");
  const out = await svc.Trip.depart(t._id, "tester");
  assert.equal(out.numberBlock.length, 0);
  await svc.Trip.cancel(t._id, "tester");
});

test("the offline pack holds the van, the customer's prices and the free numbers, stamped with when it was read", { skip }, async () => {
  pack = await svc.Sales.offlinePack(trip._id, { extraCustomerIds: [String(A._id)] });
  assert.ok(pack.at);
  assert.equal(pack.trip.sellable[0].qty, 20);
  // a scanner finds the item with no signal: the pack carries its SKU and barcode (the SKU stands in when none was given)
  assert.equal(pack.trip.sellable[0].sku, "RICE");
  assert.equal(pack.trip.sellable[0].barcode, "RICE");
  assert.deepEqual(pack.customers.map((c) => c.name), ["Al Noor"]);
  assert.equal(pack.prices[String(A._id)][String(rice._id)], 20);
  assert.deepEqual(pack.freeNumbers, trip.numberBlock);
});

test("what was done offline is applied in order, the invoice carries the number its slip was printed with", { skip }, async () => {
  ops = [
    { clientId: "op-1", kind: "sell", at: new Date().toISOString(), body: { customerId: String(A._id), number: pack.freeNumbers[0], items: [{ itemId: String(rice._id), qty: 3, price: 20, vatPercent: 0 }] } },
    { clientId: "op-2", kind: "collect", at: new Date().toISOString(), body: { customerId: String(A._id), amount: 60, mode: "cash" } },
    { clientId: "op-3", kind: "visit", at: new Date().toISOString(), body: { customerId: String(A._id), reason: "has_stock" } },
  ];
  const out = await svc.Sync.sync(trip._id, ops, by());
  assert.equal(out.applied, 3, JSON.stringify(out.results));
  assert.equal(out.results[0].result.invoiceNo, pack.freeNumbers[0]);
  const inv = await svc.Transaction.findOne({ transactionNo: pack.freeNumbers[0] });
  assert.equal(inv.status, "APPROVED");
  assert.equal(String(inv.vanTripRef.tripId), String(trip._id));
  assert.equal(inv.outstandingAmount, 0, "the cash taken offline settled it");
});

test("sending the same operations again makes nothing twice", { skip }, async () => {
  const before = await svc.Transaction.countDocuments({ type: "sales_order" });
  const visits = await svc.VanVisit.countDocuments({});
  const out = await svc.Sync.sync(trip._id, ops, by());
  assert.equal(out.applied, 3);
  assert.ok(out.results.every((r) => r.repeat), JSON.stringify(out.results));
  assert.equal(out.results[0].result.invoiceNo, pack.freeNumbers[0], "the first answer comes back");
  assert.equal(await svc.Transaction.countDocuments({ type: "sales_order" }), before);
  assert.equal(await svc.VanVisit.countDocuments({}), visits);
});

test("one refused operation does not stop the rest, and says why", { skip }, async () => {
  const out = await svc.Sync.sync(trip._id, [
    { clientId: "op-4", kind: "sell", body: { customerId: String(A._id), number: pack.freeNumbers[1], items: [{ itemId: String(rice._id), qty: 999, price: 20, vatPercent: 0 }] } },
    { clientId: "op-5", kind: "sell", body: { customerId: String(A._id), number: pack.freeNumbers[0], items: [{ itemId: String(rice._id), qty: 1, price: 20, vatPercent: 0 }] } },
    { clientId: "op-6", kind: "sell", body: { customerId: String(A._id), number: "SO-1999-9999", items: [{ itemId: String(rice._id), qty: 1, price: 20, vatPercent: 0 }] } },
    { clientId: "op-7", kind: "sell", body: { customerId: String(A._id), number: pack.freeNumbers[1], items: [{ itemId: String(rice._id), qty: 2, price: 20, vatPercent: 0 }] } },
    { clientId: "", kind: "sell", body: {} },
  ], by());
  assert.deepEqual(out.results.map((r) => r.ok ? "ok" : r.error.code), ["VAN_STOCK_SHORT", "NUMBER_ALREADY_USED", "NUMBER_NOT_RESERVED", "ok", "OP_INVALID"]);
  assert.equal(out.results[3].result.invoiceNo, pack.freeNumbers[1]);
});

test("an online sale on the same trip takes the ordinary next number, never one from the block", { skip }, async () => {
  const { invoice } = await svc.Sales.sell(trip._id, { customerId: A._id, items: [{ itemId: rice._id, qty: 1, price: 20, vatPercent: 0 }] }, by());
  assert.ok(!trip.numberBlock.includes(invoice.transactionNo), invoice.transactionNo);
});

test("counting in retires the numbers the van did not use, with the trip named as the reason", { skip }, async () => {
  const t = await svc.Trip.getById(trip._id);
  await svc.Settle.unload(trip._id, { counts: t.sellable.map((l) => ({ stockId: l.stockId, good: l.qty, damaged: 0 })) }, by());
  const unused = trip.numberBlock.slice(2);
  const rows = await svc.IssuedNumber.find({ number: { $in: unused } }).lean();
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.status, "cancelled", "an invoice number is never given out twice");
    assert.match(r.reason, new RegExp(trip.tripNo));
  }
  const usedRows = await svc.IssuedNumber.find({ number: { $in: trip.numberBlock.slice(0, 2) } }).lean();
  assert.ok(usedRows.every((r) => r.status === "issued"), "the two used numbers stay issued");
  await assert.rejects(() => svc.Sync.sync(trip._id, [{ clientId: "op-8", kind: "sell", body: { customerId: String(A._id), items: [{ itemId: String(rice._id), qty: 1 }] } }], by()).then((o) => { if (!o.results[0].ok) throw Object.assign(new Error(o.results[0].error.message), { code: o.results[0].error.code }); }), { code: "TRIP_NOT_SELLING" });
});
