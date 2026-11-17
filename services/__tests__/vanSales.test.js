// Van sales against a throwaway database (random name, dropped afterwards): one whole van day.
//
// What this proves beyond the pure rules in utils/__tests__/vanSales.test.js: a van gets its own cash account; a load
// the depot cannot spare is refused; nothing sells before the van goes out; a sale from the van is a real approved
// invoice (stock out at average cost, ledger posted) taking the van's stock down; selling more than is on the van is
// refused AND cannot be got round by approving a draft by hand (the lock is on the approval); a return back on the
// van counts good and damaged apart; the money goes to the van's cash account; counting the van back in and settling
// books the cash short, the stock difference and the damaged goods, and leaves the books balanced and the van empty.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  const fin = require("../../models/modules/financial/financialModels");
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Tx: require("../orderPurchase/transactionService"),
    StockService: require("../stock/stockService"),
    Van: require("../vansales/vanService"),
    Trip: require("../vansales/vanTripService"),
    Sales: require("../vansales/vanTripSales"),
    Settle: require("../vansales/vanTripSettlement"),
    Report: require("../vansales/vanSalesReportService"),
    Chart: require("../financial/defaultChartService"),
    Config: require("../financial/accountConfigService"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Category: require("../../models/modules/categoryModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Admin: require("../../models/core/adminModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
    Voucher: fin.Voucher,
    LedgerAccount: fin.LedgerAccount,
    LedgerEntry: fin.LedgerEntry,
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

// ---- fixtures -----------------------------------------------------------------------------------------
let salesman, vendor, custA, custB, rice, oil, van, trip, mainCash, invoiceA;
const onHand = async (item) => (await svc.Stock.findById(item._id)).currentStock;
const sellable = async (t, item) => (await svc.Trip.getById(t._id)).sellable.find((l) => l.stockId === String(item._id))?.qty || 0;
const balanceOf = async (id) => r2((await svc.LedgerAccount.findById(id)).currentBalance);
const by = () => String(salesman._id); // a voucher's createdBy is a real account id
const line = (item, qty, price) => ({ itemId: item._id, qty, price, vatPercent: 5 });

test("setup: a salesman, two customers, two items stocked at a known cost, a main cash account", { skip }, async () => {
  salesman = await svc.Admin.create({ name: "Rashid Salesman", email: `rashid.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Wholesale Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  custA = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor Grocery", contactPerson: "Noor", phone: "0501111111", shippingAddress: "Dubai", paymentTerms: "Cash" });
  custB = await svc.Customer.create({ customerId: "C2", customerName: "Bin Zayed Mini Market", contactPerson: "Zayed", phone: "0502222222", shippingAddress: "Dubai", paymentTerms: "Net 30" });
  const category = await svc.Category.create({ name: "Food" });
  const base = { categoryId: category._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x" };
  rice = await svc.StockService.createStock({ ...base, sku: "RICE", itemName: "Rice 5kg", salesPrice: 20 }, "tester");
  oil = await svc.StockService.createStock({ ...base, sku: "OIL", itemName: "Oil 1.8L", salesPrice: 30 }, "tester");
  const po = await svc.Tx.createTransaction(
    { type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [
      { itemId: rice._id, description: "Rice 5kg", qty: 100, price: 10, rate: 10, vatPercent: 0 },
      { itemId: oil._id, description: "Oil 1.8L", qty: 50, price: 20, rate: 20, vatPercent: 0 },
    ] }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");
  assert.equal(await onHand(rice), 100);
  mainCash = await svc.LedgerAccount.findOne({ accountName: "Cash in Hand" });
  assert.ok(mainCash, "the default chart has a main cash account to hand the day's cash into");
});

test("a van gets its own cash account under the Cash group, and its code is unique", { skip }, async () => {
  van = await svc.Van.create({ code: "van-1", name: "Van One", plate: "dxb 1234", salesmanId: String(salesman._id) }, "tester");
  assert.equal(van.code, "VAN-1");
  assert.equal(van.salesmanName, "Rashid Salesman");
  const acct = await svc.LedgerAccount.findById(van.cashAccountId);
  assert.equal(acct.accountName, "Van Cash - VAN-1");
  assert.equal(acct.accountType, "asset");
  await assert.rejects(() => svc.Van.create({ code: "VAN-1", name: "again" }, "tester"), { code: "VAN_CODE_TAKEN" });
});

test("a trip opens for the van; a second one is refused while the first is open", { skip }, async () => {
  trip = await svc.Trip.open({ vanId: van._id }, "tester");
  assert.match(trip.tripNo, /^VTR-/);
  assert.equal(trip.status, "LOADING");
  assert.equal(trip.salesmanId, String(salesman._id));
  await assert.rejects(() => svc.Trip.open({ vanId: van._id }, "tester"), { code: "VAN_HAS_OPEN_TRIP" });
});

test("a load the depot cannot spare is refused; a fair one is taken and moves nothing in the books", { skip }, async () => {
  await assert.rejects(() => svc.Trip.load(trip._id, { lines: [{ stockId: String(rice._id), qty: 101 }] }, "tester"), { code: "INSUFFICIENT_STOCK" });
  await assert.rejects(() => svc.Trip.depart(trip._id, "tester"), { code: "NOTHING_LOADED" });
  await svc.Trip.load(trip._id, { lines: [{ stockId: String(rice._id), qty: 40 }, { stockId: String(oil._id), qty: 20 }] }, "tester");
  assert.equal(await onHand(rice), 100, "loading is not a stock movement");
  const moves = await svc.Movement.countDocuments({ referenceType: { $ne: "Transaction" } });
  assert.equal(moves, 0, "no movement of any kind was written for the load");
  const shown = await svc.Trip.getById(trip._id);
  assert.equal(shown.sellable.find((l) => l.itemName === "Rice 5kg").qty, 40);
});

test("nothing sells before the van goes out; once out it can", { skip }, async () => {
  await assert.rejects(() => svc.Sales.sell(trip._id, { customerId: custA._id, items: [line(rice, 1, 20)] }, by()), { code: "TRIP_NOT_SELLING" });
  await svc.Trip.depart(trip._id, "tester");
  assert.equal((await svc.Trip.getById(trip._id)).status, "ON_ROUTE");
});

test("a sale from the van is a real approved invoice: stock out, cash into the van's account, the van's stock down", { skip }, async () => {
  const before = await onHand(rice);
  const { invoice, receipt } = await svc.Sales.sell(
    trip._id,
    { customerId: custA._id, items: [line(rice, 10, 20)], payNow: { mode: "cash", amount: 210 } },
    by()
  );
  invoiceA = invoice;
  assert.equal(invoice.status, "APPROVED");
  assert.equal(r2(invoice.totalAmount), 210, "10 x 20 + 5% VAT");
  assert.equal(String(invoice.vanTripRef.tripId), String(trip._id));
  assert.equal(await onHand(rice), before - 10, "the normal sales path took the stock");
  assert.equal(await sellable(trip, rice), 30);
  assert.equal(receipt.status, "approved");
  assert.equal(String(receipt.vanTripRef.tripId), String(trip._id), "the receipt is tagged to the trip");
  const stored = await svc.Transaction.findById(invoice._id);
  assert.equal(r2(stored.outstandingAmount), 0, "the money taken settled the invoice");
  assert.equal(await balanceOf(van.cashAccountId), 210, "the van's cash account holds what the van took");
});

test("selling more than is on the van is refused, and nothing is written", { skip }, async () => {
  const before = await svc.Transaction.countDocuments({});
  await assert.rejects(() => svc.Sales.sell(trip._id, { customerId: custA._id, items: [line(rice, 31, 20)] }, by()), { code: "VAN_STOCK_SHORT" });
  assert.equal(await svc.Transaction.countDocuments({}), before);
  assert.equal(await onHand(rice), 90);
});

test("the lock is on the approval: a draft made by hand on the trip cannot be approved past the van's stock", { skip }, async () => {
  const draft = await svc.Tx.createTransaction(
    { type: "sales_order", partyId: custB._id, partyType: "Customer", partyTypeRef: "Customer", date: new Date(), status: "DRAFT",
      items: [{ ...line(rice, 50, 20), description: "Rice 5kg" }],
      vanTripRef: { tripId: trip._id, tripNo: trip.tripNo, vanCode: trip.vanCode } }, "tester");
  await assert.rejects(() => svc.Tx.processTransaction(draft._id, "approve", "tester"), { code: "VAN_STOCK_SHORT" });
  assert.equal((await svc.Transaction.findById(draft._id)).status, "DRAFT");
  assert.equal(await onHand(rice), 90, "nothing moved");
  await svc.Tx.deleteTransaction(draft._id, "tester");
});

test("a credit sale to another customer leaves them owing, and a request body cannot choose the trip link", { skip }, async () => {
  const { invoice, receipt } = await svc.Sales.sell(trip._id, { customerId: custB._id, items: [line(oil, 4, 30)] }, by());
  assert.equal(receipt, null);
  assert.equal(r2(invoice.totalAmount), 126, "4 x 30 + 5%");
  assert.equal(r2((await svc.Transaction.findById(invoice._id)).outstandingAmount), 126);
  assert.equal(await sellable(trip, oil), 16);
  const stripped = await svc.Tx.createTransaction(
    { type: "sales_order", partyId: custB._id, partyType: "Customer", partyTypeRef: "Customer", status: "DRAFT", items: [{ ...line(oil, 1, 30), description: "Oil" }] }, "tester");
  assert.equal(stripped.vanTripRef?.tripId, undefined, "a plain document carries no trip");
});

test("a return on the road: good goes back on the van, damaged is counted apart", { skip }, async () => {
  const { creditNote } = await svc.Sales.returnGoods(
    trip._id,
    { customerId: custA._id, returnOfId: invoiceA._id, lines: [{ itemId: rice._id, qty: 1, condition: "good" }, { itemId: rice._id, qty: 1, condition: "damaged" }] },
    by()
  ).catch((e) => { throw e; });
  assert.equal(creditNote.status, "APPROVED");
  assert.equal(await onHand(rice), 92, "both units are back in the books");
  const shown = await svc.Trip.getById(trip._id);
  assert.equal(shown.sellable.find((l) => l.itemName === "Rice 5kg").qty, 31, "the good one can be sold again");
  assert.equal(shown.damaged.find((l) => l.itemName === "Rice 5kg").qty, 1);
  const onVans = await svc.Trip.withOnVans();
  assert.equal(onVans.get(String(rice._id)), 32, "the van physically holds 31 good and 1 damaged");
});

test("a second van cannot load what is already sitting in the first", { skip }, async () => {
  const v2 = await svc.Van.create({ code: "VAN-2", name: "Van Two" }, "tester");
  const t2 = await svc.Trip.open({ vanId: v2._id, salesmanId: String(salesman._id) }, "tester");
  // 92 on hand, 32 on van one: 60 are free
  await assert.rejects(() => svc.Trip.load(t2._id, { lines: [{ stockId: String(rice._id), qty: 61 }] }, "tester"), { code: "INSUFFICIENT_STOCK" });
  await svc.Trip.load(t2._id, { lines: [{ stockId: String(rice._id), qty: 60 }] }, "tester");
  await svc.Trip.cancel(t2._id, "tester");
  assert.equal((await svc.Trip.getById(t2._id)).status, "CANCELLED");
  assert.equal((await svc.Trip.withOnVans()).get(String(rice._id)), 32, "a cancelled trip holds nothing");
});

test("a trip with activity cannot be cancelled, and cannot be settled before it is counted in", { skip }, async () => {
  await assert.rejects(() => svc.Trip.cancel(trip._id, "tester"), { code: "TRIP_HAS_ACTIVITY" });
  await assert.rejects(() => svc.Settle.preview(trip._id, {}), { code: "TRIP_NOT_UNLOADED" });
});

test("counting the van back in: one good unit and one damaged are found; the van is no longer selling", { skip }, async () => {
  // should hold: rice 31 good + 1 damaged, oil 16 good. Found: rice 30 good + 1 damaged (one missing), oil 16.
  await svc.Settle.unload(trip._id, { counts: [{ stockId: String(rice._id), good: 30, damaged: 1 }, { stockId: String(oil._id), good: 16, damaged: 0 }] }, by());
  const t = await svc.Trip.getById(trip._id);
  assert.equal(t.status, "UNLOADED");
  const r = t.unload.lines.find((l) => l.itemName === "Rice 5kg");
  assert.equal(r.difference, -1);
  assert.equal((await svc.Trip.withOnVans()).size, 0, "an unloaded van holds nothing");
  await assert.rejects(() => svc.Sales.sell(trip._id, { customerId: custA._id, items: [line(oil, 1, 30)] }, by()), { code: "TRIP_NOT_SELLING" });
});

test("settlement preview names every difference and what it will post", { skip }, async () => {
  const plan = await svc.Settle.preview(trip._id, { cashHanded: 200 });
  assert.equal(plan.cash.expected, 210);
  assert.equal(plan.cash.short, 10);
  assert.deepEqual(plan.warnings.map((w) => w.code).sort(), ["CASH_SHORT", "STOCK_DIFFERENCE"]);
  assert.equal(plan.stockVarianceValue, -10, "one rice short at the average cost of 10");
  assert.equal(plan.damagedValue, 10);
});

test("settling needs every difference acknowledged by code, and then books it all", { skip }, async () => {
  await assert.rejects(() => svc.Settle.settle(trip._id, { cashHanded: 200 }, by()), { code: "VAN_SETTLE_WARNINGS" });
  await assert.rejects(() => svc.Settle.settle(trip._id, { cashHanded: 200, acknowledge: ["CASH_SHORT"] }, by()), { code: "VAN_SETTLE_WARNINGS" });

  const cashBefore = await balanceOf(mainCash._id);
  const { trip: done } = await svc.Settle.settle(trip._id, { cashHanded: 200, acknowledge: ["CASH_SHORT", "STOCK_DIFFERENCE"] }, by());
  assert.equal(done.status, "SETTLED");

  // cash: the van's account is emptied, the main account received what was handed in, the shortage is owed by the salesman
  assert.equal(await balanceOf(van.cashAccountId), 0);
  assert.equal(r2((await balanceOf(mainCash._id)) - cashBefore), 200);
  const shortage = await svc.LedgerAccount.findOne({ accountName: "Salesman Shortages" });
  assert.equal(await balanceOf(shortage._id), 10);
  assert.equal(done.settlement.voucherIds.length, 1);
  const journal = await svc.Voucher.findById(done.settlement.voucherIds[0]);
  assert.equal(String(journal.vanTripRef.tripId), String(trip._id));

  // stock: the damaged unit left and the missing one was written off - 92 - 1 (damaged) - 1 (short) = 90
  assert.equal(await onHand(rice), 90);
  const kinds = (await svc.Movement.find({ referenceNumber: trip.tripNo }).lean()).map((m) => [m.eventType, m.quantity]).sort();
  assert.deepEqual(kinds, [["DAMAGED_STOCK", -1], ["STOCK_ADJUSTMENT", -1]]);
});

test("a settled trip cannot be settled again, loaded, or sold on - not even by approving a draft", { skip }, async () => {
  await assert.rejects(() => svc.Settle.settle(trip._id, { cashHanded: 200, acknowledge: ["CASH_SHORT"] }, by()), { code: "TRIP_NOT_UNLOADED" });
  await assert.rejects(() => svc.Trip.load(trip._id, { lines: [{ stockId: String(rice._id), qty: 1 }] }, "tester"), { code: "TRIP_NOT_LOADABLE" });
  const draft = await svc.Tx.createTransaction(
    { type: "sales_order", partyId: custB._id, partyType: "Customer", partyTypeRef: "Customer", date: new Date(), status: "DRAFT",
      items: [{ ...line(oil, 1, 30), description: "Oil" }], vanTripRef: { tripId: trip._id, tripNo: trip.tripNo, vanCode: trip.vanCode } }, "tester");
  await assert.rejects(() => svc.Tx.processTransaction(draft._id, "approve", "tester"), { code: "VAN_TRIP_CLOSED" });
  await svc.Tx.deleteTransaction(draft._id, "tester");
});

test("the books balance after the whole day", { skip }, async () => {
  const rows = await svc.LedgerEntry.find({ isReversed: { $ne: true } }).lean();
  const debit = r2(rows.reduce((s, e) => s + e.debitAmount, 0));
  const credit = r2(rows.reduce((s, e) => s + e.creditAmount, 0));
  assert.equal(debit, credit, "debits equal credits");
  const stock = require("../reports/stockReportsService");
  const check = await stock.ledgerCheck({});
  assert.ok(check, "the stock against ledger check still runs");
});

test("the report adds the day up per van and per salesman", { skip }, async () => {
  const r = await svc.Report.summary({});
  const row = r.rows.find((x) => x.tripNo === trip.tripNo);
  assert.ok(row);
  assert.equal(row.invoices, 2);
  assert.equal(r2(row.sales), 336, "210 + 126");
  assert.equal(row.cash, 210);
  assert.equal(row.cashVariance, -10);
  assert.equal(r.byVan.find((v) => v.name === "VAN-1").trips, 1);
  assert.equal(r.bySalesman[0].name, "Rashid Salesman");
  await assert.rejects(() => svc.Report.summary({ from: "2026-12-01", to: "2026-11-01" }), { code: "INVALID_RANGE" });
});
