// Productions against a throwaway database (random name, dropped afterwards).
//
// The case it was built for (Brivox Production): a raw part bought at 50, travelling 50, coating powder 50 and
// packing 20 paid by expense vouchers, a finished part made from them. The finished part must cost 170, its sale
// at 200 must show cost of goods 170 and profit 30, and each expense account must still show what was spent on it
// (the amount moved into stock is one line of its own, "Production Costs Moved to Stock").
//
// Also: the refusals (stock, back-dating, posting off, the accounts a cost may come from, money not yet spent),
// reversal and its refusal once the goods are sold, a back-dated purchase of a material replaying through a
// production, the trail behind the ledger row, the item type lock, and a company whose map predates the key.
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
    P: require("../stock/productionService"),
    Kinds: require("../stock/itemKindService"),
    StockReports: require("../reports/stockReportsService"),
    Ledger: require("../reports/ledgerReportsService"),
    Audit: require("../financial/voucherAuditService"),
    Production: require("../../models/modules/productionOrderModel"),
    Stock: require("../../models/modules/stockModel"),
    Category: require("../../models/modules/categoryModel"),
    Settings: require("../../models/modules/financial/companySettingsModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
    Batch: require("../../models/modules/stockBatchModel"),
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
let vendor, customer, category, raw, finished, other, travelling, coating, packing, cash;
const today = () => svc.days.todayInOrg();
const yesterday = () => svc.days.addDays(today(), -1);
const L = (item, qty, price) => ({ itemId: item._id, description: item.itemName, qty, price, rate: price, vatPercent: 5 });
const doc = (type, party, partyType, items, extra = {}) =>
  svc.Tx.createTransaction({ type, partyId: party._id, partyType, partyTypeRef: partyType, items, ...extra }, "tester");
const approve = (t) => svc.Tx.processTransaction(t._id, "approve", "tester");
const buy = async (items, extra) => approve(await doc("purchase_order", vendor, "Vendor", items, extra));
const sell = async (items, extra) => approve(await doc("sales_order", customer, "Customer", items, extra));
const item = (id) => svc.Stock.findById(id._id || id).lean();
const balance = async (account) => r2((await svc.LedgerAccount.findById(account._id).lean()).currentBalance);
const absorbed = async () => svc.LedgerAccount.findById(await svc.Config.resolveAccount("production-absorbed")).lean();
const expense = (account, amount, description) =>
  svc.Financial.createVoucher({ voucherType: "expense", ledgerBased: true, expenseAccountId: account._id, amount, description, paymentMode: "cash", date: today() }, admin);
const brivox = (extra = {}) => ({
  finished: { stockId: finished._id, qty: 1 },
  materials: [{ stockId: raw._id, qty: 1 }],
  costs: [
    { accountId: travelling._id, amount: 50 },
    { accountId: coating._id, amount: 50, narration: "metal coating powder" },
    { accountId: packing._id, amount: 20 },
  ],
  ...extra,
});
const entriesOf = (p) => svc.LedgerEntry.find({ voucherId: p._id }).lean();

async function expenseAccount(name, code) {
  const rent = await svc.LedgerAccount.findOne({ accountName: "Rent Expense" }).lean();
  return svc.LedgerAccount.create({
    accountCode: code, accountName: name, accountType: "expense", subType: rent.subType, groupId: rent.groupId, level: rent.level,
    isActive: true, allowDirectPosting: true, currentBalance: 0, openingBalance: 0, createdBy: admin,
  });
}

test("setup", { skip }, async () => {
  assert.equal(await svc.Config.isPostingEnabled(), true, "the seed switches ledger posting on");
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Malabar Metals", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Majid", contactPerson: "Majid", phone: "0501234567", shippingAddress: "x", paymentTerms: "Net 30" });
  category = await svc.Category.create({ name: "Parts" });
  raw = await svc.Stock.create({ itemId: "RAW1", sku: "RAW1", itemName: "Raw part", category: category._id });
  finished = await svc.Stock.create({ itemId: "FIN1", sku: "FIN1", itemName: "Coated part", category: category._id });
  other = await svc.Stock.create({ itemId: "OTH1", sku: "OTH1", itemName: "Bracket", category: category._id });
  travelling = await expenseAccount("Travelling", "EXP-901");
  coating = await expenseAccount("Metal Coating Powder", "EXP-902");
  packing = await expenseAccount("Packing", "EXP-903");
  cash = await svc.LedgerAccount.findOne({ accountName: "Cash in Hand" }).lean();
  await buy([L(raw, 1, 50)]);
  await expense(travelling, 50, "Travelling to the coating shop");
  await expense(coating, 50, "Metal coating powder");
  await expense(packing, 20, "Packing");
  assert.deepEqual([await balance(travelling), await balance(coating), await balance(packing)], [50, 50, 20]);
});

// ===================================== the Brivox case =====================================

test("a production makes the finished part at 170: 50 of material and 120 of expenses moved in", { skip }, async () => {
  const draft = await svc.P.create(brivox(), String(admin));
  assert.equal(draft.status, "DRAFT");
  assert.match(draft.productionNo, /^PRD-\d{4}-0001$/);
  assert.equal(await svc.Movement.countDocuments({ referenceId: draft._id }), 0, "a draft moves nothing");
  assert.equal((await entriesOf(draft)).length, 0, "and posts nothing");
  const read = await svc.P.getById(draft._id);
  assert.deepEqual(read.preview.totals, { materials: 50, costs: 120, total: 170, unitCost: 170 }, "the preview prices it as it would post today");

  const p = await svc.P.post(draft._id, {}, String(admin));
  assert.equal(p.status, "POSTED");
  assert.deepEqual(JSON.parse(JSON.stringify(p.totals)), { materials: 50, costs: 120, total: 170, unitCost: 170 });
  assert.equal(p.ledgerPosted, true);

  const [r, f] = [await item(raw), await item(finished)];
  assert.deepEqual([r.currentStock, r2(r.costValue)], [0, 0], "the raw part is used up");
  assert.deepEqual([f.currentStock, r2(f.costValue), f.purchasePrice], [1, 170, 170], "the finished part is on hand at 170");

  const moves = await svc.Movement.find({ referenceId: p._id }).sort({ quantity: 1 }).lean();
  assert.deepEqual(moves.map((m) => [m.eventType, m.stockId, m.quantity, m.totalValue, m.costBasis]), [
    ["PRODUCTION_ISSUE", "RAW1", -1, 50, "production"],
    ["PRODUCTION_RECEIPT", "FIN1", 1, 170, "production"],
  ]);
  assert.equal(await svc.Batch.countDocuments({ sourceTransactionId: p._id }), 1, "the finished part has a batch, like a purchase");

  const entries = await entriesOf(p);
  const inventory = await svc.Config.resolveAccount("inventory-asset");
  const abs = await absorbed();
  assert.equal(abs.accountName, "Production Costs Moved to Stock");
  const net = (id) => r2(entries.filter((e) => String(e.accountId) === String(id)).reduce((s, e) => s + e.debitAmount - e.creditAmount, 0));
  assert.equal(net(inventory), 120, "Inventory goes up by the costs moved in (170 in, 50 out)");
  assert.equal(net(abs._id), -120);
  assert.equal(entries.length, 5);
  assert.ok(entries.every((e) => e.voucherType === "production" && e.voucherNo === p.productionNo && e.month >= 1 && e.financialYear));
  assert.ok(entries.some((e) => /^Metal Coating Powder moved to stock: production PRD-.* - metal coating powder$/.test(e.narration)));

  // each expense account keeps what was spent on it; the amount moved is one line of its own
  assert.deepEqual([await balance(travelling), await balance(coating), await balance(packing)], [50, 50, 20]);
  assert.equal(await balance(abs), -120);
});

test("selling the finished part at 200: cost of goods 170, profit 30", { skip }, async () => {
  const sale = await sell([L(finished, 1, 200)]);
  const entries = await svc.LedgerEntry.find({ voucherId: sale._id, isReversed: { $ne: true } }).lean();
  const cogs = await svc.Config.resolveAccount("cogs");
  assert.equal(r2(entries.filter((e) => String(e.accountId) === String(cogs)).reduce((s, e) => s + e.debitAmount - e.creditAmount, 0)), 170);
  assert.equal((await item(finished)).currentStock, 0);

  const pl = await svc.Ledger.profitAndLoss({ from: today(), to: today() });
  assert.equal(pl.netProfit, 30, "sold 200 - cost of goods 170; the expenses are in the cost, not counted twice");
  const opex = pl.operatingExpenses.groups.flatMap((g) => g.accounts);
  const line = (name) => opex.find((a) => a.accountName === name)?.amount;
  assert.deepEqual([line("Travelling"), line("Metal Coating Powder"), line("Packing"), line("Production Costs Moved to Stock")], [50, 50, 20, -120],
    "the P&L still shows each expense, with the amount moved to stock beside them");
});

test("stock against the ledger agrees, with productions as a line of their own", { skip }, async () => {
  const check = await svc.StockReports.ledgerCheck({ asOn: today() });
  assert.equal(check.reconciles, true, JSON.stringify(check.lines));
  const line = check.lines.find((l) => l.key === "production");
  assert.deepEqual([line.stock, line.ledger, line.difference], [120, 120, 0]);
  const movement = await svc.StockReports.movement({ from: today(), to: today() });
  assert.equal(movement.totals.production.value, 120, "the movement report: 170 made less 50 used");
});

test("the trail behind the production's ledger row", { skip }, async () => {
  const p = await svc.Production.findOne({ status: "POSTED" }).lean();
  const trail = await svc.Audit.postingTrail(p._id);
  assert.equal(trail.source.kind, "production");
  assert.equal(trail.source.label, "Production");
  assert.equal(trail.voucher.status, "posted");
  const facts = Object.fromEntries(trail.source.facts.map((f) => [f.label, f.value]));
  assert.equal(facts["Item made"], "Coated part x 1");
  assert.equal(facts["Moved in from Travelling"], 50);
  assert.equal(facts["Total cost"], 170);
});

// ===================================== refusals =====================================

test("refused: more material than is on hand, an item making itself, a service, the wrong kind of account", { skip }, async () => {
  const short = await svc.P.create({ finished: { stockId: finished._id, qty: 1 }, materials: [{ stockId: raw._id, qty: 5 }] }, "tester");
  await assert.rejects(() => svc.P.post(short._id, {}, "tester"), { code: "INSUFFICIENT_STOCK", statusCode: 409 });
  assert.equal((await svc.Production.findById(short._id)).status, "DRAFT", "nothing was posted");
  await svc.P.remove(short._id, "tester");
  assert.equal(await svc.Production.countDocuments({ _id: short._id }), 0, "a draft can be deleted");

  await assert.rejects(() => svc.P.create({ finished: { stockId: raw._id, qty: 1 }, materials: [{ stockId: raw._id, qty: 1 }] }, "tester"), { code: "MATERIAL_IS_FINISHED_ITEM" });
  const svcItem = await svc.Stock.create({ itemId: "SRV1", sku: "SRV1", itemName: "Coating service", itemType: "service", category: category._id });
  await assert.rejects(() => svc.P.create({ finished: { stockId: svcItem._id, qty: 1 }, costs: [{ accountId: travelling._id, amount: 1 }] }, "tester"), { code: "SERVICE_HAS_NO_STOCK" });
  await assert.rejects(() => svc.P.create({ finished: { stockId: finished._id, qty: 1 }, costs: [{ accountId: cash._id, amount: 1 }] }, "tester"), { code: "INVALID_COST_ACCOUNT" }, "cash is not an expense");
  const cogs = await svc.Config.resolveAccount("cogs");
  await assert.rejects(() => svc.P.create({ finished: { stockId: finished._id, qty: 1 }, costs: [{ accountId: cogs, amount: 1 }] }, "tester"), { code: "INVALID_COST_ACCOUNT" }, "cost of goods cannot be moved into a product");
  const abs = await absorbed();
  await assert.rejects(() => svc.P.create({ finished: { stockId: finished._id, qty: 1 }, costs: [{ accountId: abs._id, amount: 1 }] }, "tester"), { code: "INVALID_COST_ACCOUNT" });
  await assert.rejects(() => svc.P.create({ finished: { stockId: finished._id, qty: 1 }, costs: [{ accountId: travelling._id, amount: 1 }], date: svc.days.addDays(today(), 1) }, "tester"), { code: "INVALID_DATE" });
});

test("moving more than was spent asks for a tick", { skip }, async () => {
  // all 50 of travelling was moved by the first production
  const p = await svc.P.create({ finished: { stockId: other._id, qty: 1 }, costs: [{ accountId: travelling._id, amount: 30 }] }, "tester");
  await assert.rejects(() => svc.P.post(p._id, {}, "tester"), (e) => e.code === "PRODUCTION_WARNINGS" && e.details.warnings[0].code === "COST_EXCEEDS_SPEND" && e.details.warnings[0].available === 0);
  await expense(travelling, 30, "Another trip");
  const posted = await svc.P.post(p._id, {}, "tester");
  assert.equal(posted.status, "POSTED", "once the money is spent it posts without a tick");
  const p2 = await svc.P.create({ finished: { stockId: other._id, qty: 1 }, costs: [{ accountId: packing._id, amount: 5 }] }, "tester");
  const ticked = await svc.P.post(p2._id, { acknowledge: ["COST_EXCEEDS_SPEND"] }, "tester");
  assert.deepEqual([...ticked.acknowledged], ["COST_EXCEEDS_SPEND"], "the tick is kept with the production");
  assert.deepEqual([(await item(other)).currentStock, r2((await item(other)).costValue)], [2, 35]);
});

test("refused: a production dated before a later movement of its items", { skip }, async () => {
  const p = await svc.P.create({ finished: { stockId: other._id, qty: 1 }, costs: [{ accountId: travelling._id, amount: 1 }], date: yesterday() }, "tester");
  await assert.rejects(() => svc.P.post(p._id, { acknowledge: ["COST_EXCEEDS_SPEND"] }, "tester"), { code: "LATER_MOVEMENTS_EXIST" });
  await svc.P.remove(p._id, "tester");
});

test("refused: costs while ledger posting is off (materials alone still post)", { skip }, async () => {
  const company = (await svc.Settings.findOne({}).lean()).companyId;
  await svc.Settings.updateOne({ companyId: company }, { ledgerPostingEnabled: false });
  try {
    const withCosts = await svc.P.create({ finished: { stockId: other._id, qty: 1 }, costs: [{ accountId: travelling._id, amount: 1 }] }, "tester");
    await assert.rejects(() => svc.P.post(withCosts._id, {}, "tester"), { code: "LEDGER_POSTING_OFF" });
    await svc.P.remove(withCosts._id, "tester");
    await buy([L(raw, 2, 40)]); // stock, not posted (posting is off)
    const materialsOnly = await svc.P.create({ finished: { stockId: other._id, qty: 1 }, materials: [{ stockId: raw._id, qty: 1 }] }, "tester");
    const posted = await svc.P.post(materialsOnly._id, {}, "tester");
    assert.equal(posted.ledgerPosted, false);
    assert.equal((await entriesOf(posted)).length, 0);
    await svc.P.reverse(posted._id, {}, "tester");
  } finally {
    await svc.Settings.updateOne({ companyId: company }, { ledgerPostingEnabled: true });
  }
});

test("only a draft is changed: a posted production refuses edit, delete and a second post", { skip }, async () => {
  const p = await svc.Production.findOne({ status: "POSTED" }).lean();
  await assert.rejects(() => svc.P.update(p._id, { notes: "x" }, "tester"), { code: "PRODUCTION_NOT_DRAFT" });
  await assert.rejects(() => svc.P.remove(p._id, "tester"), { code: "PRODUCTION_NOT_DRAFT" });
  await assert.rejects(() => svc.P.post(p._id, {}, "tester"), { code: "PRODUCTION_NOT_DRAFT" });
  const d = await svc.P.create({ finished: { stockId: other._id, qty: 2 }, materials: [{ stockId: raw._id, qty: 1 }] }, "tester");
  const edited = await svc.P.update(d._id, { finished: { stockId: other._id, qty: 4 }, notes: "four brackets" }, "tester");
  assert.deepEqual([edited.finished.qty, edited.notes, edited.materials.length], [4, "four brackets", 1], "fields not sent are kept");
  await svc.P.remove(d._id, "tester");
});

// ===================================== reversal =====================================

test("reversing: refused once the goods are sold; otherwise stock, batches and the ledger come back", { skip }, async () => {
  const first = await svc.Production.findOne({ "finished.stockId": finished._id, status: "POSTED" }).lean();
  await assert.rejects(() => svc.P.reverse(first._id, {}, "tester"), { code: "FINISHED_STOCK_USED" }, "the coated part was sold");

  await buy([L(raw, 1, 60)]);
  const rawBefore = await item(raw);
  const absBefore = await balance(await absorbed());
  const p = await svc.P.post((await svc.P.create({ finished: { stockId: finished._id, qty: 1 }, materials: [{ stockId: raw._id, qty: 1 }], costs: [{ accountId: coating._id, amount: 10 }] }, "tester"))._id, { acknowledge: ["COST_EXCEEDS_SPEND"] }, "tester");
  assert.equal((await item(finished)).currentStock, 1);
  const reversed = await svc.P.reverse(p._id, { reason: "entered twice" }, "tester");
  assert.equal(reversed.status, "REVERSED");
  assert.equal(reversed.reverseReason, "entered twice");
  const [r, f] = [await item(raw), await item(finished)];
  assert.deepEqual([r.currentStock, r2(r.costValue)], [rawBefore.currentStock, r2(rawBefore.costValue)], "the material is back at its cost");
  assert.deepEqual([f.currentStock, r2(f.costValue)], [0, 0]);
  assert.equal(await svc.Batch.countDocuments({ sourceTransactionId: p._id }), 0, "its batch is gone");
  assert.equal(await balance(await absorbed()), absBefore, "the ledger is put back");
  assert.ok((await entriesOf(p)).every((e) => e.isReversed));
  assert.equal((await svc.Audit.postingTrail(p._id)).voucher.status, "reversed");
  await assert.rejects(() => svc.P.reverse(p._id, {}, "tester"), { code: "PRODUCTION_NOT_POSTED" });
  const check = await svc.StockReports.ledgerCheck({ asOn: today() });
  assert.equal(check.lines.find((l) => l.key === "production").difference, 0);
});

// ===================================== recost, type lock, top-up =====================================

test("a back-dated purchase of a material replays through the production at the production's fixed cost", { skip }, async () => {
  const pipe = await svc.Stock.create({ itemId: "PIPE1", sku: "PIPE1", itemName: "Pipe", category: category._id });
  const frame = await svc.Stock.create({ itemId: "FRAME1", sku: "FRAME1", itemName: "Frame", category: category._id });
  await buy([L(pipe, 2, 10)]);
  await svc.P.post((await svc.P.create({ finished: { stockId: frame._id, qty: 1 }, materials: [{ stockId: pipe._id, qty: 2 }] }, "tester"))._id, {}, "tester");
  assert.deepEqual([(await item(pipe)).currentStock, r2((await item(pipe)).costValue)], [0, 0]);
  // a purchase dated yesterday comes in after the production: the pipe's history is replayed from yesterday
  await buy([L(pipe, 3, 20)], { date: yesterday() });
  const p = await item(pipe);
  assert.deepEqual([p.currentStock, r2(p.costValue)], [3, 60], "replayed in date order: 3 in at 60, 2 in at 20, 2 out at the production's stamped 20 = 3 left worth 60 (at the replayed average it would be 48)");
  const issue = await svc.Movement.findOne({ stockId: "PIPE1", eventType: "PRODUCTION_ISSUE" }).lean();
  assert.equal(issue.totalValue, 20, "the production's cost is fixed: the frame was booked at it");
  assert.equal(issue.costBasis, "production");
  assert.equal(issue.cogsAmount, null);
  assert.equal(r2((await item(frame)).costValue), 20);
});

test("an item used in a production cannot change type", { skip }, async () => {
  const u = await svc.Kinds.usage(await item(finished));
  assert.ok(u.productions >= 1);
  const bracket = await item(other);
  await assert.rejects(() => svc.Kinds.assertTypeChange(bracket, "service"), { code: "ITEM_TYPE_LOCKED" });
});

test("a company whose posting map predates production-absorbed is topped up on its first production with costs", { skip }, async () => {
  const company = (await svc.Settings.findOne({}).lean()).companyId;
  await svc.Settings.updateOne({ companyId: company, "accountConfiguration.configKey": "production-absorbed" }, { $set: { "accountConfiguration.$.targetAccount": null } });
  await assert.rejects(() => svc.Config.resolveAccount("production-absorbed"), { code: "ACCOUNT_NOT_CONFIGURED" });
  const p = await svc.P.create({ finished: { stockId: other._id, qty: 1 }, costs: [{ accountId: packing._id, amount: 1 }] }, "tester");
  const posted = await svc.P.post(p._id, { acknowledge: ["COST_EXCEEDS_SPEND"] }, "tester");
  assert.equal(posted.ledgerPosted, true);
  assert.equal((await absorbed()).accountName, "Production Costs Moved to Stock", "mapped again by the top-up, and used");
});

test("an expense filed under Cost of Goods Sold is offset inside cost of sales, by a contra in its own group", { skip }, async () => {
  const cogsAccount = await svc.LedgerAccount.findOne({ accountName: "Cost of Goods Sold" }).lean();
  const direct = await svc.LedgerAccount.create({
    accountCode: "COGS-901", accountName: "Direct Coating", accountType: "expense", subType: cogsAccount.subType, groupId: cogsAccount.groupId,
    level: cogsAccount.level, isActive: true, allowDirectPosting: true, currentBalance: 0, openingBalance: 0, createdBy: admin,
  });
  await expense(direct, 40, "Coating job");
  const contraIn = (groupId) => svc.LedgerAccount.find({ groupId, accountName: "Production Costs Moved to Stock" }).lean();
  assert.equal((await contraIn(cogsAccount.groupId)).length, 0, "none until it is needed");

  const p = await svc.P.post((await svc.P.create({ finished: { stockId: other._id, qty: 1 }, costs: [{ accountId: direct._id, amount: 40 }] }, "tester"))._id, {}, "tester");
  const [contra] = await contraIn(cogsAccount.groupId);
  assert.ok(contra, "made in the expense's own group on first use");
  assert.equal(contra.isSystemAccount, true);
  const entries = await entriesOf(p);
  assert.equal(r2(entries.filter((e) => String(e.accountId) === String(contra._id)).reduce((s, e) => s + e.creditAmount, 0)), 40);
  const opexContra = (await absorbed())._id;
  assert.equal(entries.some((e) => String(e.accountId) === String(opexContra)), false, "nothing to the Operating Expenses contra");
  assert.deepEqual([await balance(direct), await balance(contra)], [40, -40], "the expense keeps its 40; the contra beside it carries -40");

  // the P&L: both lines in cost of sales, side by side
  const pl = await svc.Ledger.profitAndLoss({ from: today(), to: today() });
  const directLines = pl.directCosts.groups.flatMap((g) => g.accounts);
  assert.equal(directLines.find((a) => a.accountName === "Direct Coating")?.amount, 40);
  assert.ok(directLines.some((a) => String(a.accountId) === String(contra._id)), "the contra is in cost of sales, not in operating expenses");
  assert.equal(pl.operatingExpenses.groups.flatMap((g) => g.accounts).some((a) => String(a.accountId) === String(contra._id)), false);

  // a second production reuses it; it can never be a cost itself; reversal puts it back
  await expense(direct, 10, "Another coating job");
  const p2 = await svc.P.post((await svc.P.create({ finished: { stockId: other._id, qty: 1 }, costs: [{ accountId: direct._id, amount: 10 }] }, "tester"))._id, {}, "tester");
  assert.equal((await contraIn(cogsAccount.groupId)).length, 1, "one contra per group");
  assert.equal(await balance(contra), -50);
  await assert.rejects(() => svc.P.create({ finished: { stockId: other._id, qty: 1 }, costs: [{ accountId: contra._id, amount: 1 }] }, "tester"), { code: "INVALID_COST_ACCOUNT" });
  await svc.P.reverse(p2._id, {}, "tester");
  assert.equal(await balance(contra), -40);
  assert.equal((await svc.StockReports.ledgerCheck({ asOn: today() })).lines.find((l) => l.key === "production").difference, 0);
});

test("a sale dated the same day after a production: the replay keeps the order things happened in (found on live books)", { skip }, async () => {
  // a production posted today, then a sales invoice dated today (documents are dated at midnight): the cost replay the
  // sale starts must put the production first, or the item's stored value counts the production twice
  const part = await svc.Stock.create({ itemId: "PART9", sku: "PART9", itemName: "Part 9", category: (await svc.Category.findOne({}))._id });
  const made = await svc.Stock.create({ itemId: "MADE9", sku: "MADE9", itemName: "Made 9", category: part.category });
  await buy([L(part, 100, 50)]);
  await svc.P.post((await svc.P.create({ finished: { stockId: made._id, qty: 100 }, materials: [{ stockId: part._id, qty: 100 }] }, "tester"))._id, {}, "tester");
  await sell([L(made, 10, 120)], { date: today() }); // a day, as the invoice form sends it: stored at midnight
  const m = await item(made);
  assert.deepEqual([m.currentStock, r2(m.costValue), m.purchasePrice], [90, 4500, 50], "90 left at 50 each: 4,500, not 9,500");
  // the item's stored value equals what its last movement left in the pool (an earlier test in this file posted a purchase
  // with ledger posting off, so the organisation-wide stock-vs-ledger figure is not the measure here)
  const last = await svc.Movement.findOne({ stockId: "MADE9" }).sort({ date: -1, createdAt: -1, _id: -1 }).lean();
  assert.equal(last.eventType, "SALES_DISPATCH", "the sale sorts after the production it came after");
  assert.equal(r2(last.costPoolAfter), r2(m.costValue));
});
