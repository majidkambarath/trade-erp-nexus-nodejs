// Service items (non-stock) against a throwaway database (random name, dropped afterwards).
//
// What these prove, beyond the pure rules in utils/__tests__/itemKinds.test.js:
//   - the item API: type validation, no stock fields on a service, account categories, the type lock
//   - a service-only sale approves with revenue + VAT + receivable and EXACTLY no stock movement and no
//     cost-of-goods / Inventory ledger row; a mixed invoice moves stock for the goods lines only
//   - a service bought is expensed (never Inventory), including for a company whose posting map predates the key
//   - a sales return of a service, and deleting an approved service invoice, reverse cleanly
//   - stock reports, valuation, reorder, low stock, the dashboard counts and opening stock ignore services,
//     while sales analysis counts their revenue
//   - delivery notes: no availability, no pick line, and closing short keeps the service line
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
    Tx: require("../orderPurchase/transactionService"),
    D: require("../orderPurchase/deliveryNoteService"),
    Close: require("../orderPurchase/orderCloseService"),
    StockService: require("../stock/stockService"),
    Adjust: require("../stock/stockAdjustmentService"),
    OB: require("../financial/openingBalanceService"),
    StockReports: require("../reports/stockReportsService"),
    Dashboard: require("../reports/dashboardService"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Category: require("../../models/modules/categoryModel"),
    Settings: require("../../models/modules/financial/companySettingsModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
    Batch: require("../../models/modules/stockBatchModel"),
    CreditLog: require("../../models/modules/CreditLog"),
    LedgerAccount: fin.LedgerAccount,
    LedgerEntry: fin.LedgerEntry,
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
let vendor, customer, category, rice, consulting, design, incomeAccount, expenseAccount;
const L = (item, qty, price, extra = {}) => ({ itemId: item._id, description: item.itemName, qty, price, rate: price, vatPercent: 5, ...extra });
const doc = (type, party, partyType, items, extra = {}) =>
  svc.Tx.createTransaction({ type, partyId: party._id, partyType, partyTypeRef: partyType, items, ...extra }, "tester");
const sell = (items, extra) => doc("sales_order", customer, "Customer", items, extra);
const buy = (items, extra) => doc("purchase_order", vendor, "Vendor", items, extra);
const approve = async (t) => svc.Tx.processTransaction(t._id, "approve", "tester");
const sellApproved = async (items, extra) => approve(await sell(items, extra));
const buyApproved = async (items, extra) => approve(await buy(items, extra));
const onHand = async (item) => (await svc.Stock.findById(item._id)).currentStock;
const movesOf = (t) => svc.Movement.find({ referenceId: t._id, referenceType: "Transaction" }).lean();
const entriesOf = (t) => svc.LedgerEntry.find({ voucherId: t._id }).lean();
const live = async (t) => (await entriesOf(t)).filter((e) => !e.isReversed);
const nameOf = async (accountId) => (await svc.LedgerAccount.findById(accountId).lean()).accountName;
// debit - credit per account NAME across a document's live entries
async function byAccount(t) {
  const out = {};
  for (const e of await live(t)) out[e.accountName] = r2((out[e.accountName] || 0) + e.debitAmount - e.creditAmount);
  return out;
}
const totals = (entries) => ({ debit: r2(entries.reduce((s, e) => s + e.debitAmount, 0)), credit: r2(entries.reduce((s, e) => s + e.creditAmount, 0)) });
const accountId = async (key) => svc.Config.resolveAccount(key);

test("setup", { skip }, async () => {
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Vend", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Cust", contactPerson: "Ali", phone: "0501234567", shippingAddress: "Warehouse 4", paymentTerms: "Net 30" });
  category = await svc.Category.create({ name: "General" });
  rice = await svc.Stock.create({ itemId: "ITM1", sku: "SKU1", itemName: "Rice", category: category._id });
  incomeAccount = await svc.LedgerAccount.findOne({ accountName: "Other Income" });
  expenseAccount = await svc.LedgerAccount.findOne({ accountName: "Rent Expense" });
  assert.ok(incomeAccount && expenseAccount, "the default chart has an income and an expense account to point at");
  await buyApproved([L(rice, 500, 10)]);
});

// ===================================== the item API =====================================

test("the item API: a type must be goods or service, and a service carries no stock fields", { skip }, async () => {
  const base = { categoryId: category._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "x" };
  await assert.rejects(() => svc.StockService.createStock({ ...base, sku: "BAD1", itemName: "Bad", itemType: "subscription" }, "tester"), { code: "INVALID_ITEM_TYPE", statusCode: 400 });
  for (const field of [{ currentStock: 5 }, { reorderLevel: 3 }, { batchNumber: "B1" }, { expiryDate: "2027-01-01" }]) {
    await assert.rejects(
      () => svc.StockService.createStock({ ...base, sku: "BAD2", itemName: "Bad", itemType: "service", ...field }, "tester"),
      (e) => e.code === "SERVICE_HAS_NO_STOCK" && e.statusCode === 400 && e.details.fields.length === 1,
      `a service refuses ${Object.keys(field)[0]}`
    );
  }
  assert.equal(await svc.Stock.countDocuments({ sku: /^BAD/ }), 0, "nothing was created");

  // the accounts a service names must be accounts of the right kind
  await assert.rejects(() => svc.StockService.createStock({ ...base, sku: "BAD3", itemName: "Bad", itemType: "service", incomeAccountId: expenseAccount._id }, "tester"), { code: "INVALID_INCOME_ACCOUNT" });
  await assert.rejects(() => svc.StockService.createStock({ ...base, sku: "BAD4", itemName: "Bad", itemType: "service", expenseAccountId: incomeAccount._id }, "tester"), { code: "INVALID_EXPENSE_ACCOUNT" });
  await assert.rejects(() => svc.StockService.createStock({ ...base, sku: "BAD5", itemName: "Bad", itemType: "service", incomeAccountId: "not-an-id" }, "tester"), { code: "INVALID_INCOME_ACCOUNT" });
  await assert.rejects(() => svc.StockService.createStock({ ...base, sku: "BAD6", itemName: "Bad", incomeAccountId: incomeAccount._id }, "tester"), { code: "ACCOUNTS_ONLY_FOR_SERVICES" }, "goods name no accounts of their own");

  // zero and blank stock fields are what a form sends: fine
  consulting = await svc.StockService.createStock({ ...base, sku: "SRV-CONSULT", itemName: "Consulting", itemType: "service", salesPrice: 400, purchasePrice: 250, currentStock: "0", reorderLevel: "", batchNumber: "", expiryDate: "" }, "tester");
  design = await svc.StockService.createStock({ ...base, sku: "SRV-DESIGN", itemName: "Design", itemType: "service", salesPrice: 1000, incomeAccountId: incomeAccount._id, expenseAccountId: expenseAccount._id }, "tester");
  assert.equal(consulting.itemType, "service");
  assert.equal(consulting.currentStock, 0);
  assert.equal(consulting.reorderLevel, 0);
  assert.equal(consulting.barcodeQrCode, undefined, "a service has no barcode");
  assert.equal(String(design.incomeAccountId), String(incomeAccount._id));
  assert.equal(await svc.Movement.countDocuments({ stockId: consulting.itemId }), 0);

  // an item created before services existed has no itemType and reads as goods
  const legacy = await svc.Stock.collection.insertOne({ companyId: rice.companyId, itemId: "LEG1", sku: "LEG1", itemName: "Legacy", category: category._id, currentStock: 0, reorderLevel: 0, status: "Active" });
  const read = await svc.Stock.findById(legacy.insertedId).lean();
  assert.equal(read.itemType, undefined, "stored with no type");
  assert.equal((await svc.StockService.getAllStock({ itemType: "goods" })).some((s) => s.itemId === "LEG1"), true, "and found as goods");
  assert.equal((await svc.StockService.getAllStock({ itemType: "service" })).some((s) => s.itemId === "LEG1"), false);
  await svc.Stock.deleteOne({ _id: legacy.insertedId });

  const goods = await svc.StockService.getAllStock({ itemType: "goods" });
  const services = await svc.StockService.getAllStock({ itemType: "service" });
  assert.deepEqual(services.map((s) => s.itemName).sort(), ["Consulting", "Design"]);
  assert.ok(goods.every((s) => s.itemType !== "service") && goods.some((s) => s.itemName === "Rice"));
  assert.equal((await svc.StockService.getAllStock({})).length, goods.length + services.length, "no filter lists everything");
  await assert.rejects(() => svc.StockService.getAllStock({ itemType: "x" }), { code: "INVALID_ITEM_TYPE" });
  assert.deepEqual(await svc.StockService.getAllStock({ itemType: "service", lowStock: "true" }), [], "a service is never low on stock");
});

test("an item's type is locked once something is built on it, and free before that", { skip }, async () => {
  // goods with a stock history cannot become a service
  await assert.rejects(() => svc.StockService.updateStock(rice._id, { itemType: "service" }, "tester"), (e) => {
    assert.equal(e.code, "ITEM_TYPE_LOCKED");
    assert.equal(e.statusCode, 409);
    assert.ok(e.details.movements > 0 && e.details.documents > 0);
    assert.match(e.message, /Rice cannot become a service/);
    return true;
  });
  assert.equal((await svc.Stock.findById(rice._id)).itemType, "goods");

  // an unused goods item can become a service, and leaves its stock side behind
  const spare = await svc.StockService.createStock({ categoryId: category._id, sku: "SPARE", itemName: "Spare", reorderLevel: 4, batchNumber: "B9", expiryDate: "2027-06-01", unitOfMeasure: new mongoose.Types.ObjectId() }, "tester");
  const switched = await svc.StockService.updateStock(spare._id, { itemType: "service", salesPrice: 50 }, "tester");
  assert.equal(switched.itemType, "service");
  assert.equal(switched.reorderLevel, 0);
  assert.equal(switched.batchNumber, undefined);
  assert.equal(switched.expiryDate, undefined);
  assert.equal(switched.barcodeQrCode, undefined);
  // and back again while nothing refers to it; accounts are forgotten
  await svc.StockService.updateStock(spare._id, { incomeAccountId: incomeAccount._id }, "tester");
  const back = await svc.StockService.updateStock(spare._id, { itemType: "goods" }, "tester");
  assert.equal(back.itemType, "goods");
  assert.equal(back.incomeAccountId, null);
  await assert.rejects(() => svc.StockService.updateStock(spare._id, { itemType: "bogus" }, "tester"), { code: "INVALID_ITEM_TYPE" });
  await assert.rejects(() => svc.StockService.updateStock(spare._id, { itemType: "service", currentStock: 3 }, "tester"), { code: "SERVICE_HAS_NO_STOCK" });

  // a service with a document against it cannot become goods; one nothing refers to can
  const draft = await sell([L(consulting, 1, 400)]);
  await assert.rejects(() => svc.StockService.updateStock(consulting._id, { itemType: "goods" }, "tester"), { code: "ITEM_TYPE_LOCKED" });
  await svc.Tx.deleteTransaction(draft._id, "tester");
  const unused = await svc.StockService.createStock({ categoryId: category._id, sku: "SRV-TMP", itemName: "Temp", itemType: "service", unitOfMeasure: new mongoose.Types.ObjectId() }, "tester");
  assert.equal((await svc.StockService.updateStock(unused._id, { itemType: "goods" }, "tester")).itemType, "goods");
  await svc.Stock.deleteOne({ _id: spare._id });
  await svc.Stock.deleteOne({ _id: unused._id });
});

test("a service has no quantity to adjust, count, open with or move", { skip }, async () => {
  await assert.rejects(() => svc.StockService.updateStock(consulting._id, { currentStock: 5 }, "tester"), { code: "SERVICE_HAS_NO_STOCK" });
  const fresh = await svc.Stock.findById(consulting._id);
  await assert.rejects(() => svc.Adjust.apply({ stock: fresh, newQuantity: 3, createdBy: "tester" }, { session: null }), { code: "SERVICE_HAS_NO_STOCK", statusCode: 409 });
  const today = new Date().toISOString().slice(0, 10);
  await assert.rejects(() => svc.OB.postStock({ date: today, rows: [{ itemId: consulting._id, qty: 1, unitCost: 5 }] }, "tester"), { code: "SERVICE_HAS_NO_STOCK" });
  assert.ok(!(await svc.OB.listStock()).stocks?.some?.((s) => s.itemId === consulting.itemId) && !JSON.stringify(await svc.OB.listStock()).includes("SRV-CONSULT"), "opening stock does not offer services");
  assert.equal(await svc.Movement.countDocuments({ stockId: consulting.itemId }), 0);
  assert.equal(await svc.Batch.countDocuments({ stockId: consulting._id }), 0);
});

// ===================================== selling =====================================

let serviceSale;
test("a service-only sale approves with revenue, VAT and the receivable and moves nothing in stock", { skip }, async () => {
  const movesBefore = await svc.Movement.countDocuments({});
  const riceBefore = await onHand(rice);
  const balanceBefore = (await svc.Customer.findById(customer._id)).cashBalance;

  // 1000 hours with nothing on hand: a service never fails on "insufficient stock"
  const draft = await sell([L(consulting, 1000, 400)]);
  assert.equal(draft.items[0].itemType, "service", "the line is stamped from the item master");
  serviceSale = await approve(draft);
  assert.equal(serviceSale.status, "APPROVED");

  assert.equal(serviceSale.totalAmount, 420000, "400 000 + 5% VAT");
  assert.equal((await movesOf(serviceSale)).length, 0, "no InventoryMovement");
  assert.equal(await svc.Movement.countDocuments({}), movesBefore);
  assert.equal(await onHand(consulting), 0);
  assert.equal(await onHand(rice), riceBefore);
  assert.equal(serviceSale.items[0].allocations.length, 0, "no batch allocation");
  assert.equal((await svc.Batch.find({ stockId: consulting._id })).length, 0);

  const net = await byAccount(serviceSale);
  const entries = await live(serviceSale);
  assert.deepEqual(Object.keys(net).sort(), ["Customer - Cust", "Output VAT", "Sales Revenue"].sort(), "receivable, revenue and VAT - and nothing else");
  assert.equal(net["Customer - Cust"], 420000);
  assert.equal(net["Sales Revenue"], -400000);
  assert.equal(net["Output VAT"], -20000);
  assert.equal(totals(entries).debit, totals(entries).credit);
  for (const e of entries) assert.ok(!/cost of goods|inventory/i.test(e.accountName), `no ${e.accountName} leg`);
  assert.equal((await svc.Customer.findById(customer._id)).cashBalance, balanceBefore - 420000, "the customer owes it");
});

test("a service that names an income account earns into it", { skip }, async () => {
  const t = await sellApproved([L(design, 2, 1000)]);
  const net = await byAccount(t);
  assert.equal(net[incomeAccount.accountName], -2000, "the item's income account");
  assert.equal(net["Sales Revenue"], undefined, "not the default one");
  assert.equal(net["Output VAT"], -100);
  assert.equal(net["Customer - Cust"], 2100);
  assert.equal((await movesOf(t)).length, 0);
  await svc.Tx.deleteTransaction(t._id, "tester");
});

let mixedSale;
test("a mixed invoice moves stock for the goods lines only, and the books balance", { skip }, async () => {
  const before = await onHand(rice);
  const draft = await sell([L(rice, 10, 20), L(consulting, 3, 400), L(design, 1, 1000)]);
  assert.deepEqual(draft.items.map((i) => i.itemType), ["goods", "service", "service"]);
  mixedSale = await approve(draft);

  const moves = await movesOf(mixedSale);
  assert.equal(moves.length, 1, "one movement: the rice");
  assert.equal(moves[0].stockId, "ITM1");
  assert.equal(moves[0].quantity, -10);
  assert.equal(await onHand(rice), before - 10);
  assert.equal(await onHand(consulting), 0);
  assert.equal(mixedSale.items[1].allocations.length, 0, "the service line is allocated no batch");
  assert.equal(mixedSale.items[2].allocations.length, 0);

  const entries = await live(mixedSale);
  const net = await byAccount(mixedSale);
  assert.equal(totals(entries).debit, totals(entries).credit, "balanced");
  assert.equal(net["Sales Revenue"], -(200 + 1200), "rice and consulting");
  assert.equal(net[incomeAccount.accountName], -1000, "design");
  assert.equal(net["Output VAT"], -(1400 + 1000) * 0.05);
  assert.equal(net["Cost of Goods Sold"], r2(Math.abs(moves[0].totalValue)), "cost of the rice only");
  assert.equal(net["Inventory Stock"], -r2(Math.abs(moves[0].totalValue)));
  assert.equal(net["Customer - Cust"], mixedSale.totalAmount);
});

test("deleting an approved service invoice reverses everything and moves no stock", { skip }, async () => {
  const riceBefore = await onHand(rice);
  const movesBefore = await svc.Movement.countDocuments({});
  const balanceBefore = (await svc.Customer.findById(customer._id)).cashBalance;
  const grossBefore = totals(await live(serviceSale));
  assert.ok(grossBefore.debit > 0);

  await svc.Tx.deleteTransaction(serviceSale._id, "tester");
  assert.equal(await svc.Transaction.countDocuments({ _id: serviceSale._id }), 0);
  assert.equal(await svc.Movement.countDocuments({}), movesBefore, "no reversal movement either: there was none to reverse");
  assert.equal(await onHand(rice), riceBefore);
  assert.equal((await svc.Customer.findById(customer._id)).cashBalance, balanceBefore + 420000);
  const left = (await entriesOf(serviceSale)).filter((e) => !e.isReversed);
  assert.equal(left.length, 0, "every entry is reversed");
  const net = {};
  for (const e of await entriesOf(serviceSale)) net[e.accountName] = r2((net[e.accountName] || 0) + e.debitAmount - e.creditAmount);
  assert.ok(Object.values(net).every((v) => v === 0), "and nets to nothing per account");
});

test("deleting an approved mixed invoice puts back only the goods", { skip }, async () => {
  const before = await onHand(rice);
  const moves = await svc.Movement.countDocuments({ referenceId: mixedSale._id });
  await svc.Tx.deleteTransaction(mixedSale._id, "tester");
  assert.equal(await onHand(rice), before + 10);
  assert.equal((await live(mixedSale)).length, 0, "every ledger entry is reversed");
  assert.equal(await svc.Movement.countDocuments({ referenceId: mixedSale._id }), moves * 2, "one dispatch and its reversal: the rice only");
  assert.equal(await onHand(consulting), 0);
});

test("a service sale approved while ledger posting was off is posted by the catch-up, with the same routing", { skip }, async () => {
  const Posting = require("../financial/postingService");
  const company = (await svc.Settings.findOne({}).lean()).companyId;
  await svc.Settings.updateOne({ companyId: company }, { ledgerPostingEnabled: false });
  const t = await sellApproved([L(design, 1, 1000), L(consulting, 1, 400)]);
  assert.equal((await entriesOf(t)).length, 0, "nothing reached the ledger while posting was off");
  await svc.Settings.updateOne({ companyId: company }, { ledgerPostingEnabled: true });

  const result = await Posting.catchUp({ createdBy: "tester" });
  assert.deepEqual(result.failed, []);
  const net = await byAccount(t);
  assert.equal(net[incomeAccount.accountName], -1000, "the item's own income account");
  assert.equal(net["Sales Revenue"], -400);
  assert.equal(net["Output VAT"], -70);
  assert.equal(net["Customer - Cust"], 1470);
  assert.equal((await movesOf(t)).length, 0);
  await svc.Tx.deleteTransaction(t._id, "tester");
});

// ===================================== returns =====================================

test("a sales return of a service credits the customer and takes back revenue and VAT, with no stock effect", { skip }, async () => {
  const sale = await sellApproved([L(design, 4, 1000)]);
  const movesBefore = await svc.Movement.countDocuments({});
  const ret = await approve(await doc("sales_return", customer, "Customer", [L(design, 1, 1000, { returnOfLineId: sale.items[0]._id })], { returnOf: { transactionId: sale._id } }));
  assert.equal(ret.items[0].itemType, "service");
  assert.equal(await svc.Movement.countDocuments({}), movesBefore, "no stock came back: none went out");
  const net = await byAccount(ret);
  assert.equal(net[incomeAccount.accountName], 1000, "revenue taken back from the item's income account");
  assert.equal(net["Output VAT"], 50);
  assert.equal(net["Customer - Cust"], -1050);
  assert.equal(Object.keys(net).length, 3);
  // the return cannot exceed what was sold
  await assert.rejects(() => doc("sales_return", customer, "Customer", [L(design, 4, 1000, { returnOfLineId: sale.items[0]._id })], { returnOf: { transactionId: sale._id } }), { code: "OVER_RETURN" });
  await svc.Tx.deleteTransaction(ret._id, "tester");
  await svc.Tx.deleteTransaction(sale._id, "tester");
});

// ===================================== buying =====================================

test("a service bought is expensed, never put into Inventory, and mixed invoices split cleanly", { skip }, async () => {
  const movesBefore = await svc.Movement.countDocuments({});
  const t = await buyApproved([L(consulting, 10, 250), L(design, 1, 600)]);
  assert.equal(await svc.Movement.countDocuments({}), movesBefore);
  assert.equal((await svc.Batch.find({ sourceTransactionId: t._id })).length, 0, "no batch received");
  const net = await byAccount(t);
  const serviceExpense = await nameOf(await accountId("service-expense"));
  assert.equal(net[serviceExpense], 2500, "the default account for the service with none of its own");
  assert.equal(net[expenseAccount.accountName], 600, "the item's own expense account");
  assert.equal(net["Input VAT"], 155);
  assert.equal(net["Vendor - Vend"], -3255);
  assert.equal(net["Inventory Stock"], undefined, "no Inventory leg");
  assert.equal(await onHand(consulting), 0);

  // goods and a service on one purchase: Inventory only for the goods
  const ricePool = await svc.Stock.findById(rice._id);
  const m = await buyApproved([L(rice, 100, 12), L(consulting, 2, 250)]);
  assert.equal((await movesOf(m)).length, 1);
  const mnet = await byAccount(m);
  assert.equal(mnet["Inventory Stock"], 1200, "the rice only");
  assert.equal(mnet[serviceExpense], 500);
  assert.equal(totals(await live(m)).debit, totals(await live(m)).credit);
  assert.equal(await onHand(rice), ricePool.currentStock + 100);

  // a purchase return of the service credits the expense and still moves nothing
  const ret = await approve(await doc("purchase_return", vendor, "Vendor", [L(consulting, 1, 250, { returnOfLineId: m.items[1]._id })], { returnOf: { transactionId: m._id } }));
  const rnet = await byAccount(ret);
  assert.equal(rnet[serviceExpense], -250);
  assert.equal(rnet["Inventory Stock"], undefined);
  assert.equal((await movesOf(ret)).length, 0);

  // deleting the approved purchases reverses cleanly
  await svc.Tx.deleteTransaction(ret._id, "tester");
  await svc.Tx.deleteTransaction(m._id, "tester");
  await svc.Tx.deleteTransaction(t._id, "tester");
  assert.equal((await live(t)).length, 0);
  assert.equal(await svc.Movement.countDocuments({ stockId: consulting.itemId }), 0);
});

test("a company whose posting map predates service-expense is topped up on its first service purchase", { skip }, async () => {
  const company = (await svc.Settings.findOne({}).lean()).companyId;
  await svc.Settings.updateOne({ companyId: company, "accountConfiguration.configKey": "service-expense" }, { $set: { "accountConfiguration.$.targetAccount": null } });
  await assert.rejects(() => svc.Config.resolveAccount("service-expense"), { code: "ACCOUNT_NOT_CONFIGURED" });
  const t = await buyApproved([L(consulting, 1, 250)]);
  assert.equal(t.status, "APPROVED");
  const net = await byAccount(t);
  assert.equal(net[await nameOf(await accountId("service-expense"))], 250, "mapped again by the top-up, and used");
  await svc.Tx.deleteTransaction(t._id, "tester");
});

// ===================================== stock figures ignore services =====================================

test("stock reports, valuation, low stock and reorder ignore services; sales analysis counts their revenue", { skip }, async () => {
  const sale = await sellApproved([L(consulting, 5, 400), L(rice, 5, 20)]);
  const to = new Date().toISOString().slice(0, 10);
  const from = `${to.slice(0, 4)}-01-01`;

  const valuation = await svc.StockReports.valuation({ asOn: to, includeZero: true });
  assert.ok(valuation.rows.some((r) => r.itemName === "Rice"));
  assert.ok(!valuation.rows.some((r) => r.itemName === "Consulting" || r.itemName === "Design"), "a service is never a valuation row");
  assert.equal(valuation.reconciliation.reconciles, true, "stock still agrees with the Inventory account");
  const movement = await svc.StockReports.movement({ from, to, includeZero: true });
  assert.ok(!movement.rows.some((r) => r.itemName === "Consulting"));
  assert.ok(!(await svc.StockReports.lookups()).items.some((i) => i.name === "Consulting"), "the report item filter is stock only");
  await assert.rejects(() => svc.StockReports.itemLedger({ itemId: consulting._id }), { code: "SERVICE_HAS_NO_STOCK" });

  // a service with no reorder level (0 on hand, 0 level) must not appear as low stock - nor with a stray level written straight to it
  assert.ok(!(await svc.StockReports.reorder()).rows.some((r) => r.itemName === "Consulting"));
  await svc.Stock.updateOne({ _id: consulting._id }, { reorderLevel: 5 });
  assert.ok(!(await svc.StockReports.reorder()).rows.some((r) => r.itemName === "Consulting"), "the report is about stock, whatever the row says");
  await svc.Stock.updateOne({ _id: consulting._id }, { reorderLevel: 0 });
  assert.ok(!(await svc.StockService.getLowStockItems()).some((s) => s.itemName === "Consulting"));
  const stats = await svc.StockService.getStockStats();
  assert.equal(stats.serviceItems, 2);
  const lowGoods = (await svc.Stock.find({ itemType: { $ne: "service" } })).filter((s) => s.currentStock <= s.reorderLevel).length;
  assert.equal(stats.lowStockItems, lowGoods, "only goods count as low stock");
  assert.equal((await svc.StockService.getStockValuation())[0].totalItems, await svc.Stock.countDocuments({ itemType: { $ne: "service" }, status: "Active" }));
  assert.ok(!(await svc.StockReports.expiry({})).rows.some((r) => r.itemName === "Consulting"));
  assert.ok(!(await svc.StockReports.slowMoving({ days: 1 })).rows.some((r) => r.itemName === "Consulting"));

  const analysis = await svc.StockReports.salesAnalysis({ from, to, groupBy: "item" });
  const row = analysis.rows.find((r) => r.name === "Consulting");
  assert.ok(row, "service revenue is in sales analysis");
  assert.equal(row.itemType, "service");
  assert.equal(row.netRevenue, 2000);
  assert.equal(row.cogs, 0);
  assert.equal(row.grossProfit, 2000);
  assert.equal(analysis.rows.find((r) => r.name === "Rice").itemType, undefined);

  await svc.Tx.deleteTransaction(sale._id, "tester");
});

test("the dashboard's inventory counts leave services out", { skip }, async () => {
  const goods = await svc.Stock.countDocuments({ status: "Active", itemType: { $ne: "service" } });
  const all = await svc.Stock.countDocuments({ status: "Active" });
  assert.ok(all > goods, "there are services among the active items");
  const analytics = await svc.Dashboard.analytics({});
  assert.equal(analytics.performance.activeItems, goods, "active items are the goods");
  assert.ok(analytics.performance.itemsInStock <= goods);
  assert.equal((await svc.Dashboard.summary({})).ops.lowStock.total, goods, "and so is the low-stock denominator");
});

// ===================================== delivery notes and close short =====================================

test("a delivery note may list a service but it has no availability and nothing to pick; closing short keeps it", { skip }, async () => {
  const so = await sell([L(rice, 10, 20), L(consulting, 2, 400)]);
  const lineOf = (item) => so.items.find((i) => String(i.itemId) === String(item._id));

  const availability = await svc.D.availability([rice._id, consulting._id].map(String).join(","));
  assert.deepEqual(availability.map((a) => a.itemId), [String(rice._id)], "no availability row for the service");

  const note = await svc.D.create({ sourceTransactionId: so._id, items: [{ sourceLineId: lineOf(rice)._id, qty: 6 }, { sourceLineId: lineOf(consulting)._id, qty: 2 }] }, "t");
  assert.equal(note.items.length, 2, "the note lists the service line");
  assert.equal(note.items[1].itemType, "service");
  const pick = await svc.D.pickList(note._id);
  assert.deepEqual(pick.lines.map((l) => l.description), ["Rice"], "nothing to pick for a service");
  await svc.D.dispatch(note._id, { vehicleNo: "DXB 1" }, "t");
  await svc.D.deliver(note._id, { receivedBy: "Store keeper" }, "t");

  const preview = await svc.Close.preview(so._id);
  assert.deepEqual(preview.lines.map((l) => [l.description, l.short]), [["Rice", 4]], "only the goods fell short");
  const closed = await svc.Close.closeShort(so._id, { reason: "Customer took 6" }, "tester");
  assert.deepEqual(closed.items.map((i) => [i.description, i.qty]), [["Rice", 6], ["Consulting", 2]], "the service stays on the order, whole");
  const fresh = await sell([L(rice, 6, 20), L(consulting, 2, 400)]);
  assert.equal(closed.totalAmount, fresh.totalAmount);
  await svc.Tx.deleteTransaction(fresh._id, "tester");

  // a note that only lists services does not make an order deliverable
  const svcOnly = await sell([L(consulting, 1, 400)]);
  await assert.rejects(() => svc.Close.closeShort(svcOnly._id, { reason: "Not needed any more" }, "tester"), { code: "NOTHING_DELIVERED" });
});
