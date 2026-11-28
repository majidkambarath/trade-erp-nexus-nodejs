// Road spending beyond the cash taken, against a throwaway database: the settlement shows what the salesman is owed,
// paying it back posts from the main cash and brings the van's cash account to zero, and paying a different amount is a
// difference that must be ticked.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vpb_${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  const fin = require("../../models/modules/financial/financialModels");
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    StockService: require("../stock/stockService"),
    Tx: require("../orderPurchase/transactionService"),
    Van: require("../vansales/vanService"),
    Trip: require("../vansales/vanTripService"),
    Sales: require("../vansales/vanTripSales"),
    Fleet: require("../vansales/vanFleetService"),
    Settle: require("../vansales/vanTripSettlement"),
    Config: require("../financial/accountConfigService"),
    Chart: require("../financial/defaultChartService"),
    LedgerEntry: fin.LedgerEntry,
    LedgerAccount: fin.LedgerAccount,
    VanTrip: require("../../models/modules/vansales/vanTripModel"),
    Customer: require("../../models/modules/customerModel"),
    Category: require("../../models/modules/categoryModel"),
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

let salesman, shop, rice;
const by = () => String(salesman._id);
const balance = async (accountId) => r2((await svc.LedgerAccount.findById(accountId).lean()).currentBalance);
const lines = async (voucherId) => (await svc.LedgerEntry.find({ voucherId }).lean())
  .map((e) => [String(e.accountId), r2(e.debitAmount), r2(e.creditAmount)]);

// one day: a cash sale of 20 and fuel and a repair of 65, so the van is 45 short of its own spending
async function day(code) {
  const van = await svc.Van.create({ code, name: code, salesmanId: by() }, "tester");
  const trip = await svc.Trip.open({ vanId: van._id ?? van.id }, "tester");
  await svc.Trip.load(trip._id, { lines: [{ stockId: String(rice._id), qty: 1 }] }, "tester");
  await svc.Trip.depart(trip._id, "tester");
  await svc.Sales.sell(trip._id, { customerId: shop._id, items: [{ itemId: rice._id, qty: 1, vatPercent: 0 }], payNow: { mode: "cash", full: true } }, by());
  await svc.Fleet.expense(trip._id, { kind: "fuel", amount: 25 }, by());
  await svc.Fleet.expense(trip._id, { kind: "mechanical", amount: 40 }, by());
  await svc.Settle.unload(trip._id, { counts: [] }, "tester");
  return trip;
}

test("setup", { skip }, async () => {
  salesman = await svc.Admin.create({ name: "Rashid", email: `rashid-pb.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Wholesale Co", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  shop = await svc.Customer.create({ customerId: "C1", customerName: "Corner Shop", contactPerson: "x", shippingAddress: "Dubai", paymentTerms: "Net 30" });
  const cat = await svc.Category.create({ name: "Food" });
  rice = await svc.StockService.createStock({ categoryId: cat._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x", sku: "RICE", itemName: "Rice 5kg", salesPrice: 20 }, "tester");
  const po = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: rice._id, description: "Rice", qty: 10, price: 10, vatPercent: 0 }] }, "tester");
  await svc.Tx.processTransaction(po._id, "approve", "tester");
});

test("paid back what is owed: from the main cash, the van's own cash account back to zero", { skip }, async () => {
  const trip = await day("VAN-1");
  assert.equal((await svc.Trip.getById(trip._id)).totals.cashInHand, -45);
  const plan = await svc.Settle.preview(trip._id, {});
  assert.deepEqual([plan.cash.expected, plan.cash.handed, plan.cash.short, plan.cash.over], [-45, -45, 0, 0]);
  assert.equal(plan.warnings.some((w) => w.code.startsWith("CASH")), false);
  const main = await svc.LedgerAccount.findOne({ accountName: "Cash in Hand" }).lean();
  const before = await balance(main._id);
  const { trip: done } = await svc.Settle.settle(trip._id, { cashHanded: "-45", acknowledge: plan.warnings.map((w) => w.code), toAccountId: String(main._id) }, by());
  assert.deepEqual([done.settlement.cashExpected, done.settlement.cashHanded, done.settlement.cashVariance], [-45, -45, 0]);
  const vanCash = String((await svc.VanTrip.findById(trip._id)).cashAccountId);
  assert.equal(await balance(vanCash), 0, "took 20, spent 65, paid back 45");
  assert.equal(r2((await balance(main._id)) - before), -45);
  assert.deepEqual((await lines(done.settlement.voucherIds[0])).sort(), [[String(main._id), 0, 45], [vanCash, 45, 0]].sort());
});

test("paying less than is owed is a difference to tick, booked to cash over and short", { skip }, async () => {
  const trip = await day("VAN-2");
  const plan = await svc.Settle.preview(trip._id, { cashHanded: 0 });
  assert.equal(plan.cash.over, 45);
  assert.match(plan.warnings.find((w) => w.code === "CASH_OVER").message, /45\.00 less is paid to the salesman/);
  await assert.rejects(() => svc.Settle.settle(trip._id, { cashHanded: 0 }, by()), { code: "VAN_SETTLE_WARNINGS" });
  const { trip: done } = await svc.Settle.settle(trip._id, { cashHanded: 0, acknowledge: plan.warnings.map((w) => w.code) }, by());
  const vanCash = String((await svc.VanTrip.findById(trip._id)).cashAccountId);
  assert.equal(await balance(vanCash), 0);
  const over = String(await svc.Config.resolveAccount("cash-over-short"));
  assert.deepEqual((await lines(done.settlement.voucherIds[0])).sort(), [[over, 0, 45], [vanCash, 45, 0]].sort());
});

test("money paid to the salesman is refused when nothing is owed to them", { skip }, async () => {
  const van = await svc.Van.create({ code: "VAN-3", name: "VAN-3", salesmanId: by() }, "tester");
  const trip = await svc.Trip.open({ vanId: van._id ?? van.id }, "tester");
  await svc.Trip.load(trip._id, { lines: [{ stockId: String(rice._id), qty: 1 }] }, "tester");
  await svc.Trip.depart(trip._id, "tester");
  await svc.Settle.unload(trip._id, { counts: [{ stockId: String(rice._id), good: 1, damaged: 0 }] }, "tester");
  await assert.rejects(() => svc.Settle.settle(trip._id, { cashHanded: -10 }, by()), { code: "CASH_NEGATIVE" });
});
