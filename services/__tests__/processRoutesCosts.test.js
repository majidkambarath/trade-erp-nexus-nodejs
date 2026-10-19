// Process orders, phase 2, against a throwaway database (random name, dropped afterwards).
//
// A product's saved route (materials per batch, steps with the person and the days each takes) plans a new order;
// a step records when it became ready and why units were rejected; costs are recorded while the order runs, from the
// expense voucher that paid them (one bill is never moved into two products); Finish moves the recorded costs in;
// the person's own count and the analysis read it all back.
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
  const fin = require("../../models/modules/financial/financialModels");
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Financial: require("../financial/financialService"),
    Tx: require("../orderPurchase/transactionService"),
    PO: require("../stock/processOrderService"),
    Routes: require("../stock/processRouteService"),
    Kinds: require("../stock/itemKindService"),
    Stock: require("../../models/modules/stockModel"),
    Category: require("../../models/modules/categoryModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Admin: require("../../models/core/adminModel"),
    LedgerAccount: fin.LedgerAccount,
    Voucher: fin.Voucher,
    days: require("../../utils/documentExpiry"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const admin = new mongoose.Types.ObjectId();
let vendor, raw, holder, coating, ravi, route, bill, first, second;
const today = () => svc.days.todayInOrg();
const code = async (p) => {
  try {
    await p;
  } catch (err) {
    return err.errorCode || err.code;
  }
  return "no error";
};

test("setup: raw parts, a product, a coating bill paid by an expense voucher, a person on the floor", { skip }, async () => {
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Shine Powder Coaters", contactPerson: "x", address: "Pune", paymentTerms: "Net 30" });
  const cat = await svc.Category.create({ name: "Keychains" });
  raw = await svc.Stock.create({ itemId: "KH-RAW", sku: "KH-RAW", itemName: "Holder (raw)", category: cat._id });
  holder = await svc.Stock.create({ itemId: "KH", sku: "KH", itemName: "Car keychain holder", category: cat._id });
  const rent = await svc.LedgerAccount.findOne({ accountName: "Rent Expense" }).lean();
  coating = await svc.LedgerAccount.create({ accountCode: "EXP-701", accountName: "Powder Coating Charges", accountType: "expense", subType: rent.subType, groupId: rent.groupId, level: rent.level, isActive: true, allowDirectPosting: true, currentBalance: 0, openingBalance: 0, createdBy: admin });
  ravi = (await new svc.Admin({ name: "Ravi", email: `ravi${Date.now()}@floor.test`, password: "12345678", status: "active", isActive: true, type: "operator" }).save()).toObject();
  const t = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: raw._id, description: raw.itemName, qty: 20, price: 50, rate: 50, vatPercent: 0 }] }, "tester");
  await svc.Tx.processTransaction(t._id, "approve", "tester");
  await svc.Financial.createVoucher({ voucherType: "expense", ledgerBased: true, expenseAccountId: coating._id, amount: 90, description: "Coating bill SPC/118", paymentMode: "cash", date: today() }, admin);
  bill = await svc.Voucher.findOne({ voucherType: "expense", expenseAccountId: coating._id }).lean();
  assert.ok(bill, "the expense voucher is saved");
});

test("a route is saved once per product, and plans an order: materials scaled, each step due its days later", { skip }, async () => {
  const body = {
    finished: { stockId: holder._id }, batchQty: 10, materials: [{ stockId: raw._id, qty: 10 }],
    steps: [{ name: "Cutting", mode: "in_house", assigneeId: String(ravi._id), days: 1 }, { name: "Bending", mode: "in_house", assigneeId: String(ravi._id), days: 2 }],
  };
  route = await svc.Routes.create(body, "tester");
  assert.equal(route.steps[0].assigneeName, "Ravi", "the person's name is taken from the account");
  assert.equal(await code(svc.Routes.create(body, "tester")), "ROUTE_EXISTS");
  assert.equal(await code(svc.Routes.create({ ...body, steps: [{ name: "Cutting", mode: "in_house", days: -1 }] }, "tester")), "INVALID_DAYS");

  const plan = await svc.Routes.plan({ stockId: String(holder._id), qty: 5, date: today() });
  assert.equal(plan.route.totalDays, 3);
  assert.deepEqual(plan.order.materials.map((m) => m.qty), [5]);
  assert.deepEqual(plan.order.steps.map((s) => s.dueDate), [svc.days.addDays(today(), 1), svc.days.addDays(today(), 3)]);
  assert.equal(plan.order.dueDate, svc.days.addDays(today(), 3));
  assert.deepEqual(await svc.Routes.plan({ stockId: String(raw._id), qty: 5 }), { route: null, order: null }, "no route, no plan");

  const changed = await svc.Routes.update(route._id, { ...body, steps: body.steps.map((s) => ({ ...s, days: 0 })) }, "tester");
  assert.equal(svc.Routes.present(changed).totalDays, 0);
  assert.equal((await svc.Routes.plan({ stockId: String(holder._id), qty: 5 })).order.dueDate, undefined, "a route without days plans no dates");
  await svc.Routes.update(route._id, body, "tester");
  assert.equal((await svc.Routes.list({ search: "bend" })).length, 1);
  assert.equal((await svc.Kinds.usage(await svc.Stock.findById(raw._id).lean())).routes, 1, "an item on a route counts toward its type lock");
});

test("steps record when they became ready and why units were rejected; my work counts the person's open steps", { skip }, async () => {
  const plan = await svc.Routes.plan({ stockId: String(holder._id), qty: 10, date: today() });
  first = await svc.PO.create({ ...plan.order, date: today() }, "tester");
  assert.equal(await svc.PO.myWorkCount(ravi._id), 0, "a draft is nobody's work yet");
  first = await svc.PO.release(first._id, "tester");
  assert.ok(first.steps[0].readyAt instanceof Date);
  assert.equal(first.steps[1].readyAt, undefined);
  assert.equal(await svc.PO.myWorkCount(ravi._id), 1);
  first = await svc.PO.completeStep(first._id, first.steps[0]._id, { qtyDone: 9, qtyRejected: 1, rejectReason: "Bent or cracked" }, "tester");
  assert.equal(first.steps[0].rejectReason, "Bent or cracked");
  assert.ok(first.steps[1].readyAt instanceof Date, "the next step's waiting starts now");
  first = await svc.PO.completeStep(first._id, first.steps[1]._id, { qtyDone: 9, rejectReason: "ignored with nothing rejected" }, "tester");
  assert.equal(first.steps[1].rejectReason, undefined);
  assert.equal(await svc.PO.myWorkCount(ravi._id), 0);
});

test("costs come from the expense voucher that paid them, and one bill is never moved into two products", { skip }, async () => {
  const list = await svc.PO.expenseVouchers({ search: "SPC" });
  assert.deepEqual(list.map((v) => [v.voucherNo, v.net, v.left]), [[bill.voucherNo, 90, 90]]);
  first = await svc.PO.addCost(first._id, { voucherId: bill._id, amount: 60, stepId: first.steps[1]._id }, "tester");
  const c = first.costs[0];
  assert.deepEqual([c.voucherNo, String(c.accountId), c.amount, c.stepName], [bill.voucherNo, String(coating._id), 60, "Bending"]);

  const plan = await svc.Routes.plan({ stockId: String(holder._id), qty: 5 });
  second = await svc.PO.release((await svc.PO.create(plan.order, "tester"))._id, "tester");
  assert.equal(await code(svc.PO.addCost(second._id, { voucherId: bill._id, amount: 40 }, "tester")), "VOUCHER_ALREADY_MOVED");
  second = await svc.PO.addCost(second._id, { voucherId: bill._id }, "tester");
  assert.equal(second.costs[0].amount, 30, "without an amount, what the bill has left");
  assert.equal((await svc.PO.expenseVouchers({})).find((v) => v.voucherNo === bill.voucherNo).left, 0);
  assert.equal(await code(svc.PO.addCost(second._id, { accountId: coating._id, amount: 0 }, "tester")), "INVALID_AMOUNT");
  const inventory = await svc.LedgerAccount.findOne({ accountName: /inventory/i, accountType: "asset" }).lean();
  assert.equal(await code(svc.PO.addCost(second._id, { accountId: inventory._id, amount: 5 }, "tester")), "INVALID_COST_ACCOUNT");

  second = await svc.PO.removeCost(second._id, second.costs[0]._id, "tester");
  assert.equal(second.costs.length, 0);
  assert.equal((await svc.PO.voucherRoom(bill._id)).left, 30, "a removed cost gives the bill back");
  await svc.PO.cancel(second._id, "tester");
});

test("Finish without a cost list moves the recorded costs in; the analysis reads the period back", { skip }, async () => {
  const { order, production } = await svc.PO.finish(first._id, { date: today() }, "tester");
  assert.equal(order.status, "COMPLETED");
  assert.equal(production.totals.costs, 60);
  assert.equal(production.totals.materials, 500, "10 raw at 50");
  assert.equal(production.finished.qty, 9);
  assert.match(production.costs[0].narration, new RegExp(bill.voucherNo));

  const a = await svc.PO.analysis({ from: today(), to: today() });
  assert.deepEqual([a.orders.finished, a.orders.unitsOrdered, a.orders.unitsMade, a.orders.yieldPct], [1, 10, 9, 90]);
  assert.deepEqual(a.steps.map((s) => [s.label, s.done, s.rejected]), [["Bending", 1, 0], ["Cutting", 1, 1]]);
  assert.deepEqual(a.people.map((p) => [p.label, p.done]), [["Ravi", 2]]);
  assert.deepEqual(a.reasons, [{ reason: "Bent or cracked", qty: 1 }]);
  assert.equal(await code(svc.PO.analysis({ from: today(), to: svc.days.addDays(today(), -1) })), "INVALID_RANGE");
  assert.equal(await code(svc.PO.addCost(first._id, { accountId: coating._id, amount: 5 }, "tester")), "PROCESS_NOT_OPEN");
});
