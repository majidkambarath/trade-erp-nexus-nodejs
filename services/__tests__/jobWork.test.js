// Job work (subcontracting) against a throwaway database (random name, dropped afterwards).
//
// The Brivox case: 10 raw keychain holders (50 each) go to an outside powder coater on a challan; the coater's bill
// and the transport are paid by expense vouchers; the holders come back coated in two lots. Sending moves no stock and
// posts nothing (the parts are still ours); each receipt posts a Production: raw out at its cost, the finished holder
// in at that cost plus the coating and transport moved into it. Also: free stock on sending, part receipts, raw
// returned unprocessed, a receipt reversed, the production that cannot be reversed on its own, cancelling, two lines
// sharing the costs, the stock list's "with job worker", India's one-year return-by, and the item type lock.
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
    JW: require("../stock/jobWorkService"),
    P: require("../stock/productionService"),
    Kinds: require("../stock/itemKindService"),
    StockReports: require("../reports/stockReportsService"),
    Production: require("../../models/modules/productionOrderModel"),
    Stock: require("../../models/modules/stockModel"),
    Category: require("../../models/modules/categoryModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
    LedgerAccount: fin.LedgerAccount,
    LedgerEntry: fin.LedgerEntry,
    days: require("../../utils/documentExpiry"),
    orgLocale: require("../../utils/orgLocale"),
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
let coater, raw, coated, bracket, bracketCoated, coating, transport, job;
const today = () => svc.days.todayInOrg();
const L = (item, qty, price) => ({ itemId: item._id, description: item.itemName, qty, price, rate: price, vatPercent: 5 });
const buy = async (items) => {
  const t = await svc.Tx.createTransaction({ type: "purchase_order", partyId: coater._id, partyType: "Vendor", partyTypeRef: "Vendor", items }, "tester");
  return svc.Tx.processTransaction(t._id, "approve", "tester");
};
const item = (x) => svc.Stock.findById(x._id).lean();
const expense = (account, amount) =>
  svc.Financial.createVoucher({ voucherType: "expense", ledgerBased: true, expenseAccountId: account._id, amount, description: account.accountName, paymentMode: "cash", date: today() }, admin);
async function cogsAccount(name, code) {
  const cogs = await svc.LedgerAccount.findOne({ accountName: "Cost of Goods Sold" }).lean();
  return svc.LedgerAccount.create({ accountCode: code, accountName: name, accountType: "expense", subType: cogs.subType, groupId: cogs.groupId, level: cogs.level, isActive: true, allowDirectPosting: true, currentBalance: 0, openingBalance: 0, createdBy: admin });
}

test("setup: a coater, raw and coated holders, 10 raw bought at 50, the coating and transport bills paid", { skip }, async () => {
  coater = await svc.Vendor.create({ vendorId: "V1", vendorName: "Shine Powder Coaters", contactPerson: "x", address: "Plot 4, MIDC", paymentTerms: "Net 30" });
  const cat = await svc.Category.create({ name: "Keychains" });
  raw = await svc.Stock.create({ itemId: "KH-RAW", sku: "KH-RAW", itemName: "Car keychain holder (raw)", category: cat._id });
  coated = await svc.Stock.create({ itemId: "KH", sku: "KH", itemName: "Car keychain holder", category: cat._id });
  bracket = await svc.Stock.create({ itemId: "BR-RAW", sku: "BR-RAW", itemName: "Bracket (raw)", category: cat._id });
  bracketCoated = await svc.Stock.create({ itemId: "BR", sku: "BR", itemName: "Bracket", category: cat._id });
  coating = await cogsAccount("Powder Coating Charges", "COGS-801");
  transport = await cogsAccount("Transport to Coater", "COGS-802");
  await buy([L(raw, 10, 50), L(bracket, 4, 25)]);
  await expense(coating, 400);
  await expense(transport, 100);
  assert.equal((await item(raw)).currentStock, 10);
});

test("sending: a challan number, nothing moves, the parts show as with the job worker", { skip }, async () => {
  const draft = await svc.JW.create({ jobWorkerId: coater._id, purpose: "Powder coating, black", vehicleNo: "MH12AB1234", lines: [{ rawStockId: raw._id, finishedStockId: coated._id, qtySent: 10 }] }, "tester");
  assert.equal(draft.status, "DRAFT");
  assert.equal(draft.jobWorkNo, undefined, "a draft has no challan number");
  job = await svc.JW.send(draft._id, "tester");
  assert.equal(job.status, "SENT");
  assert.match(job.jobWorkNo, /^JWC-\d{4}-0001$/);
  assert.equal(job.lines[0].unitValue, 50, "valued at its average cost for the challan");
  assert.equal(job.jobWorker.name, "Shine Powder Coaters");
  assert.equal(job.returnBy, undefined, "no return-by outside India");
  assert.equal((await item(raw)).currentStock, 10, "still ours, still on hand in the books");
  assert.equal(await svc.Movement.countDocuments({ referenceId: job._id }), 0);
  assert.equal(await svc.LedgerEntry.countDocuments({ voucherId: job._id }), 0);
  assert.equal((await svc.JW.withJobWorker()).get(String(raw._id)), 10);

  const more = await svc.JW.create({ jobWorkerId: coater._id, lines: [{ rawStockId: raw._id, finishedStockId: coated._id, qtySent: 1 }] }, "tester");
  await assert.rejects(() => svc.JW.send(more._id, "tester"), (e) => e.code === "INSUFFICIENT_STOCK" && e.details.free === 0, "all 10 are already out");
  await svc.JW.remove(more._id, "tester");
  await assert.rejects(() => svc.JW.update(job._id, { notes: "x" }, "tester"), { code: "JOB_WORK_NOT_DRAFT" });
});

test("first lot back: 6 coated, coating 240 + transport 60 moved in -> 6 holders at 100 each", { skip }, async () => {
  const { order, productions } = await svc.JW.receive(job._id, {
    workerRef: "SPC/118", lines: [{ lineId: job.lines[0]._id, finishedQty: 6 }],
    costs: [{ accountId: coating._id, amount: 240 }, { accountId: transport._id, amount: 60 }],
  }, "tester");
  assert.equal(order.status, "PARTLY_RECEIVED");
  assert.equal(productions.length, 1);
  const p = await svc.Production.findById(productions[0].id).lean();
  assert.equal(p.status, "POSTED");
  assert.equal(p.source.kind, "job_work");
  assert.equal(p.source.no, job.jobWorkNo);
  assert.deepEqual([p.totals.materials, p.totals.costs, p.totals.total, p.totals.unitCost], [300, 300, 600, 100]);
  assert.match(p.notes, /SPC\/118/);
  const [r, c] = [await item(raw), await item(coated)];
  assert.deepEqual([r.currentStock, c.currentStock, r2(c.costValue)], [4, 6, 600]);
  assert.equal((await svc.JW.withJobWorker()).get(String(raw._id)), 4);
  const view = await svc.JW.getById(job._id);
  assert.deepEqual([view.atWorker, view.progress.lines[0].finished, view.actions.receive, view.actions.cancel], [4, 6, true, false]);

  // the production is reversed only through its job, so the two never disagree
  await assert.rejects(() => svc.P.reverse(p._id, {}, "tester"), { code: "PRODUCTION_FROM_JOB_WORK" });
  assert.equal((await svc.P.getById(p._id)).actions.reverse, false);
});

test("second lot: 3 coated and 1 returned unprocessed -> the job is received; nothing more can come back", { skip }, async () => {
  await assert.rejects(
    () => svc.JW.receive(job._id, { lines: [{ lineId: job.lines[0]._id, finishedQty: 4, rawReturned: 1 }] }, "tester"),
    { code: "MORE_THAN_AT_WORKER" }
  );
  const { order, productions } = await svc.JW.receive(job._id, { lines: [{ lineId: job.lines[0]._id, finishedQty: 3, rawReturned: 1 }] }, "tester");
  assert.equal(order.status, "RECEIVED");
  assert.equal(productions.length, 1);
  const [r, c] = [await item(raw), await item(coated)];
  assert.deepEqual([r.currentStock, c.currentStock], [1, 9], "the returned one never left the books, so 1 raw is on hand");
  assert.equal((await svc.JW.withJobWorker()).get(String(raw._id)), undefined);
  await assert.rejects(() => svc.JW.receive(job._id, { lines: [{ lineId: job.lines[0]._id, finishedQty: 1 }] }, "tester"), { code: "JOB_WORK_NOT_OPEN" });
  assert.equal((await svc.StockReports.ledgerCheck({ asOn: today() })).reconciles, true);
});

test("reversing a receipt takes its productions back and the parts count as with the job worker again", { skip }, async () => {
  const before = await svc.JW.getById(job._id);
  const second = before.receipts[1];
  const o = await svc.JW.reverseReceipt(job._id, second._id, { reason: "counted wrong" }, "tester");
  assert.equal(o.status, "PARTLY_RECEIVED");
  const [r, c] = [await item(raw), await item(coated)];
  assert.deepEqual([r.currentStock, c.currentStock], [4, 6]);
  assert.equal((await svc.Production.findById(second.productions[0].id).lean()).status, "REVERSED");
  await assert.rejects(() => svc.JW.reverseReceipt(job._id, second._id, {}, "tester"), { code: "RECEIPT_REVERSED" });
  assert.equal((await svc.JW.withJobWorker()).get(String(raw._id)), 4);
});

test("sending more than is free is refused, a job with nothing back can be cancelled, and a receipt carries its costs", { skip }, async () => {
  const d = await svc.JW.create({ jobWorkerId: coater._id, lines: [
    { rawStockId: raw._id, finishedStockId: coated._id, qtySent: 2 },
    { rawStockId: bracket._id, finishedStockId: bracketCoated._id, qtySent: 4 },
  ] }, "tester");
  await assert.rejects(() => svc.JW.send(d._id, "tester"), { code: "INSUFFICIENT_STOCK" }, "only 4 raw holders are free and 4 are still out");
  await svc.JW.update(d._id, { lines: [{ rawStockId: bracket._id, finishedStockId: bracketCoated._id, qtySent: 4 }] }, "tester");
  const sent = await svc.JW.send(d._id, "tester");
  assert.equal((await svc.JW.cancel(sent._id, "tester")).status, "CANCELLED");
  assert.equal((await svc.JW.withJobWorker()).get(String(bracket._id)), undefined);

  const two = await svc.JW.send((await svc.JW.create({ jobWorkerId: coater._id, lines: [
    { rawStockId: bracket._id, finishedStockId: bracketCoated._id, qtySent: 4 },
  ] }, "tester"))._id, "tester");
  const { productions } = await svc.JW.receive(two._id, { lines: [{ lineId: two.lines[0]._id, finishedQty: 4 }], costs: [{ accountId: coating._id, amount: 60 }] }, "tester");
  const p = await svc.Production.findById(productions[0].id).lean();
  assert.deepEqual([p.totals.materials, p.totals.costs, p.totals.unitCost], [100, 60, 40]);
  await assert.rejects(() => svc.JW.cancel(two._id, "tester"), { code: "JOB_WORK_NOT_CANCELLABLE" });
});

test("India: the challan must come back within a year (s.143), and an open job past it is overdue", { skip }, async () => {
  await buy([L(raw, 1, 50)]); // the earlier tests left none free
  svc.orgLocale.warm({ code: "default", country: "IN", baseCurrency: "AED", timezone: "Asia/Dubai" });
  try {
    const old = svc.days.addDays(today(), -400);
    const d = await svc.JW.create({ jobWorkerId: coater._id, date: old, lines: [{ rawStockId: raw._id, finishedStockId: coated._id, qtySent: 1 }] }, "tester");
    // the country is read from the organisation in scope (the server always has one; these direct calls name it)
    const { runWithTenant } = require("../../utils/tenantContext");
    const sent = await runWithTenant({ companyId: "default", branchId: "main" }, () => svc.JW.send(d._id, "tester"));
    const back = svc.days.toExpiryDay(sent.returnBy);
    assert.ok(back, "a return-by day is set");
    assert.equal(back.slice(0, 4), String(Number(old.slice(0, 4)) + 1), "one year after it was sent");
    assert.ok(back.slice(5) === old.slice(5) || old.slice(5) === "02-29", "on the same calendar day");
    const view = await svc.JW.getById(sent._id);
    assert.equal(view.overdue, true);
    assert.ok((await svc.JW.list({ status: "OVERDUE" })).some((r) => String(r._id) === String(sent._id)));
    assert.equal((await svc.JW.list({ status: "OVERDUE" })).length, 1, "only the job past its day");
    await svc.JW.cancel(sent._id, "tester");
  } finally {
    svc.orgLocale.forget("default");
  }
});

test("an item sent for job work cannot change type", { skip }, async () => {
  const u = await svc.Kinds.usage(await item(raw));
  assert.ok(u.jobWork >= 1);
  const made = await item(bracketCoated);
  await assert.rejects(() => svc.Kinds.assertTypeChange(made, "service"), { code: "ITEM_TYPE_LOCKED" });
});
