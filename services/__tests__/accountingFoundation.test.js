// Integration tests for the accounting foundation. They run against a THROWAWAY database on
// the cluster in MONGO_URI (random name, dropped afterwards); the real "ERP" database is never
// touched. Transactions need a replica set, which Atlas provides.
//
//   npm test
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
    NumberSeries: require("../core/numberSeriesService"),
    FiscalYear: require("../core/fiscalYearService"),
    Groups: require("../financial/accountGroupService"),
    Config: require("../financial/accountConfigService"),
    Financial: require("../financial/financialService"),
    Tx: require("../orderPurchase/transactionService"),
    AccountGroup: require("../../models/modules/financial/accountGroupModel"),
    FiscalYearModel: require("../../models/modules/financial/fiscalYearModel"),
    ...require("../../models/modules/financial/financialModels"),
    Stock: require("../../models/modules/stockModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
  };
  // Make sure every collection and index exists before concurrent tests start (an upsert race
  // against a not-yet-built unique index would otherwise be a test artefact, not a bug).
  await mongoose.connection.syncIndexes();
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("seed is idempotent and leaves every posting key mapped", { skip }, async () => {
  const first = await svc.seed({ log: () => {} });
  assert.equal(first.missing.length, 0, `unmapped: ${first.missing.map((m) => m.configKey)}`);
  const groupsBefore = await svc.AccountGroup.countDocuments();
  const accountsBefore = await svc.LedgerAccount.countDocuments();
  await svc.seed({ log: () => {} });
  assert.equal(await svc.AccountGroup.countDocuments(), groupsBefore);
  assert.equal(await svc.LedgerAccount.countDocuments(), accountsBefore);
});

test("number allocation: 60 concurrent callers get 60 distinct, gap-free numbers", { skip }, async () => {
  const date = new Date();
  const nums = await Promise.all(Array.from({ length: 60 }, () => svc.NumberSeries.allocate("SO", date)));
  assert.equal(new Set(nums).size, 60);
  const seq = nums.map((n) => Number(n.split("-").pop())).sort((a, b) => a - b);
  assert.deepEqual(seq, Array.from({ length: 60 }, (_, i) => i + 1));
  assert.match(nums[0], /^SO-\d{4}-\d{4}$/);
});

test("account codes: concurrent mints are distinct and floored above manual codes", { skip }, async () => {
  const ar = await svc.AccountGroup.findOne({ prefix: "AR" });
  const codes = await Promise.all(Array.from({ length: 20 }, () => svc.Groups.generateNextAccountCode(ar._id)));
  assert.equal(new Set(codes).size, 20);
  assert.ok(codes.every((c) => /^AR\d{4}$/.test(c)));

  // A code created outside the mint path (import / manual edit) must not be re-issued.
  await svc.LedgerAccount.create({
    accountName: "Manual AR",
    accountCode: "AR0100",
    accountType: "asset",
    subType: "current_asset",
    groupId: ar._id,
    createdBy: new mongoose.Types.ObjectId(),
  });
  assert.equal(await svc.Groups.generateNextAccountCode(ar._id), "AR0101");
});

test("group tree: a group cannot move under its own descendant", { skip }, async () => {
  const ca = await svc.AccountGroup.findOne({ name: "Current Assets" });
  const cash = await svc.AccountGroup.findOne({ name: "Cash" });
  await assert.rejects(() => svc.Groups.update(ca._id, { parentGroup: cash._id }), { code: "CIRCULAR_PARENT" });
});

test("posting map: unmapped fails loudly, mapped resolves, wrong category is refused", { skip }, async () => {
  const cfg = await svc.Config.getConfiguration();
  const vat = cfg.accountConfiguration.find((c) => c.configKey === "vat-sales");
  assert.ok(vat.targetAccount, "vat-sales should be mapped by the seed");
  assert.equal(String(await svc.Config.resolveAccount("vat-sales")), String(vat.targetAccount._id));

  await svc.Config.updateMappings([{ configKey: "vat-sales", targetAccount: null }]);
  await assert.rejects(() => svc.Config.resolveAccount("vat-sales"), { code: "ACCOUNT_NOT_CONFIGURED" });

  // vat-sales needs a LIABILITY account; an income account must be refused.
  const income = await svc.LedgerAccount.findOne({ accountType: "income" });
  await assert.rejects(
    () => svc.Config.updateMappings([{ configKey: "vat-sales", targetAccount: income._id }]),
    { code: "CATEGORY_MISMATCH" }
  );
  const liability = await svc.LedgerAccount.findOne({ accountName: "Output VAT" });
  await svc.Config.updateMappings([{ configKey: "vat-sales", targetAccount: liability._id }]);
  assert.equal(String(await svc.Config.resolveAccount("vat-sales")), String(liability._id));
});

test("fiscal year: closed and uncovered dates are rejected, open dates pass", { skip }, async () => {
  const fy = await svc.FiscalYearModel.findOne();
  const inside = new Date((fy.startDate.getTime() + fy.endDate.getTime()) / 2);
  await svc.FiscalYear.assertPostingAllowed(inside);

  await assert.rejects(() => svc.FiscalYear.assertPostingAllowed(new Date("1999-06-01")), { code: "NO_FISCAL_YEAR" });
  await svc.FiscalYear.setStatus(fy._id, "closed");
  await assert.rejects(() => svc.FiscalYear.assertPostingAllowed(inside), { code: "PERIOD_CLOSED" });
  await svc.FiscalYear.setStatus(fy._id, "open");
  await svc.FiscalYear.assertPostingAllowed(inside);

  await assert.rejects(
    () => svc.FiscalYear.create({ code: "OVERLAP", startDate: inside, endDate: fy.endDate }),
    { code: "DATE_OVERLAP" }
  );
});

test("trial balance: balances, reads liabilities and income as positive, honours dates", { skip }, async () => {
  const ar = await svc.LedgerAccount.findOne({ accountName: "Output VAT" }); // liability
  const bank = await svc.LedgerAccount.create({
    accountName: "Test Bank", accountCode: "TB-BANK", accountType: "asset", subType: "current_asset",
    createdBy: new mongoose.Types.ObjectId(),
  });
  const sales = await svc.LedgerAccount.create({
    accountName: "Test Sales", accountCode: "TB-SALES", accountType: "income", subType: "sales",
    createdBy: new mongoose.Types.ObjectId(),
  });
  const by = new mongoose.Types.ObjectId();
  const mk = (account, date, debit, credit) => ({
    voucherId: new mongoose.Types.ObjectId(), voucherNo: "T", voucherType: "receipt",
    accountId: account._id, accountName: account.accountName, accountCode: account.accountCode,
    date: new Date(date), debitAmount: debit, creditAmount: credit, createdBy: by,
  });
  await svc.LedgerEntry.insertMany([
    mk(bank, "2026-03-10", 105, 0), mk(sales, "2026-03-10", 0, 100), mk(ar, "2026-03-10", 0, 5),
    mk(bank, "2026-04-10", 50, 0), mk(sales, "2026-04-10", 0, 50),
  ]);

  const all = await svc.Financial.getTrialBalance(undefined, "2026-12-31");
  assert.equal(all.summary.isBalanced, true);
  const row = (name) => all.trialBalance.find((r) => r.accountName === name);
  assert.equal(row("Test Sales").balance, 150); // income: credit - debit, positive
  assert.equal(row("Output VAT").balance, 5); // liability: positive
  assert.equal(row("Test Bank").balance, 155); // asset: debit - credit

  // April only: March becomes the opening balance.
  const april = await svc.Financial.getTrialBalance("2026-04-01", "2026-12-31");
  const a = april.trialBalance.find((r) => r.accountName === "Test Sales");
  assert.equal(a.openingBalance, 100);
  assert.equal(a.totalCredits, 50);
  assert.equal(a.balance, 150);
  assert.equal(april.summary.isBalanced, true);
});

test("costing end to end: average, COGS, reversal", { skip }, async () => {
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Vend", contactPerson: "x", address: "y" });
  const customer = await svc.Customer.create({ customerId: "C1", customerName: "Cust", contactPerson: "x" });
  const stock = await svc.Stock.create({
    itemId: "ITM1", sku: "SKU1", itemName: "Rice", category: new mongoose.Types.ObjectId(),
  });

  const line = (qty, price, vat = 5) => ({
    itemId: stock._id, description: "Rice", qty, price, rate: price, vatPercent: vat,
  });
  const make = async (type, party, partyType, qty, price) => {
    const t = await svc.Tx.createTransaction(
      { type, partyId: party._id, partyType, partyTypeRef: partyType, items: [line(qty, price)], totalAmount: qty * price * 1.05, date: new Date() },
      "tester"
    );
    await svc.Tx.processTransaction(t._id, "approve", "tester");
    return t;
  };
  // createTransaction looks the stock up by item id
  const po1 = await make("purchase_order", vendor, "Vendor", 100, 10);
  const po2 = await make("purchase_order", vendor, "Vendor", 50, 12);

  let s = await svc.Stock.findById(stock._id);
  assert.equal(s.currentStock, 150);
  assert.equal(s.costValue, 1600); // VAT-exclusive: 1000 + 600
  assert.equal(s.purchasePrice, 10.66667); // the old code produced 6.75

  assert.match(po1.transactionNo, /^PO-\d{4}-0001$/);
  assert.match(po2.transactionNo, /^PO-\d{4}-0002$/);

  // Ledger after two purchases: stock at cost, input VAT, vendor owed the VAT-inclusive total.
  let tb = await svc.Financial.getTrialBalance(undefined, "2099-01-01");
  const bal = (name) => tb.trialBalance.find((r) => r.accountName === name)?.balance ?? 0;
  assert.equal(tb.summary.isBalanced, true);
  assert.equal(bal("Inventory Stock"), 1600);
  assert.equal(bal("Input VAT"), 80); // 50 + 30
  assert.equal(bal("Vendor - Vend"), 1680); // owed, a liability read positive

  const so = await make("sales_order", customer, "Customer", 40, 25);
  s = await svc.Stock.findById(stock._id);
  assert.equal(s.currentStock, 110);
  assert.equal(s.purchasePrice, 10.66667, "a sale must not change the average");
  assert.equal((await svc.Customer.findById(customer._id)).cashBalance, -1050); // 40 x 25 + 5% VAT
  tb = await svc.Financial.getTrialBalance(undefined, "2099-01-01");
  assert.equal(tb.summary.isBalanced, true);
  assert.equal(bal("Customer - Cust"), 1050); // receivable
  assert.equal(bal("Sales Revenue"), 1000);
  assert.equal(bal("Output VAT"), 50 + 5); // earlier test left 5 on this account
  assert.equal(bal("Cost of Goods Sold"), 426.67);
  assert.equal(bal("Inventory Stock"), 1600 - 426.67);
  const mv = await svc.Movement.findOne({ referenceId: so._id, isReversed: false });
  assert.equal(mv.costBasis, "sale");
  assert.equal(mv.cogsAmount, 426.67); // 40 x 10.66667, not 40 x 25
  assert.equal(mv.rateBefore, 10.66667);

  // Deleting an approved sale (the only reversal path: approved documents cannot be cancelled)
  // puts stock and cost back.
  await svc.Tx.deleteTransaction(so._id, "tester");
  s = await svc.Stock.findById(stock._id);
  assert.equal(s.currentStock, 150);
  assert.equal(s.costValue, 1600);
  assert.equal(s.purchasePrice, 10.66667);

  // The ledger returns too: revenue, receivable and cost of goods are back to nothing.
  tb = await svc.Financial.getTrialBalance(undefined, "2099-01-01");
  assert.equal(tb.summary.isBalanced, true);
  assert.equal(bal("Sales Revenue"), 0);
  assert.equal(bal("Customer - Cust"), 0);
  assert.equal(bal("Cost of Goods Sold"), 0);
  assert.equal(bal("Inventory Stock"), 1600);

  // The customer's balance returns to where it started (the sales-side sign used to be wrong).
  const c = await svc.Customer.findById(customer._id);
  assert.equal(c.cashBalance, 0);
});

test("back-dated purchase re-costs a later sale in the stock ledger and the general ledger", { skip }, async () => {
  const vendor = await svc.Vendor.create({ vendorId: "V2", vendorName: "Vend2", contactPerson: "x", address: "y" });
  const customer = await svc.Customer.create({ customerId: "C2", customerName: "Cust2", contactPerson: "x" });
  const stock = await svc.Stock.create({ itemId: "ITM2", sku: "SKU2", itemName: "Flour", category: new mongoose.Types.ObjectId() });
  const day = (d) => new Date(`2026-10-${d}T08:00:00Z`);
  const make = async (type, party, partyType, qty, price, date) => {
    const t = await svc.Tx.createTransaction(
      { type, partyId: party._id, partyType, partyTypeRef: partyType,
        items: [{ itemId: stock._id, description: "Flour", qty, price, rate: price, vatPercent: 0 }],
        totalAmount: qty * price, date },
      "tester"
    );
    await svc.Tx.processTransaction(t._id, "approve", "tester");
    return t;
  };

  await make("purchase_order", vendor, "Vendor", 100, 10, day("01"));
  const so = await make("sales_order", customer, "Customer", 40, 25, day("10"));
  let mv = await svc.Movement.findOne({ referenceId: so._id, isReversed: false });
  assert.equal(mv.cogsAmount, 400); // 40 x 10

  // A purchase for 5 October is entered AFTER the sale of the 10th.
  await make("purchase_order", vendor, "Vendor", 50, 16, day("05"));

  mv = await svc.Movement.findOne({ referenceId: so._id, isReversed: false });
  assert.equal(mv.totalValue, 480); // 40 x 12: average of 100@10 + 50@16 at that date
  assert.equal(mv.rateBefore, 12);

  const s = await svc.Stock.findById(stock._id);
  assert.equal(s.currentStock, 110);
  assert.equal(s.costValue, 1320); // 1800 - 480
  assert.equal(s.purchasePrice, 12);

  // The general ledger followed: cost of goods and inventory moved by the same 80.
  const tb = await svc.Financial.getTrialBalance(undefined, "2099-01-01");
  assert.equal(tb.summary.isBalanced, true);
  const row = (n) => tb.trialBalance.find((r) => r.accountName === n)?.balance ?? 0;
  assert.equal(row("Cost of Goods Sold"), 480);
  assert.equal(row("Inventory Stock"), 1320 + 1600); // + the earlier test's remaining stock value
});
