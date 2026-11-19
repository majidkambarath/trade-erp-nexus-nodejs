// Cost centres: the master, the tag on documents and vouchers, every ledger row carrying the one that applies, and the reports.
//   node --require ./utils/testSetup.js --test services/__tests__/costCentres.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_cc_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
let svc, rice, customer, vendor, A, B, OFF, admin;

const line = (qty, price, extra = {}) => ({ itemId: rice._id, description: rice.itemName, qty, price, rate: price, vatPercent: 5, ...extra });
const round2 = (n) => Math.round(n * 100) / 100;
const acct = (name) => svc.LedgerAccount.findOne({ accountName: name }).lean();
const rowsOf = (id) => svc.LedgerEntry.find({ voucherId: id, isReversed: { $ne: true } }).lean();
const req = () => ({ admin: { id: String(admin) } });

test.before(async () => {
  if (skip) return;
  process.env.LOG_SILENT = "1";
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Tx: require("../orderPurchase/transactionService"),
    Financial: require("../financial/financialService"),
    CC: require("../financial/costCentreService"),
    Reports: require("../reports/ledgerReportsService"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    ...require("../../models/modules/financial/financialModels"),
  };
  require("../../models/modules/uomModel");
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  admin = new mongoose.Types.ObjectId();
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", creditLimit: 1e6 });
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mills", contactPerson: "x", address: "y" });
  rice = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: new mongoose.Types.ObjectId(), purchasePrice: 10 });
  const buy = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [line(100, 10)] }, "t");
  await svc.Tx.processTransaction(buy._id, "approve", "t");
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("the master: codes upper-cased, unique code and name, one level of grouping", { skip }, async () => {
  A = await svc.CC.create({ code: "shop1", name: "Deira shop" }, req());
  B = await svc.CC.create({ code: "SHOP2", name: "Karama shop" }, req());
  OFF = await svc.CC.create({ code: "OLD", name: "Closed branch", isActive: false }, req());
  assert.equal(A.code, "SHOP1");
  await assert.rejects(() => svc.CC.create({ code: "SHOP1", name: "Other" }, req()), { code: "COST_CENTRE_EXISTS" });
  await assert.rejects(() => svc.CC.create({ code: "X1", name: "deira SHOP" }, req()), { code: "COST_CENTRE_EXISTS" });
  await assert.rejects(() => svc.CC.create({ code: "bad code!", name: "X" }, req()), { code: "INVALID_CODE" });
  const group = await svc.CC.create({ code: "RETAIL", name: "Retail" }, req());
  const child = await svc.CC.update(A._id, { parentId: group._id }, req());
  assert.equal(String(child.parentId), String(group._id));
  await assert.rejects(() => svc.CC.update(group._id, { parentId: B._id }, req()), { code: "INVALID_PARENT" });
  await svc.CC.update(A._id, { parentId: "" }, req());
  await svc.CC.remove(group._id, req());
  assert.deepEqual((await svc.CC.list(req(), { active: true })).map((c) => c.code), ["SHOP1", "SHOP2"]);
});

let invoice;
test("a sale with a header centre and a line override: every row tagged, revenue and cost of goods split by line", { skip }, async () => {
  const draft = await svc.Tx.createTransaction({
    type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", costCentreId: String(A._id),
    items: [line(10, 20), line(20, 20, { costCentreId: String(B._id) }), line(1, 20, { costCentreId: "" })],
  }, "t");
  assert.equal(String(draft.costCentreId), String(A._id));
  assert.equal(String(draft.items[1].costCentreId), String(B._id));
  assert.equal(draft.items[2].costCentreId, undefined, "a blank line centre is none");
  invoice = await svc.Tx.processTransaction(draft._id, "approve", "t");
  const rows = await rowsOf(draft._id);
  assert.ok(rows.length >= 5);
  assert.ok(rows.every((r) => r.costCentreId), "every row carries a centre");
  const [rev, cogs] = await Promise.all([acct("Sales Revenue"), acct("Cost of Goods Sold")]);
  const on = (acc, c, k) => round2(rows.filter((r) => String(r.accountId) === String(acc._id) && String(r.costCentreId) === String(c._id)).reduce((t, r) => t + r[k], 0));
  assert.equal(on(rev, A, "creditAmount"), 220, "lines 1 and 3 (the header's)");
  assert.equal(on(rev, B, "creditAmount"), 400);
  assert.equal(on(cogs, A, "debitAmount"), 110);
  assert.equal(on(cogs, B, "debitAmount"), 200);
  const debit = round2(rows.reduce((t, r) => t + r.debitAmount, 0));
  assert.equal(debit, round2(rows.reduce((t, r) => t + r.creditAmount, 0)));
});

test("a document that names no centre posts as it always did", { skip }, async () => {
  const d = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [line(2, 20)] }, "t");
  await svc.Tx.processTransaction(d._id, "approve", "t");
  assert.ok((await rowsOf(d._id)).every((r) => r.costCentreId === undefined));
});

test("an unknown or switched-off centre is refused; one the draft already carried may stay after it is switched off", { skip }, async () => {
  const base = { type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [line(1, 20)] };
  await assert.rejects(() => svc.Tx.createTransaction({ ...base, costCentreId: String(new mongoose.Types.ObjectId()) }, "t"), { code: "INVALID_COST_CENTRE" });
  await assert.rejects(() => svc.Tx.createTransaction({ ...base, costCentreId: String(OFF._id) }, "t"), { code: "INVALID_COST_CENTRE" });
  await assert.rejects(() => svc.Tx.createTransaction({ ...base, items: [line(1, 20, { costCentreId: "nonsense" })] }, "t"), { code: "INVALID_COST_CENTRE" });
  const tmp = await svc.CC.create({ code: "TMP", name: "Temporary" }, req());
  const d = await svc.Tx.createTransaction({ ...base, costCentreId: String(tmp._id) }, "t");
  await svc.CC.update(tmp._id, { isActive: false }, req());
  const edited = await svc.Tx.updateTransaction(d._id, { notes: "still here", costCentreId: String(tmp._id) }, "t");
  assert.equal(String(edited.costCentreId), String(tmp._id));
  const cleared = await svc.Tx.updateTransaction(d._id, { costCentreId: "" }, "t");
  assert.equal(cleared.costCentreId, undefined);
  await svc.Tx.deleteTransaction(d._id, "t");
});

test("a journal tags each line with its own centre (or the voucher's); an expense voucher carries its header centre", { skip }, async () => {
  const [cash, capital, rent] = await Promise.all([acct("Cash in Hand"), acct("Owner's Capital"), acct("Rent Expense")]);
  const j = await svc.Financial.createVoucher({
    voucherType: "journal", date: new Date(), narration: "split rent", costCentreId: String(A._id),
    lines: [
      { accountId: rent._id, debit: 60, costCentreId: String(B._id) },
      { accountId: rent._id, debit: 40 },
      { accountId: capital._id, credit: 100, costCentreId: "" },
    ],
  }, admin);
  const jr = await rowsOf(j._id);
  const of = (acc, k) => jr.filter((r) => String(r.accountId) === String(acc._id) && r[k] > 0).map((r) => [r[k], String(r.costCentreId)]).sort();
  assert.deepEqual(of(rent, "debitAmount"), [[40, String(A._id)], [60, String(B._id)]].sort());
  assert.deepEqual(of(capital, "creditAmount"), [[100, String(A._id)]]);

  await svc.Financial.createVoucher({ voucherType: "journal", date: new Date(), narration: "fund cash", lines: [{ accountId: cash._id, debit: 500 }, { accountId: capital._id, credit: 500 }] }, admin);
  const e = await svc.Financial.createVoucher({ voucherType: "expense", ledgerBased: true, expenseAccountId: rent._id, amount: 30, description: "Karama rent", paymentMode: "cash", date: new Date(), costCentreId: String(B._id) }, admin);
  assert.equal(String(e.costCentreId), String(B._id));
  assert.ok((await rowsOf(e._id)).every((r) => String(r.costCentreId) === String(B._id)));
  await assert.rejects(() => svc.Financial.createVoucher({ voucherType: "journal", date: new Date(), lines: [{ accountId: rent._id, debit: 1, costCentreId: String(OFF._id) }, { accountId: capital._id, credit: 1 }] }, admin), { code: "INVALID_COST_CENTRE" });
});

test("the P&L narrowed to each centre adds up to the whole, and the by-centre report says the same", { skip }, async () => {
  const whole = await svc.Reports.profitAndLoss({});
  const a = await svc.Reports.profitAndLoss({ costCentre: String(A._id) });
  const b = await svc.Reports.profitAndLoss({ costCentre: String(B._id) });
  const none = await svc.Reports.profitAndLoss({ costCentre: "none" });
  assert.equal(round2(a.netProfit + b.netProfit + none.netProfit), whole.netProfit);
  assert.equal(round2(a.revenue.total + b.revenue.total + none.revenue.total), whole.revenue.total);
  assert.ok(b.operatingExpenses.total >= 90, "Karama carries 60 of the journal's rent and the 30 expense");

  const report = await svc.Reports.byCostCentre({});
  assert.equal(report.totals.netProfit, whole.netProfit);
  assert.equal(report.totals.revenue, whole.revenue.total);
  assert.deepEqual(report.rows.map((r) => r.name), ["Deira shop", "Karama shop", "Not assigned"]);
  await assert.rejects(() => svc.Reports.profitAndLoss({ costCentre: "nope" }), { code: "INVALID_COST_CENTRE" });
});

test("deleting the approved sale reverses its rows with their centres, and a centre in use cannot be deleted", { skip }, async () => {
  await svc.Tx.deleteTransaction(invoice._id, "t");
  const net = await svc.LedgerEntry.aggregate([
    { $match: { voucherId: invoice._id, costCentreId: B._id } },
    { $group: { _id: null, d: { $sum: "$debitAmount" }, c: { $sum: "$creditAmount" }, n: { $sum: 1 } } },
  ]);
  assert.ok(net[0].n >= 4, "the reversal rows carry the centre too");
  assert.equal(round2(net[0].d), round2(net[0].c));
  await assert.rejects(() => svc.CC.remove(B._id, req()), { code: "COST_CENTRE_IN_USE" });
});
