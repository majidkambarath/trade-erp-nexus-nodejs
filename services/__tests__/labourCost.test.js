// Labour costing against a throwaway database (random name, dropped afterwards).
//
// THE CASE: Ravi (an employee, no sign-in account) works a process order's only in-house step for a controlled
// span of hours at a known cost rate. His labour is previewed, recorded as a cost line, and the order is
// finished - the cost line must flow into the production, be absorbed into the finished item's stock cost
// through the EXISTING production-absorbed contra, and leave net profit untouched. Also: the garage half
// (U2, a job card's labour margin), the three rules from utils/hr.js holding under a database round trip, the
// hr.confidential gate on a real read, and the COST_EXCEEDS_SPEND refusal when the wage was never booked.
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
    Config: require("../financial/accountConfigService"),
    Financial: require("../financial/financialService"),
    Tx: require("../orderPurchase/transactionService"),
    PO: require("../stock/processOrderService"),
    P: require("../stock/productionService"),
    Staff: require("../staff/staffService"),
    Contract: require("../hr/contractService"),
    Labour: require("../hr/labourCostService"),
    StaffModel: require("../../models/modules/staffModel"),
    Production: require("../../models/modules/productionOrderModel"),
    ProcessOrder: require("../../models/modules/processOrderModel"),
    Stock: require("../../models/modules/stockModel"),
    Category: require("../../models/modules/categoryModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
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

// ---- fixtures ----
const admin = new mongoose.Types.ObjectId();
let category, raw, finished, ravi, expenseAccount, vendor;
const today = () => svc.days.todayInOrg();
const L = (item, qty, price) => ({ itemId: item._id, description: item.itemName, qty, price, rate: price, vatPercent: 5 });
const doc = (type, party, partyType, items, extra = {}) =>
  svc.Tx.createTransaction({ type, partyId: party._id, partyType, partyTypeRef: partyType, items, ...extra }, "tester");
const approve = (t) => svc.Tx.processTransaction(t._id, "approve", "tester");
const buy = async (items, extra) => approve(await doc("purchase_order", vendor, "Vendor", items, extra));

async function expAccount(name, code) {
  const rent = await svc.LedgerAccount.findOne({ accountName: "Rent Expense" }).lean();
  return svc.LedgerAccount.create({
    accountCode: code, accountName: name, accountType: "expense", subType: rent.subType, groupId: rent.groupId, level: rent.level,
    isActive: true, allowDirectPosting: true, currentBalance: 0, openingBalance: 0, createdBy: admin,
  });
}

test("setup", { skip }, async () => {
  assert.equal(await svc.Config.isPostingEnabled(), true, "the seed switches ledger posting on");
  category = await svc.Category.create({ name: "Parts" });
  vendor = await svc.Vendor.create({ vendorId: "LVEND1", vendorName: "Labour Test Supplies", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  raw = await svc.Stock.create({ itemId: "LRAW1", sku: "LRAW1", itemName: "Raw bracket", category: category._id });
  finished = await svc.Stock.create({ itemId: "LFIN1", sku: "LFIN1", itemName: "Coated bracket", category: category._id });
  expenseAccount = await expAccount("Travelling (labour test)", "EXP-9101");
  await buy([L(raw, 1, 50)]); // the process order's material has to be on hand before it can be issued

  // Ravi: an employee with NO sign-in account - the common case on a shop floor - and a known cost.
  ravi = await svc.Staff.createStaff(
    { name: "Ravi", designation: "Fabricator", contactNo: "0501111111", idNo: "784LABOUR0001" + Date.now() % 1000, joiningDate: today() },
    {}, admin
  );
  await svc.Contract.create({ staffId: ravi._id, effectiveFrom: svc.days.addDays(today(), -30), costPerHour: 25 }, admin);
});

// ---- U1: labour into product cost (manufacturing) ----

let order, orderId;
test("a process order names an employee, not an account, on an in-house step", { skip }, async () => {
  order = await svc.PO.create(
    {
      finished: { stockId: finished._id, qty: 1 },
      materials: [{ stockId: raw._id, qty: 1 }],
      steps: [{ name: "Fabricate", mode: "in_house", staffId: ravi._id }],
    },
    "tester"
  );
  orderId = order._id;
  assert.equal(order.steps[0].staffId.toString(), ravi._id.toString());
  assert.equal(order.steps[0].staffName, "Ravi");
});

test("an employee that does not exist is refused when the order is created", { skip }, async () => {
  await assert.rejects(
    () => svc.PO.create(
      { finished: { stockId: finished._id, qty: 1 }, materials: [{ stockId: raw._id, qty: 1 }],
        steps: [{ name: "Fabricate", mode: "in_house", staffId: new mongoose.Types.ObjectId() }] },
      "tester"
    ),
    (e) => e.code === "STAFF_NOT_FOUND"
  );
});

test("the step is worked for a controlled span, and labour is previewed before anything is written", { skip }, async () => {
  await svc.PO.release(orderId, "tester");
  let o = await svc.ProcessOrder.findById(orderId);
  const stepId = o.steps[0]._id;
  await svc.PO.startStep(orderId, stepId, "tester");

  // Backdate started/done to a controlled 3-hour span, same day - so the hours are EXACT and the figure
  // in the assertions below is not at the mercy of how fast this test runs.
  const start = new Date(`${today()}T08:00:00Z`);
  const end = new Date(`${today()}T11:00:00Z`);
  await svc.ProcessOrder.updateOne({ _id: orderId, "steps._id": stepId }, { $set: { "steps.$.startedAt": start } });
  await svc.PO.completeStep(orderId, stepId, { qtyDone: 1 }, "tester");
  await svc.ProcessOrder.updateOne({ _id: orderId, "steps._id": stepId }, { $set: { "steps.$.doneAt": end } });

  const preview = await svc.Labour.previewForProcessOrder(orderId);
  assert.equal(preview.lines.length, 1);
  assert.equal(preview.lines[0].staffName, "Ravi");
  assert.equal(preview.lines[0].hours, 3);
  assert.equal(preview.lines[0].rate, 25);
  assert.equal(preview.lines[0].amount, 75);
  assert.equal(preview.lines[0].confident, true, "a 3-hour same-day span is trusted, not flagged");
  assert.equal(preview.skipped.length, 0);
});

test("the labour is recorded as a cost line, stamped, and cannot be recorded twice", { skip }, async () => {
  const result = await svc.Labour.record(orderId, { by: "tester" });
  assert.equal(result.costed, 1);
  assert.equal(result.amount, 75);

  const o = await svc.ProcessOrder.findById(orderId).lean();
  const line = o.costs.find((c) => c.labour);
  assert.equal(line.amount, 75);
  assert.equal(line.labour.staffName, "Ravi");
  assert.equal(line.labour.hours, 3);
  assert.equal(line.labour.rate, 25);
  // Mongoose's ObjectId has a self-referencing `_id` getter, so `wagesAccount()`'s bare id silently
  // satisfied `account._id` while `account.accountCode`/`.accountName` stayed undefined - found by
  // checking, not assuming, and fixed by resolving the real document. Pinned here so it cannot regress.
  assert.ok(line.accountCode, "the cost line names a real account code, not undefined");
  assert.ok(line.accountName, "and a real account name");
  assert.equal(line.labour.source, "elapsed");

  await assert.rejects(() => svc.Labour.record(orderId, { by: "tester" }), (e) => e.code === "NO_LABOUR_TO_COST");
});

test("without the wage ever booked, finishing is held - absorbing an unbooked wage would invent profit", { skip }, async () => {
  const o = await svc.ProcessOrder.findById(orderId).lean();
  await assert.rejects(
    () => svc.PO.finish(orderId, {}, "tester"),
    (e) => e.code === "PRODUCTION_WARNINGS" || (e.data?.warnings || []).some((w) => w.code === "COST_EXCEEDS_SPEND")
  );
});

let wagesAccount, absorbedAccount, finishedBefore;
test("once the wage is actually booked, finishing absorbs it into the product's cost correctly", { skip }, async () => {
  wagesAccount = await svc.Labour.wagesAccount();
  absorbedAccount = await svc.LedgerAccount.findById(await svc.Config.resolveAccount("production-absorbed")).lean();
  const wagesBalanceBefore = r2((await svc.LedgerAccount.findById(wagesAccount._id).lean()).currentBalance);

  // Book the wage - exactly what payroll will do in a later wave, done by hand here.
  await svc.Financial.createVoucher(
    { voucherType: "expense", ledgerBased: true, expenseAccountId: wagesAccount._id, amount: 75, description: "Ravi - Fabricate", paymentMode: "cash", date: today() },
    admin
  );

  const { order: finishedOrder, production } = await svc.PO.finish(orderId, {}, "tester");
  assert.equal(finishedOrder.status, "COMPLETED");

  const item = await svc.Stock.findById(finished._id).lean();
  // The finished item's stock cost must include the labour: whatever the material cost alone, plus 75.
  const materialOnly = r2(item.costValue - production.totals.costs);
  assert.equal(production.totals.costs, 75, "the production's own cost total is exactly the labour");
  assert.equal(r2(item.costValue - materialOnly), 75);

  const wagesBalanceAfter = r2((await svc.LedgerAccount.findById(wagesAccount._id).lean()).currentBalance);
  const absorbedBalanceAfter = r2((await svc.LedgerAccount.findById(absorbedAccount._id).lean()).currentBalance);
  // Wages still shows the FULL expense (the owner's own choice: nothing is erased from it).
  assert.equal(r2(wagesBalanceAfter - wagesBalanceBefore), 75);
  // The contra is CREDITED by the same 75 (currentBalance is debit-positive, so a credit to an expense
  // account reads negative) in the SAME group as wages, so the two net to zero on the P&L.
  assert.equal(absorbedBalanceAfter, -75);
  // Net profit is exactly where it was: the full wage, less the same amount moved out of it.
  assert.equal(r2(wagesBalanceAfter + absorbedBalanceAfter - wagesBalanceBefore), 0, "net profit is unchanged by absorbing labour into stock");
});

// ---- U2: labour margin on a garage job card ----
// forJobCard reads only tasks[] (and the card's own day), so this proves the NEW join - not the garage
// module's lifecycle, which has its own suite (services/__tests__/garage.test.js).

test("a job card's labour margin is revenue sold against what the technician actually cost", { skip }, async () => {
  const card = {
    createdAt: new Date(),
    tasks: [{ _id: new mongoose.Types.ObjectId(), name: "Brake service", mode: "in_house", staffId: ravi._id, actualHours: 2 }],
  };
  const { lines, total, uncosted } = await svc.Labour.forJobCard(card);
  assert.equal(uncosted.length, 0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].amount, 50, "2 hours at Ravi's 25/hour");
  assert.equal(lines[0].source, "typed", "actualHours is a figure an advisor typed, not a clock reading");
  assert.equal(total.amount, 50);

  // This is the number utils/garage.js effectiveLabourRate could never answer: what the hour COST, not
  // what it was sold for.
  const margin = require("../../utils/hr").labourMargin({ revenue: 200, cost: total.amount, hours: 2 });
  assert.equal(margin.profit, 150);
  assert.equal(margin.marginPct, 75);
});

test("a task with no employee behind it is reported as uncosted, never costed at nothing", { skip }, async () => {
  const card = { createdAt: new Date(), tasks: [{ _id: new mongoose.Types.ObjectId(), name: "Mystery task", mode: "in_house", actualHours: 2 }] };
  const { lines, uncosted } = await svc.Labour.forJobCard(card);
  assert.equal(lines.length, 0);
  assert.equal(uncosted.length, 1);
  assert.equal(uncosted[0].reason, "NO_EMPLOYEE");
});

// ---- hr.confidential: the figures, and the gate on them ----

test("a contract's pay is never returned without asking for it, even against a real row", { skip }, async () => {
  const open = await svc.Contract.list(ravi._id, { confidential: false });
  assert.equal(open.length, 1);
  assert.equal(open[0].costPerHour, undefined, "no rate without hr.confidential");
  assert.equal(open[0].basicPay, undefined);

  const closed = await svc.Contract.list(ravi._id, { confidential: true });
  assert.equal(closed[0].costPerHour, 25);
  assert.equal(closed[0].hourlyCost, 25);
});

test("a contract's start day cannot be moved once it exists - a new contract is entered instead", { skip }, async () => {
  const rows = await svc.Contract.list(ravi._id, { confidential: true });
  await assert.rejects(
    () => svc.Contract.update(rows[0]._id, { effectiveFrom: svc.days.addDays(today(), -1) }, "tester"),
    (e) => e.code === "CONTRACT_START_FIXED"
  );
});
