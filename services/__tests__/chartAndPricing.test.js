// Chart of accounts, tax codes, server-side pricing and attachments, against a throwaway database
// (random name, dropped afterwards). See accountingFoundation.test.js for the rationale.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
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
    AccountGroup: require("../../models/modules/financial/accountGroupModel"),
    ...require("../../models/modules/financial/financialModels"),
    Chart: require("../financial/chartOfAccountsService"),
    TaxCode: require("../financial/taxCodeService"),
    Attachments: require("../core/attachmentService"),
    Financial: require("../financial/financialService"),
    Tx: require("../orderPurchase/transactionService"),
    Stock: require("../../models/modules/stockModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
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

const flatten = (nodes) => nodes.flatMap((n) => [n, ...flatten(n.children)]);
const findGroup = (nodes, name) => flatten(nodes).find((n) => n.name === name);

test("chart: an account gets a minted code, its opening balance posts, balances roll up", { skip }, async () => {
  const bank = await svc.AccountGroup.findOne({ name: "Bank" });
  const acct = await svc.Chart.createAccount({
    accountName: "Emirates NBD Current", groupId: bank._id, openingBalance: 5000, openingSide: "debit",
    description: "Main current account",
  });
  assert.match(acct.accountCode, /^BANK\d{4}$/);
  assert.equal(acct.accountType, "asset");

  await assert.rejects(() => svc.Chart.createAccount({ accountName: "emirates nbd current", groupId: bank._id }), { code: "DUPLICATE_ACCOUNT" });
  await assert.rejects(
    () => svc.Chart.createAccount({ accountName: "No side", groupId: bank._id, openingBalance: 10 }),
    { code: "OPENING_SIDE_REQUIRED" }
  );
  await assert.rejects(() => svc.Chart.createAccount({ accountName: "Orphan" }), { code: "GROUP_REQUIRED" });

  // The opening balance is a real ledger entry: the account ledger and the Trial Balance see it.
  assert.equal((await svc.Chart.getLedger(acct._id, {})).closing, 5000);
  const tb = await svc.Financial.getTrialBalance(undefined, "2099-01-01");
  assert.equal(tb.summary.isBalanced, true);
  assert.equal(tb.trialBalance.find((r) => r.accountName === "Opening Balance Equity").balance, 5000);

  const chart = await svc.Chart.getChart();
  const assets = chart.categories.find((c) => c.category === "ASSET");
  assert.equal(findGroup(assets.groups, "Bank").accounts.find((a) => a.accountName === "Emirates NBD Current").balance, 5000);
  assert.ok(findGroup(assets.groups, "Current Assets").total >= 5000, "a parent rolls up its children");
});

test("chart: accounts with a balance or a posting-map role cannot be deactivated", { skip }, async () => {
  const bank = await svc.LedgerAccount.findOne({ accountName: "Emirates NBD Current" });
  await assert.rejects(() => svc.Chart.updateAccount(bank._id, { isActive: false }), { code: "ACCOUNT_HAS_BALANCE" });
  const mapped = await svc.LedgerAccount.findOne({ accountName: "Output VAT" });
  await assert.rejects(() => svc.Chart.updateAccount(mapped._id, { isActive: false }), { code: "ACCOUNT_IN_USE_BY_CONFIGURATION" });

  // An unused account can change category; one with postings cannot.
  const exp = await svc.AccountGroup.findOne({ name: "Operating Expenses" });
  const income = await svc.AccountGroup.findOne({ name: "Sales Income" });
  const rent = await svc.Chart.createAccount({ accountName: "Rent", groupId: exp._id });
  const moved = await svc.Chart.updateAccount(rent._id, { groupId: income._id });
  assert.equal(moved.accountType, "income");
  await assert.rejects(() => svc.Chart.updateAccount(bank._id, { groupId: income._id }), { code: "CATEGORY_LOCKED" });
});

test("tax codes: the rate in force on the document date applies and is snapshotted on the line", { skip }, async () => {
  await svc.TaxCode.create({ name: "Phased", kind: "standard", ratePercent: 5, rateHistory: [{ date: new Date("2027-01-01"), ratePercent: 6 }] });
  const code = (await svc.TaxCode.list()).find((c) => c.name === "Phased");
  assert.equal(svc.TaxCode.rateOn(code, new Date("2026-06-01")), 5);
  assert.equal(svc.TaxCode.rateOn(code, new Date("2027-03-01")), 6);

  const [line] = await svc.TaxCode.applyToItems([{ description: "x", taxCodeId: code._id, vatPercent: 99 }], new Date("2027-03-01"));
  assert.equal(line.vatPercent, 6); // the code wins over what the client sent
  assert.equal(line.taxKind, "standard");
  await assert.rejects(
    () => svc.TaxCode.applyToItems([{ description: "x", taxCodeId: new mongoose.Types.ObjectId() }], new Date()),
    { code: "INVALID_TAX_CODE" }
  );
});

test("pricing: discount, freight and header discount are computed on the server and posted separately", { skip }, async () => {
  const vendor = await svc.Vendor.create({ vendorId: "V3", vendorName: "Vend3", contactPerson: "x", address: "y" });
  const customer = await svc.Customer.create({ customerId: "C3", customerName: "Cust3", contactPerson: "x" });
  const stock = await svc.Stock.create({ itemId: "ITM3", sku: "SKU3", itemName: "Oil", category: new mongoose.Types.ObjectId() });
  const buy = await svc.Tx.createTransaction(
    { type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor",
      items: [{ itemId: stock._id, description: "Oil", qty: 100, price: 10, rate: 10, vatPercent: 5 }], totalAmount: 1050 },
    "tester"
  );
  await svc.Tx.processTransaction(buy._id, "approve", "tester");

  // 10 x 100, 10% line discount, 5% VAT, 40 freight (+5% VAT), 15 off the total. The client's
  // total (0) is wrong and must be ignored.
  const sale = await svc.Tx.createTransaction(
    { type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer",
      items: [{ itemId: stock._id, description: "Oil", qty: 10, price: 100, rate: 100, vatPercent: 5, discountPercent: 10 }],
      charges: [{ code: "FRT", description: "Freight", amount: 40, vatPercent: 5 }],
      discount: 15, totalAmount: 0 },
    "tester"
  );
  assert.equal(sale.totalAmount, 972);
  assert.equal(sale.pricing.net, 900);
  assert.equal(sale.items[0].discountAmount, 100);
  assert.equal(sale.items[0].lineTotal, 945);
  await svc.Tx.processTransaction(sale._id, "approve", "tester");

  const tb = await svc.Financial.getTrialBalance(undefined, "2099-01-01");
  assert.equal(tb.summary.isBalanced, true);
  const bal = (n) => tb.trialBalance.find((r) => r.accountName === n)?.balance;
  assert.equal(bal("Customer - Cust3"), 972);
  assert.equal(bal("Sales Discounts Given"), 115); // 100 line + 15 header
  assert.equal(bal("Freight Recovered"), 40);
  assert.equal(bal("Output VAT"), 47); // 45 on the lines + 2 on the freight
});

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF");

test("attachments: store, link, list, refuse a disguised executable, remove", { skip }, async () => {
  const a = await svc.Attachments.save({ originalname: "../../evil name.pdf", buffer: PDF, size: PDF.length }, { uploadedBy: "tester" });
  assert.equal(a.originalName, "evil name.pdf", "path segments are stripped from the name");
  assert.ok(!a.key.includes(".."));

  const acct = await svc.LedgerAccount.findOne({ accountName: "Emirates NBD Current" });
  await svc.Attachments.link(a._id, { ownerType: "account", ownerId: acct._id, label: "Bank letter" });
  const reloaded = await svc.LedgerAccount.findById(acct._id).lean();
  assert.equal(reloaded.documents.length, 1);
  assert.equal(reloaded.documents[0].label, "Bank letter");
  assert.equal((await svc.Attachments.listFor("account", acct._id)).length, 1);
  await assert.rejects(() => svc.Attachments.link(a._id, { ownerType: "account", ownerId: acct._id }), { code: "ALREADY_LINKED" });

  const exe = Buffer.from("MZ\x90\x00 not a pdf");
  await assert.rejects(() => svc.Attachments.save({ originalname: "invoice.pdf", buffer: exe, size: exe.length }), { code: "FILE_CONTENT_MISMATCH" });
  await assert.rejects(() => svc.Attachments.save({ originalname: "run.exe", buffer: exe, size: exe.length }), { code: "FILE_TYPE_NOT_ALLOWED" });
  const big = Buffer.alloc(11 * 1024 * 1024, 1);
  await assert.rejects(() => svc.Attachments.save({ originalname: "big.pdf", buffer: big, size: big.length }), { code: "FILE_TOO_LARGE" });

  const file = svc.Attachments.filePath(a);
  assert.ok(fs.existsSync(file));
  await svc.Attachments.remove(a._id);
  assert.ok(!fs.existsSync(file), "the file is deleted from disk");
  assert.equal((await svc.LedgerAccount.findById(acct._id).lean()).documents.length, 0);
});

test("attachments can be attached to an order and a voucher too", { skip }, async () => {
  const tx = await svc.Tx.createTransaction(
    { type: "purchase_order", partyId: (await svc.Vendor.findOne({ vendorId: "V3" }))._id, partyType: "Vendor", partyTypeRef: "Vendor",
      items: [{ itemId: (await svc.Stock.findOne({ itemId: "ITM3" }))._id, description: "Oil", qty: 1, price: 1, rate: 1, vatPercent: 0 }] },
    "tester"
  );
  const a = await svc.Attachments.save({ originalname: "supplier-invoice.pdf", buffer: PDF, size: PDF.length });
  await svc.Attachments.link(a._id, { ownerType: "transaction", ownerId: tx._id });
  const reloaded = await require("../../models/modules/transactionModel").findById(tx._id).lean();
  assert.equal(reloaded.attachments.length, 1);
  assert.equal(reloaded.attachments[0].fileName, "supplier-invoice.pdf");
  await svc.Attachments.remove(a._id);
});

test("profit and loss and the balance sheet agree with the trial balance", { skip }, async () => {
  const today = new Date().toISOString().slice(0, 10);
  const pl = await svc.Financial.getProfitAndLoss(undefined, "2099-12-31");
  // Earlier tests booked: sales revenue 1000 less discounts 115 plus freight 40 recovered ...
  assert.ok(pl.totalIncome > 0 && pl.income.some((a) => a.accountName === "Sales Revenue"));
  assert.equal(pl.netProfit, Math.round((pl.totalIncome - pl.totalExpenses) * 100) / 100);

  const bs = await svc.Financial.getBalanceSheet("2099-12-31");
  assert.equal(bs.isBalanced, true, `assets ${bs.totalAssets} vs liabilities+equity ${bs.totalLiabilitiesAndEquity}`);
  assert.equal(bs.profitToDate, pl.netProfit, "profit shown in equity equals the P&L");
  assert.ok(bs.assets.some((a) => a.accountName === "Emirates NBD Current"));
  void today;

  // a period before anything happened is empty, not an error
  const empty = await svc.Financial.getProfitAndLoss("1999-01-01", "1999-12-31");
  assert.equal(empty.netProfit, 0);
});

test("a saved document can be read back exactly as stored (edit relies on it)", { skip }, async () => {
  const vendor = await svc.Vendor.findOne({ vendorId: "V3" });
  const stock = await svc.Stock.findOne({ itemId: "ITM3" });
  const t = await svc.Tx.createTransaction(
    { type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor",
      items: [{ itemId: stock._id, description: "Oil", qty: 3, price: 10, rate: 10, vatPercent: 5, discountPercent: 10, batchNumber: "LOT-9", expiryDate: "2027-01-31" }],
      charges: [{ description: "Freight", amount: 12, vatPercent: 5 }] },
    "tester"
  );
  const back = await svc.Tx.getTransactionById(t._id);
  assert.equal(back.items[0].discountPercent, 10);
  assert.equal(back.items[0].batchNumber, "LOT-9");
  assert.equal(new Date(back.items[0].expiryDate).toISOString().slice(0, 10), "2027-01-31");
  assert.equal(back.items[0].price, 10);
  assert.equal(back.charges[0].amount, 12);
  await assert.rejects(() => svc.Tx.getTransactionById("nope"), { statusCode: 400 });
  await assert.rejects(() => svc.Tx.getTransactionById(new mongoose.Types.ObjectId()), { statusCode: 404 });
});
