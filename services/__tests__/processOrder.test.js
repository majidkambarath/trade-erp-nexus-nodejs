// Process orders against a throwaway database (random name, dropped afterwards).
//
// A car keychain holder made from 10 raw parts through Cutting (Ravi) -> Bending (Ravi) -> Painting (an outside coater,
// on a job-work challan) -> Packing. Nothing moves in stock or the books while the steps run; the challan's receipts move
// the painting step on and post nothing; finishing the order posts ONE production with the coating cost moved in. Also:
// the board, refusals, reopening, and a receipt reversed after the next step has started.
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
    Financial: require("../financial/financialService"),
    Tx: require("../orderPurchase/transactionService"),
    PO: require("../stock/processOrderService"),
    JW: require("../stock/jobWorkService"),
    P: require("../stock/productionService"),
    Kinds: require("../stock/itemKindService"),
    Production: require("../../models/modules/productionOrderModel"),
    JobWorkOrder: require("../../models/modules/jobWorkOrderModel"),
    Stock: require("../../models/modules/stockModel"),
    Category: require("../../models/modules/categoryModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Admin: require("../../models/core/adminModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
    LedgerAccount: fin.LedgerAccount,
    LedgerEntry: fin.LedgerEntry,
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
let coater, raw, holder, coating, ravi, order;
const today = () => svc.days.todayInOrg();
const L = (item, qty, price) => ({ itemId: item._id, description: item.itemName, qty, price, rate: price, vatPercent: 0 });
const item = (x) => svc.Stock.findById(x._id).lean();
const stepNamed = (o, name) => o.steps.find((s) => s.name === name);
const statuses = (o) => o.steps.map((s) => `${s.name}:${s.status}:${s.plannedQty}`);

test("setup: raw parts bought, a coater, a coating expense paid, a person on the floor", { skip }, async () => {
  coater = await svc.Vendor.create({ vendorId: "V1", vendorName: "Shine Powder Coaters", contactPerson: "x", address: "Pune", paymentTerms: "Net 30" });
  const cat = await svc.Category.create({ name: "Keychains" });
  raw = await svc.Stock.create({ itemId: "KH-RAW", sku: "KH-RAW", itemName: "Holder (raw)", category: cat._id });
  holder = await svc.Stock.create({ itemId: "KH", sku: "KH", itemName: "Car keychain holder", category: cat._id });
  const rent = await svc.LedgerAccount.findOne({ accountName: "Rent Expense" }).lean();
  coating = await svc.LedgerAccount.create({ accountCode: "EXP-701", accountName: "Powder Coating Charges", accountType: "expense", subType: rent.subType, groupId: rent.groupId, level: rent.level, isActive: true, allowDirectPosting: true, currentBalance: 0, openingBalance: 0, createdBy: admin });
  ravi = (await new svc.Admin({ name: "Ravi", email: `ravi${Date.now()}@floor.test`, password: "12345678", status: "active", isActive: true, type: "operator" }).save()).toObject();
  const t = await svc.Tx.createTransaction({ type: "purchase_order", partyId: coater._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [L(raw, 10, 50)] }, "tester");
  await svc.Tx.processTransaction(t._id, "approve", "tester");
  await svc.Financial.createVoucher({ voucherType: "expense", ledgerBased: true, expenseAccountId: coating._id, amount: 90, description: "Coating", paymentMode: "cash", date: today() }, admin);
});

test("a draft, released: a number, the first step ready, the rest waiting; nothing moves", { skip }, async () => {
  const draft = await svc.PO.create({
    finished: { stockId: holder._id, qty: 10 }, materials: [{ stockId: raw._id, qty: 10 }], dueDate: svc.days.addDays(today(), 3),
    steps: [
      { name: "Cutting", mode: "in_house", assigneeId: String(ravi._id), dueDate: today() },
      { name: "Bending", mode: "in_house", assigneeId: String(ravi._id), dueDate: svc.days.addDays(today(), 1) },
      { name: "Painting", mode: "job_work", jobWorkerId: coater._id, dueDate: svc.days.addDays(today(), 2) },
      { name: "Packing", mode: "in_house", assigneeName: "Store team" },
    ],
  }, "tester");
  assert.equal(draft.status, "DRAFT");
  assert.equal(stepNamed(draft, "Cutting").assigneeName, ravi.name || ravi.email, "the person's own name is kept");
  assert.equal(stepNamed(draft, "Painting").jobWorkerName, "Shine Powder Coaters");
  order = await svc.PO.release(draft._id, "tester");
  assert.match(order.processNo, /^PRO-\d{4}-0001$/);
  assert.deepEqual(statuses(order), ["Cutting:READY:10", "Bending:WAITING:10", "Painting:WAITING:10", "Packing:WAITING:10"]);
  assert.equal(await svc.Movement.countDocuments({ referenceType: "Production" }), 0);

  const b = await svc.PO.board({ me: String(ravi._id) });
  assert.deepEqual([b.counts.orders, b.counts.pending, b.counts.dueToday], [1, 1, 1]);
  assert.deepEqual(b.columns.map((c) => c.name), ["Cutting"]);
  assert.deepEqual(b.mine.map((c) => c.stepName), ["Cutting"], "Ravi's list");
});

test("in-house steps: start, finish with good and rejected; the next step gets what came out", { skip }, async () => {
  const cut = stepNamed(order, "Cutting")._id;
  await assert.rejects(() => svc.PO.completeStep(order._id, stepNamed(order, "Bending")._id, { qtyDone: 1 }, "tester"), { code: "STEP_NOT_READY" });
  order = await svc.PO.startStep(order._id, cut, "tester");
  assert.equal(stepNamed(order, "Cutting").status, "IN_PROGRESS");
  assert.equal((await svc.PO.board({})).counts.inProgress, 1);
  await assert.rejects(() => svc.PO.completeStep(order._id, cut, { qtyDone: 10, qtyRejected: 1 }, "tester"), { code: "MORE_THAN_PLANNED" });
  order = await svc.PO.completeStep(order._id, cut, { qtyDone: 10 }, "tester");
  order = await svc.PO.completeStep(order._id, stepNamed(order, "Bending")._id, { qtyDone: 9, qtyRejected: 1 }, "tester");
  assert.deepEqual(statuses(order), ["Cutting:DONE:10", "Bending:DONE:10", "Painting:READY:9", "Packing:WAITING:10"]);
});

test("a job-work step goes out on a challan; its receipts move the step on and post nothing", { skip }, async () => {
  const paint = stepNamed(order, "Painting")._id;
  const { order: sentOrder, jobWork } = await svc.PO.sendStep(order._id, paint, { vehicleNo: "MH12AB1234" }, "tester");
  order = sentOrder;
  assert.match(jobWork.jobWorkNo, /^JWC-/);
  assert.equal(stepNamed(order, "Painting").status, "IN_PROGRESS");
  assert.equal(stepNamed(order, "Painting").jobWorkNo, jobWork.jobWorkNo);
  const job = await svc.JobWorkOrder.findById(jobWork._id).lean();
  assert.deepEqual([job.source.kind, job.source.no, job.lines[0].qtySent, String(job.lines[0].finishedStockId)], ["process", order.processNo, 9, String(raw._id)]);
  assert.equal((await svc.JW.withJobWorker()).get(String(raw._id)), 9);
  assert.equal((await svc.JW.getById(jobWork._id)).actions.send, false, "sent by the order, not by hand");

  await assert.rejects(() => svc.JW.receive(jobWork._id, { lines: [{ lineId: job.lines[0]._id, finishedQty: 5 }], costs: [{ accountId: coating._id, amount: 50 }] }, "tester"), { code: "PROCESS_COSTS_AT_FINISH" });
  await svc.JW.receive(jobWork._id, { lines: [{ lineId: job.lines[0]._id, finishedQty: 5 }] }, "tester");
  order = await svc.PO.getById(order._id);
  assert.deepEqual([stepNamed(order, "Painting").status, stepNamed(order, "Painting").qtyDone], ["IN_PROGRESS", 5]);
  await svc.JW.receive(jobWork._id, { lines: [{ lineId: job.lines[0]._id, finishedQty: 4 }] }, "tester");
  order = await svc.PO.getById(order._id);
  assert.deepEqual(statuses(order), ["Cutting:DONE:10", "Bending:DONE:10", "Painting:DONE:9", "Packing:READY:9"]);
  assert.equal(await svc.Production.countDocuments({}), 0, "nothing posted yet");
  assert.equal((await item(raw)).currentStock, 10, "the raw parts are still on hand in the books");
});

test("a receipt cannot be taken back once the order has moved on", { skip }, async () => {
  order = await svc.PO.startStep(order._id, stepNamed(order, "Packing")._id, "tester");
  const job = await svc.JW.getById(stepNamed(order, "Painting").jobWorkId);
  await assert.rejects(() => svc.JW.reverseReceipt(job._id, job.receipts[1]._id, {}, "tester"), { code: "PROCESS_MOVED_ON" });
});

test("finishing posts ONE production: 10 raw out, 9 holders in at raw + coating", { skip }, async () => {
  await assert.rejects(() => svc.PO.finish(order._id, {}, "tester"), { code: "STEPS_NOT_DONE" });
  order = await svc.PO.completeStep(order._id, stepNamed(order, "Packing")._id, { qtyDone: 9 }, "tester");
  assert.equal(svc.PO.present(order).readyToFinish, true);
  assert.equal((await svc.PO.board({})).counts.readyToFinish, 1);
  const { order: done, production } = await svc.PO.finish(order._id, { costs: [{ accountId: coating._id, amount: 90 }] }, "tester");
  order = done;
  assert.equal(order.status, "COMPLETED");
  assert.deepEqual([production.totals.materials, production.totals.costs, production.totals.total, production.finished.qty], [500, 90, 590, 9]);
  assert.equal(r2(production.totals.unitCost), 65.56, "the rejected part's cost is carried by the good ones");
  const [r, h] = [await item(raw), await item(holder)];
  assert.deepEqual([r.currentStock, h.currentStock, r2(h.costValue)], [0, 9, 590]);
  await assert.rejects(() => svc.P.reverse(production._id, {}, "tester"), { code: "PRODUCTION_FROM_PROCESS" });
  assert.equal((await svc.PO.board({})).counts.orders, 0, "off the board");
});

test("reopening reverses the production and puts the order back on the board", { skip }, async () => {
  order = await svc.PO.reopen(order._id, {}, "tester");
  assert.equal(order.status, "OPEN");
  assert.equal(order.productionId, undefined);
  const [r, h] = [await item(raw), await item(holder)];
  assert.deepEqual([r.currentStock, h.currentStock], [10, 0]);
  assert.equal((await svc.PO.board({})).counts.readyToFinish, 1);
  await svc.PO.finish(order._id, { costs: [{ accountId: coating._id, amount: 90 }], acknowledge: ["COST_EXCEEDS_SPEND"] }, "tester");
});

test("a cancelled challan puts its step back to ready; an order with parts out cannot be cancelled", { skip }, async () => {
  const t = await svc.Tx.createTransaction({ type: "purchase_order", partyId: coater._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [L(raw, 5, 50)] }, "tester");
  await svc.Tx.processTransaction(t._id, "approve", "tester");
  let o = await svc.PO.release((await svc.PO.create({ finished: { stockId: holder._id, qty: 5 }, materials: [{ stockId: raw._id, qty: 5 }], steps: [{ name: "Painting", mode: "job_work", jobWorkerId: coater._id, dueDate: svc.days.addDays(today(), -2) }] }, "tester"))._id, "tester");
  assert.equal((await svc.PO.board({})).counts.overdue, 1, "its painting is past due");
  const { jobWork } = await svc.PO.sendStep(o._id, o.steps[0]._id, {}, "tester");
  await assert.rejects(() => svc.PO.cancel(o._id, "tester"), { code: "PROCESS_AT_JOB_WORKER" });
  await svc.JW.cancel(jobWork._id, "tester");
  o = await svc.PO.getById(o._id);
  assert.deepEqual([o.steps[0].status, o.steps[0].jobWorkNo], ["READY", undefined]);
  assert.equal((await svc.PO.cancel(o._id, "tester")).status, "CANCELLED");
  assert.ok((await svc.Kinds.usage(await item(holder))).processes >= 1, "an item in a process order is type-locked");
});
