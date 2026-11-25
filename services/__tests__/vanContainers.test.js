// Returnable containers on the vans (crates, bottles), against a throwaway database: the types, what a sale hands out,
// what comes back, what each customer holds, the deposit as its own note against a liability, and the count-in.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vcn_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
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
    Report: require("../vansales/vanSalesReportService"),
    Containers: require("../vansales/vanContainerService"),
    AccountConfig: require("../financial/accountConfigService"),
    ChartSeed: require("../financial/defaultChartService"),
    Transaction: require("../../models/modules/transactionModel"),
    Voucher: require("../../models/modules/financial/financialModels").Voucher,
    LedgerEntry: require("../../models/modules/financial/financialModels").LedgerEntry,
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    Move: require("../../models/modules/vansales/vanContainerMoveModel"),
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

let salesman, A, B, water, milk, bread, trip, bottle, crate;
const by = () => String(salesman._id);
const sell = (customer, items, extra = {}) => svc.Sales.sell(trip._id, { customerId: customer._id, items: items.map(([item, qty]) => ({ itemId: item._id, qty, vatPercent: 0 })), ...extra }, by());
const holds = async (customer) => Object.fromEntries((await svc.Containers.balances(customer._id)).map((b) => [b.code, b.holds]));
const legsOf = async (voucherId) => svc.LedgerEntry.find({ voucherId, isReversed: { $ne: true } }).lean();
const depositAccount = async () => String(await svc.AccountConfig.resolveAccount("container-deposits"));

test("setup: water, milk and bread on a van that is out", { skip }, async () => {
  salesman = await svc.Admin.create({ name: "Rashid", email: `rashid.cn.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Wholesale Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  const mk = (id, name, terms) => svc.Customer.create({ customerId: id, customerName: name, contactPerson: name, phone: "0500000000", shippingAddress: "Dubai", paymentTerms: terms });
  [A, B] = await Promise.all([mk("C1", "Al Noor", "Net 30"), mk("C2", "Bin Zayed", "Net 30")]);
  const cat = await svc.Category.create({ name: "Drinks" });
  const item = (sku, name, price) => svc.StockService.createStock({ categoryId: cat._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku, itemName: name, salesPrice: price }, "tester");
  water = await item("W19", "Water 19L", 12);
  milk = await item("MLK", "Milk 1L", 5);
  bread = await item("BRD", "Bread", 3);
  const po = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [
    { itemId: water._id, description: "Water", qty: 100, price: 6, vatPercent: 0 }, { itemId: milk._id, description: "Milk", qty: 100, price: 3, vatPercent: 0 }, { itemId: bread._id, description: "Bread", qty: 50, price: 1, vatPercent: 0 },
  ] }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");
  const van = await svc.Van.create({ code: "VAN-1", name: "Van One", salesmanId: by() }, "tester");
  trip = await svc.Trip.open({ vanId: van._id }, "tester");
  await svc.Trip.load(trip._id, { lines: [{ stockId: String(water._id), qty: 40 }, { stockId: String(milk._id), qty: 30 }, { stockId: String(bread._id), qty: 10 }] }, "tester");
  await svc.Trip.depart(trip._id, "tester");
});

test("with no container types a sale is exactly as before", { skip }, async () => {
  const sold = await sell(A, [[water, 1]]);
  assert.equal(sold.deposit, 0);
  assert.deepEqual(sold.containers, []);
  assert.equal(await svc.Move.countDocuments({}), 0);
  assert.deepEqual((await svc.Sales.customerPosition(A._id)).containers, []);
});

test("the types: each item in one container, codes unique, services refused", { skip }, async () => {
  bottle = await svc.Containers.create({ code: "B19", name: "19L bottle", deposit: 10, items: [{ stockId: String(water._id), perUnit: 1 }] }, by());
  crate = await svc.Containers.create({ code: "CR12", name: "Milk crate", items: [{ stockId: String(milk._id), perUnit: 1 / 12 }] }, by());
  assert.equal(crate.deposit, 0);
  await assert.rejects(() => svc.Containers.create({ code: "B19", name: "Other" }, by()), { code: "CONTAINER_CODE_TAKEN" });
  await assert.rejects(() => svc.Containers.create({ code: "B5", name: "5L bottle", items: [{ stockId: String(water._id), perUnit: 1 }] }, by()), { code: "ITEM_IN_OTHER_CONTAINER" });
  await assert.rejects(() => svc.Containers.update(crate.id, { deposit: -2 }, by()), { code: "CONTAINER_DEPOSIT_INVALID" });
});

test("a sale hands out what its goods take; the deposit is a debit note to the customer against the liability, out of scope", { skip }, async () => {
  await svc.Containers.ensureAccount();
  const sold = await sell(A, [[water, 3], [milk, 13], [bread, 2]]);
  assert.deepEqual(sold.containers.map((m) => [m.name, m.given, m.collected]).sort(), [["19L bottle", 3, 0], ["Milk crate", 2, 0]]);
  assert.equal(sold.deposit, 30, "3 bottles at 10; a crate has no deposit");
  const note = await svc.Voucher.findOne({ voucherNo: sold.depositNote }).lean({ strict: false });
  assert.equal(note.voucherType, "debit_note");
  assert.equal(String(note.vanTripRef.tripId), String(trip._id));
  const legs = await legsOf(note._id);
  const depositId = await depositAccount();
  const liability = legs.find((l) => String(l.accountId) === depositId);
  assert.equal(r2(liability.creditAmount), 30, "held as a liability, never sales");
  assert.ok(!legs.some((l) => /Sales Revenue|Output VAT/i.test(l.accountName || "")));
  const outOfScope = await svc.TaxCode.findOne({ kind: "out_of_scope", isActive: true }).lean();
  if (outOfScope) assert.equal(String(note.noteLines[0].taxCodeId), String(outOfScope._id), "the VAT return does not list it as unclassified");
  assert.deepEqual(await holds(A), { B19: 3, CR12: 2 });
  assert.deepEqual((await svc.Sales.customerPosition(A._id)).containers.map((c) => [c.code, c.holds, c.depositHeld]).sort(), [["B19", 3, 30], ["CR12", 2, 0]]);
});

test("the full amount at the door is the invoice and the deposit together", { skip }, async () => {
  const sold = await sell(B, [[water, 2]], { payNow: { mode: "cash", full: true } });
  assert.equal(sold.deposit, 20);
  assert.equal(r2(sold.receipt.totalAmount), r2(sold.invoice.totalAmount) + 20);
  assert.equal(r2((await svc.Transaction.findById(sold.invoice._id)).outstandingAmount), 0, "the invoice is paid; the deposit sits on account against its note");
});

test("collected back: counted by the salesman, refunded against the invoice it came with; never more than they hold", { skip }, async () => {
  await assert.rejects(() => sell(A, [[water, 1]], { containers: [{ typeId: bottle.id, given: 1, collected: 9 }] }), { code: "CONTAINERS_NOT_HELD" });
  const sold = await sell(A, [[water, 2]], { containers: [{ typeId: bottle.id, given: 2, collected: 4 }] });
  assert.equal(sold.deposit, -20);
  const note = await svc.Voucher.findOne({ voucherNo: sold.depositNote }).lean();
  assert.equal(note.voucherType, "credit_note");
  assert.equal(r2((await svc.Transaction.findById(sold.invoice._id)).outstandingAmount), r2(sold.invoice.totalAmount) - 20, "the refund is set against the invoice: the customer pays 4 less");
  assert.equal((await holds(A)).B19, 1);
  const sup = await svc.Sales.sell(trip._id, { customerId: B._id, items: [{ itemId: bread._id, qty: 1, vatPercent: 0 }], containers: [{ typeId: bottle.id, collected: 5 }] }, by(), { mayUnderprice: true });
  assert.equal(sup.deposit, -50, "a supervisor may take back what the records do not show");
});

test("empties at a stop with no sale, and a supervisor setting what a customer already held", { skip }, async () => {
  const r = await svc.Containers.empties(trip._id, { customerId: String(A._id), containers: [{ typeId: bottle.id, collected: 1 }, { typeId: crate.id, collected: 2 }] }, by());
  assert.equal(r.deposit, -10);
  assert.equal(r.voucher.voucherType, "credit_note");
  assert.deepEqual(await holds(A), { B19: 0, CR12: 0 });
  await assert.rejects(() => svc.Containers.empties(trip._id, { customerId: String(A._id), containers: [] }, by()), { code: "CONTAINERS_REQUIRED" });

  await assert.rejects(() => svc.Containers.adjust({ customerId: String(A._id), typeId: bottle.id, holds: 6 }, by()), { code: "REASON_REQUIRED" });
  const set = await svc.Containers.adjust({ customerId: String(A._id), typeId: bottle.id, holds: 6, reason: "Held before go-live" }, by());
  assert.equal(set.holds, 6);
  assert.equal(set.deposit, 0, "an adjustment is a record, not a sale or a refund");
  assert.equal((await holds(A)).B19, 6);
});

test("deleting an invoice leaves the containers that really changed hands", { skip }, async () => {
  const sold = await sell(A, [[water, 1]]);
  const before = await svc.Move.countDocuments({ transactionId: sold.invoice._id });
  await svc.Tx.deleteTransaction(sold.invoice._id, "tester");
  assert.equal(await svc.Move.countDocuments({ transactionId: sold.invoice._id }), before);
  assert.equal((await holds(A)).B19, 7);
});

test("count-in: what the van should bring back, two bottles missing charged to the salesman at their deposit", { skip }, async () => {
  const preview = await svc.Containers.ofTrip(trip);
  const given = preview.filter((m) => String(m.typeId) === bottle.id).reduce((n, m) => n + m.given - m.collected, 0);
  const expectedBottles = 40 - given;
  const shown = await svc.Trip.getById(trip._id);
  const counts = shown.sellable.map((l) => ({ stockId: l.stockId, good: l.qty, damaged: 0 }));
  await svc.Settle.unload(trip._id, { counts, containers: [{ typeId: bottle.id, counted: expectedBottles - 2 }] }, by());
  const plan = await svc.Settle.preview(trip._id, {});
  const row = plan.containers.find((c) => c.typeId === bottle.id);
  assert.deepEqual([row.expected, row.counted, row.difference, row.value], [expectedBottles, expectedBottles - 2, -2, 20]);
  assert.equal(plan.containers.find((c) => c.typeId === crate.id).difference, 0, "a type not counted is taken as found");
  assert.ok(plan.warnings.some((w) => w.code === "CONTAINER_DIFFERENCE"));
  await assert.rejects(() => svc.Settle.settle(trip._id, { cashHanded: plan.cash.expected, acknowledge: plan.warnings.filter((w) => w.code !== "CONTAINER_DIFFERENCE").map((w) => w.code) }, by()), { code: "VAN_SETTLE_WARNINGS" });
  const { trip: settled } = await svc.Settle.settle(trip._id, { cashHanded: plan.cash.expected, acknowledge: plan.warnings.map((w) => w.code) }, by());
  assert.equal(settled.settlement.containersMissing, 2);
  assert.equal(settled.settlement.containersMissingValue, 20);
  const journal = await legsOf(settled.settlement.voucherIds[0]);
  const shortages = String(await svc.AccountConfig.resolveAccount("salesman-shortages"));
  assert.ok(journal.some((l) => String(l.accountId) === shortages && r2(l.debitAmount) === 20), "the missing bottles' deposit is the salesman's");
  const row2 = (await svc.Report.summary({})).rows.find((r) => r.id === String(trip._id) || r.tripNo === trip.tripNo);
  assert.equal(row2.containersMissing, 2);
});
