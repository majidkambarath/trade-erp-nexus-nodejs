// Customers and vendors get ledger accounts in the chart as soon as they exist, and every approved
// document reaches the ledger: when posting is switched on after documents were approved, they are
// caught up. Runs against a throwaway database (see accountingFoundation.test.js).
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
let stock;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Tx: require("../orderPurchase/transactionService"),
    Chart: require("../financial/chartOfAccountsService"),
    Customers: require("../customer/customerService"),
    Vendors: require("../vendor/vendorService"),
    DefaultChart: require("../financial/defaultChartService"),
    Posting: require("../financial/postingService"),
    Statement: require("../financial/statementService"),
    PartyAccounts: require("../financial/partyAccounts"),
    CompanySettings: require("../../models/modules/financial/companySettingsModel"),
    AccountGroup: require("../../models/modules/financial/accountGroupModel"),
    ...require("../../models/modules/financial/financialModels"),
    Stock: require("../../models/modules/stockModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  stock = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: new mongoose.Types.ObjectId() });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const accountOf = (name) => svc.LedgerAccount.findOne({ accountName: name });
const groupName = async (acc) => (await svc.AccountGroup.findById(acc.groupId))?.name;
const line = (qty, price, extra = {}) => ({ itemId: stock._id, description: "Rice", qty, price, rate: price, vatPercent: 5, ...extra });

test("a new customer and a new vendor each get their account, filed under Receivable / Payable", { skip }, async () => {
  const customer = await svc.Customers.createCustomer({ customerName: "Al Noor Mart", contactPerson: "Sara", paymentTerms: "Net 30" });
  assert.ok(customer && customer._id, "createCustomer returns the customer it created");
  const vendor = await svc.Vendors.createVendor({ vendorName: "Gulf Mills", contactPerson: "Omar", address: "Jebel Ali", paymentTerms: "Net 30" });
  assert.ok(vendor && vendor._id, "createVendor returns the vendor it created");

  const c = await accountOf("Customer - Al Noor Mart");
  assert.ok(c, "the customer's receivable account exists straight away");
  assert.equal(await groupName(c), "Accounts Receivable");
  assert.match(c.accountCode, /^AR\d{4}$/);
  assert.equal(c.accountType, "asset");

  const v = await accountOf("Vendor - Gulf Mills");
  assert.ok(v);
  assert.equal(await groupName(v), "Accounts Payable");
  assert.match(v.accountCode, /^AP\d{4}$/);
  assert.equal(v.accountType, "liability");
});

test("renaming a party renames its account; deleting one with no postings retires it", { skip }, async () => {
  const customer = await svc.Customers.createCustomer({ customerName: "Old Name Trading", contactPerson: "x" });
  await svc.Customers.updateCustomer(customer._id, { customerName: "New Name Trading" });
  assert.equal(await accountOf("Customer - Old Name Trading"), null);
  assert.ok(await accountOf("Customer - New Name Trading"));

  await svc.Customers.deleteCustomer(customer._id);
  assert.equal((await accountOf("Customer - New Name Trading")).isActive, false);
});

test("a party whose account has postings keeps it when the party is deleted", { skip }, async () => {
  const customer = await svc.Customers.createCustomer({ customerName: "Has History", contactPerson: "x" });
  await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [line(1, 100)] }, "tester")
    .then((t) => svc.Tx.processTransaction(t._id, "approve", "tester"))
    .catch(() => null); // no stock in this test; the sale may be refused, in which case there is nothing to keep
  const acc = await accountOf("Customer - Has History");
  const posted = await svc.LedgerEntry.exists({ accountId: acc._id });
  await svc.Customers.deleteCustomer(customer._id);
  assert.equal((await accountOf("Customer - Has History")).isActive, Boolean(posted), "an account with history stays active; one without is retired");
});

test("customers created outside the service get their account when the chart is opened", { skip }, async () => {
  await svc.Customer.create({ customerId: "RAW1", customerName: "Imported Customer", contactPerson: "x" });
  await svc.Vendor.create({ vendorId: "RAWV1", vendorName: "Imported Vendor", contactPerson: "x", address: "y" });
  assert.equal(await accountOf("Customer - Imported Customer"), null);
  const r = await svc.DefaultChart.onOpen({});
  assert.ok(r.partyAccounts >= 2);
  assert.ok(await accountOf("Customer - Imported Customer"));
  assert.ok(await accountOf("Vendor - Imported Vendor"));
  assert.equal((await svc.DefaultChart.onOpen({})).partyAccounts, 0, "opening it again creates nothing");
});

test("documents approved while posting was off are posted when it is switched on, once", { skip }, async () => {
  await svc.Config.setPostingEnabled(false);
  const vendor = await svc.Vendor.create({ vendorId: "V9", vendorName: "Catch Up Vendor", contactPerson: "x", address: "y" });
  const customer = await svc.Customer.create({ customerId: "C9", customerName: "Catch Up Customer", contactPerson: "x", creditLimit: 100000 });
  const buy = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [line(100, 10)] }, "tester");
  await svc.Tx.processTransaction(buy._id, "approve", "tester");
  const sell = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [line(10, 20)] }, "tester");
  await svc.Tx.processTransaction(sell._id, "approve", "tester");

  assert.equal(await svc.LedgerEntry.countDocuments({ voucherId: { $in: [buy._id, sell._id] } }), 0, "nothing was posted while posting was off");
  const before = await svc.Statement.getStatement({ partyId: customer._id, partyType: "Customer" });
  assert.equal(before.source, "documents");
  assert.equal(before.closing, 210);

  await svc.Config.setPostingEnabled(true);
  const first = await svc.Posting.catchUp();
  assert.ok(first.posted >= 2, JSON.stringify(first));
  assert.deepEqual(first.failed, []);

  // purchase: Dr inventory + input VAT / Cr vendor; sale: Dr customer / Cr revenue + output VAT, and cost of goods
  const vendorAcc = await accountOf("Vendor - Catch Up Vendor");
  const customerAcc = await accountOf("Customer - Catch Up Customer");
  const sum = async (id, side) => (await svc.LedgerEntry.aggregate([{ $match: { accountId: id } }, { $group: { _id: null, t: { $sum: `$${side}` } } }]))[0]?.t || 0;
  assert.equal(await sum(vendorAcc._id, "creditAmount"), 1050);
  assert.equal(await sum(customerAcc._id, "debitAmount"), 210);
  const tb = await svc.LedgerEntry.aggregate([{ $group: { _id: null, d: { $sum: "$debitAmount" }, c: { $sum: "$creditAmount" } } }]);
  assert.equal(Math.round((tb[0].d - tb[0].c) * 100), 0, "the books balance");

  const after = await svc.Statement.getStatement({ partyId: customer._id, partyType: "Customer" });
  assert.equal(after.source, "ledger");
  assert.equal(after.closing, before.closing, "the statement reads the same from the ledger");

  const second = await svc.Posting.catchUp();
  assert.equal(second.posted, 0, "running it again posts nothing twice");
});

test("a company that has never chosen is switched on automatically; a chosen 'off' is respected", { skip }, async () => {
  await svc.CompanySettings.updateMany({}, { ledgerPostingEnabled: false, ledgerPostingTouched: false });
  const r = await svc.DefaultChart.onOpen({});
  assert.equal(r.postingEnabled, true);
  assert.equal(await svc.Config.isPostingEnabled(), true);

  await svc.Config.setPostingEnabled(false); // a person's choice
  const again = await svc.DefaultChart.onOpen({});
  assert.equal(again.postingEnabled, false);
  assert.equal(await svc.Config.isPostingEnabled(), false);
});

test("the account pickers get a flat list of postable accounts with their group trail, party accounts included", { skip }, async () => {
  await svc.Customers.createCustomer({ customerName: "Picker Customer", contactPerson: "x" });
  const list = await svc.Chart.listPostable({});
  const acc = list.find((a) => a.accountName === "Customer - Picker Customer");
  assert.ok(acc, "customer accounts are offered");
  assert.equal(acc.category, "ASSET");
  assert.equal(acc.groupName, "Accounts Receivable");
  assert.equal(acc.path, "Current Assets › Accounts Receivable");
  assert.ok(list.some((a) => a.accountName === "Rent Expense" && a.category === "EXPENSE"));
  // an account that cannot take postings, or is switched off, is not offered
  await svc.LedgerAccount.updateOne({ accountName: "Petty Cash" }, { allowDirectPosting: false });
  await svc.LedgerAccount.updateOne({ accountName: "Vehicles" }, { isActive: false });
  const after = await svc.Chart.listPostable({});
  assert.ok(!after.some((a) => a.accountName === "Petty Cash" || a.accountName === "Vehicles"));
});

test("requests that arrive together wait for the same readiness run, so none reads before posting is on", { skip }, async () => {
  await svc.CompanySettings.updateMany({}, { ledgerPostingEnabled: false, ledgerPostingTouched: false });
  svc.DefaultChart._lastOpen = 0;
  svc.DefaultChart._opening = null;
  const [first, second] = await Promise.all([svc.DefaultChart.onOpenThrottled({}), svc.DefaultChart.onOpenThrottled({})]);
  assert.strictEqual(first, second, "the second caller received the first run's result");
  assert.equal(first.postingEnabled, true);
  assert.equal(await svc.Config.isPostingEnabled(), true, "posting was already on when the second caller was released");
  assert.equal(await svc.DefaultChart.onOpenThrottled({}), null, "after that it is throttled for a minute");
});

test("an opening balance entered while posting was off reaches the ledger once posting is on, exactly once", { skip }, async () => {
  const group = await svc.AccountGroup.findOne({ name: "Bank" });
  await svc.CompanySettings.updateMany({}, { ledgerPostingEnabled: false, ledgerPostingTouched: true });
  const acc = await svc.Chart.createAccount({ accountName: "Late Bank", groupId: group._id, openingBalance: 5000, openingSide: "debit" }, {}, null);
  assert.equal(await svc.LedgerEntry.countDocuments({ voucherType: "opening", voucherId: acc._id }), 0, "while posting is off it is only stored");
  assert.equal((await svc.LedgerAccount.findById(acc._id)).currentBalance, 5000);

  await svc.CompanySettings.updateMany({}, { ledgerPostingEnabled: true });
  const first = await svc.Posting.catchUp({});
  assert.equal(first.openingsPosted, 1);
  assert.equal(await svc.LedgerEntry.countDocuments({ voucherType: "opening", voucherId: acc._id }), 2, "the account leg and the Opening Balance Equity leg");
  const after = await svc.LedgerAccount.findById(acc._id);
  assert.equal(after.currentBalance, 5000, "the stored figure is replaced by the entry, not added to it");
  const bal = (await svc.Chart.balances()).get(String(acc._id));
  assert.equal(bal.debit - bal.credit, 5000);

  const again = await svc.Posting.catchUp({});
  assert.equal(again.openingsPosted, 0, "running it again posts nothing more");
  assert.equal(await svc.LedgerEntry.countDocuments({ voucherType: "opening", voucherId: acc._id }), 2);
});

test("a run before the company has a chart does not hold off the first real open", { skip }, async () => {
  await svc.CompanySettings.deleteMany({});
  svc.DefaultChart._lastOpen = 0;
  svc.DefaultChart._opening = null;
  const early = await svc.DefaultChart.onOpenThrottled({});
  assert.equal(early.settled, false, "no settings yet: nothing decided");
  assert.equal(svc.DefaultChart._lastOpen, 0, "so no minute has started");
  await svc.seed({ log: () => {} });
  await svc.CompanySettings.updateMany({}, { ledgerPostingEnabled: false, ledgerPostingTouched: false });
  const real = await svc.DefaultChart.onOpenThrottled({});
  assert.ok(real, "the next open is not throttled");
  assert.equal(real.postingEnabled, true);
});
