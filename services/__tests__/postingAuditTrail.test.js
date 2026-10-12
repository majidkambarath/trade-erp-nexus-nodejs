// The audit trail of a posting that has no Voucher behind it. The ledger prints a number for an opening
// balance (OBV-...), opening stock (OSI-...), an account opened with a balance (OB-<code>) and a year-end
// closing entry (YEC-...), and the screen opens the trail by that posting's id. Those ids are not Voucher ids,
// so the trail answered "Voucher not found" for a number the ledger itself had just shown. It now reads each
// kind from the record that keeps it, in the voucher trail's own shape. Throwaway database, see
// accountingFoundation.test.js.
//
//   node --require ./utils/testSetup.js --test services/__tests__/postingAuditTrail.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const admin = new mongoose.Types.ObjectId();
const by = { adminId: admin };
const req = { admin: { id: String(admin), email: "owner@example.test" } };
const ACK = { acknowledge: ["YEAR_NOT_ENDED"] };

// far enough ahead that neither year has "ended" whichever day this runs
const GO_LIVE = "2088-06-30";
const day = (d) => new Date(`${d}T00:00:00.000Z`);

let svc;
let A = {};
let years = {};

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Financial: require("../financial/financialService"),
    Config: require("../financial/accountConfigService"),
    YearEnd: require("../financial/yearEndService"),
    OB: require("../financial/openingBalanceService"),
    Chart: require("../financial/chartOfAccountsService"),
    Trail: require("../financial/voucherAuditService"),
    Audit: require("../core/auditService"),
    FiscalYear: require("../core/fiscalYearService"),
    FYModel: require("../../models/modules/financial/fiscalYearModel"),
    Stock: require("../../models/modules/stockModel"),
    AccountGroup: require("../../models/modules/financial/accountGroupModel"),
    ...require("../../models/modules/financial/financialModels"),
    orgLocale: require("../../utils/orgLocale"),
  };
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);

  await svc.FYModel.deleteMany({});
  for (const code of ["2088", "2089"]) {
    years[code] = await svc.FiscalYear.create({ code, startDate: svc.orgLocale.dayStart(`${code}-01-01`), endDate: svc.orgLocale.endOfDay(`${code}-12-31`) }, req);
  }
  for (const n of ["Cash in Hand", "Owner's Capital", "Other Income", "Rent Expense", "Retained Earnings"]) {
    A[n] = await svc.LedgerAccount.findOne({ accountName: n });
  }
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const factOf = (trail, label) => trail.source.facts.find((f) => f.label === label)?.value;

// ------------------------------------------------------------------------------------ opening balances

let accountsVoucher;

test("an opening balance voucher opens its trail: entries, what it is made of, and who posted it", { skip }, async () => {
  accountsVoucher = await svc.OB.postAccounts(
    { date: GO_LIVE, lines: [{ accountId: A["Cash in Hand"]._id, debit: 5000 }, { accountId: A["Owner's Capital"]._id, credit: 3000 }] },
    by
  );
  // the controller writes this row; the trail must find it under the opening voucher's own id
  await svc.Audit.log({ req, action: "OPENING_ACCOUNTS_POSTED", entity: "OpeningBalanceVoucher", entityId: accountsVoucher._id, summary: `${accountsVoucher.voucherNo}: 2 accounts` });

  const t = await svc.Trail.trail(String(accountsVoucher._id));
  assert.equal(t.voucher.voucherNo, accountsVoucher.voucherNo);
  assert.match(t.voucher.voucherNo, /^OBV-2088-/);
  assert.equal(t.voucher.typeLabel, "Opening balance");
  assert.equal(t.voucher.status, "posted");
  assert.equal(t.voucher.totalAmount, 5000);
  assert.equal(t.voucher.paymentMode, null);

  assert.equal(t.source.kind, "opening");
  assert.equal(factOf(t, "Accounts"), 2);
  assert.equal(factOf(t, "Total debit"), 5000);
  assert.equal(factOf(t, "Balancing figure to Opening Balance Equity (credit)"), 2000, "the 2,000 that was not given a side went to equity");

  assert.equal(t.ledger.posted, true);
  assert.equal(t.ledger.balanced, true);
  assert.equal(t.ledger.entries.length, 3, "cash, capital and the balancing line");
  assert.deepEqual([t.ledger.totals.debit, t.ledger.totals.credit], [5000, 5000]);
  assert.equal(t.ledger.note, null);
  assert.deepEqual(t.allocations, []);
  assert.equal(t.cheque, null);

  assert.deepEqual(t.activity.map((a) => a.action), ["OPENING_ACCOUNTS_POSTED"]);
  assert.equal(t.activity[0].username, "owner@example.test");
});

test("the account ledger rows carry the reference type the screen needs to pick the right trail", { skip }, async () => {
  const ledger = await svc.Chart.getLedger(String(A["Owner's Capital"]._id), {});
  const row = ledger.rows.find((r) => r.voucherNo === accountsVoucher.voucherNo);
  assert.ok(row, "the opening voucher is in the capital account's ledger");
  assert.equal(String(row.voucherId), String(accountsVoucher._id));
  assert.equal(row.voucherType, "opening");
  assert.equal(row.referenceType, "opening");
});

test("a reversed opening voucher says so, and still shows what it posted", { skip }, async () => {
  await svc.OB.reverseAccounts(accountsVoucher._id, by);
  const t = await svc.Trail.trail(String(accountsVoucher._id));
  assert.equal(t.voucher.status, "reversed");
  assert.equal(t.ledger.isReversed, true);
  assert.equal(t.ledger.entries.length, 3, "the original postings are still on record");
  assert.ok(t.ledger.reversals.length > 0);
  assert.match(t.ledger.note, /reversed/i);
  assert.ok(t.source.facts.some((f) => f.label === "Reversed on"));
});

// ------------------------------------------------------------------------------------ opening stock

test("opening stock opens its trail with the items and their value", { skip }, async () => {
  const category = new mongoose.Types.ObjectId();
  const rice = await svc.Stock.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category });
  const res = await svc.OB.postStock({ date: GO_LIVE, rows: [{ itemId: rice._id, qty: 10, unitCost: 5 }] }, by);

  const t = await svc.Trail.trail(String(res._id));
  assert.equal(t.voucher.voucherNo, res.voucherNo);
  assert.equal(t.voucher.typeLabel, "Opening stock");
  assert.equal(t.voucher.status, "posted");
  assert.equal(t.source.kind, "opening_stock");
  assert.equal(factOf(t, "Items"), 1);
  assert.equal(factOf(t, "Stock value"), 50);
  assert.equal(t.ledger.balanced, true);
  assert.equal(t.voucher.totalAmount, 50);
});

// ------------------------------------------------------------------------------------ account opened with a balance

test("an account created with an opening balance opens its trail from the account", { skip }, async () => {
  const group = await svc.AccountGroup.findOne({ name: "Bank" });
  // dated inside the test's fiscal years: the default is today, which none of them covers
  const acc = await svc.Chart.createAccount({ accountName: "Trail Bank", groupId: group._id, openingBalance: 7500, openingSide: "debit", openingDate: "2088-07-01" }, {}, null);

  const t = await svc.Trail.trail(String(acc._id));
  assert.equal(t.voucher.voucherNo, `OB-${acc.accountCode}`);
  assert.equal(t.voucher.typeLabel, "Opening balance");
  assert.equal(t.source.kind, "opening");
  assert.equal(factOf(t, "Opening balance"), 7500);
  assert.equal(factOf(t, "Side"), "Debit");
  assert.match(factOf(t, "Account"), /Trail Bank/);
  assert.equal(t.ledger.balanced, true);
  assert.equal(t.ledger.entries.length, 2, "the account's leg and the Opening Balance Equity leg");
});

// ------------------------------------------------------------------------------------ year-end closing

let closing;

test("a year-end closing entry opens its trail with the year's figures and who closed it", { skip }, async () => {
  await svc.Financial.createVoucher({ voucherType: "journal", date: day("2089-04-01"), narration: "income", lines: [{ accountId: A["Cash in Hand"]._id, debit: 800 }, { accountId: A["Other Income"]._id, credit: 800 }] }, admin);
  await svc.Financial.createVoucher({ voucherType: "journal", date: day("2089-06-01"), narration: "rent", lines: [{ accountId: A["Rent Expense"]._id, debit: 300 }, { accountId: A["Cash in Hand"]._id, credit: 300 }] }, admin);

  await svc.FYModel.updateOne({ _id: years["2088"]._id }, { status: "closed" }); // earlier years close first
  const res = await svc.YearEnd.close(years["2089"]._id, ACK, req);
  closing = res.closing;
  assert.equal(closing.posted, true);

  const t = await svc.Trail.trail(String(closing.voucherId));
  assert.equal(t.voucher.voucherNo, closing.voucherNo);
  assert.match(t.voucher.voucherNo, /^YEC-2089-/);
  assert.equal(t.voucher.typeLabel, "Year-end closing");
  assert.equal(t.voucher.status, "posted");
  assert.equal(t.source.kind, "closing");
  assert.equal(factOf(t, "Fiscal year"), "2089");
  assert.equal(factOf(t, "Income"), 800);
  assert.equal(factOf(t, "Expenses"), 300);
  assert.equal(factOf(t, "Profit moved to equity"), 500);
  assert.equal(factOf(t, "Moved to"), "Retained Earnings");
  assert.equal(t.ledger.balanced, true);
  assert.equal(t.ledger.entries.length, 3, "Other Income, Rent Expense and Retained Earnings");

  // closing is logged against the year, and the trail finds it there
  assert.deepEqual(t.activity.map((a) => a.action), ["PERIOD_CLOSED"]);
});

test("a year that was reopened shows its closing entry as reversed, with both events in the history", { skip }, async () => {
  await svc.YearEnd.reopen(years["2089"]._id, req);
  const t = await svc.Trail.trail(String(closing.voucherId));
  assert.equal(t.voucher.status, "reversed");
  assert.equal(t.ledger.isReversed, true);
  assert.equal(factOf(t, "Fiscal year"), "2089", "the year is named from the entries once the year no longer holds the closing");
  assert.deepEqual(t.activity.map((a) => a.action), ["PERIOD_CLOSED", "PERIOD_REOPENED"]);
});

// ------------------------------------------------------------------------------------ the rest

test("a stock adjustment or write-off, which has no record of its own beyond the entries, still opens", { skip }, async () => {
  const id = new mongoose.Types.ObjectId();
  const base = { voucherId: id, voucherNo: "SA-2088-0001", voucherType: "stock_adjustment", date: day("2088-08-01"), narration: "Stock loss: Rice (-3)", createdBy: admin };
  await svc.LedgerEntry.insertMany([
    { ...base, accountId: A["Rent Expense"]._id, accountName: "Rent Expense", accountCode: A["Rent Expense"].accountCode, debitAmount: 15, creditAmount: 0 },
    { ...base, accountId: A["Cash in Hand"]._id, accountName: "Cash in Hand", accountCode: A["Cash in Hand"].accountCode, debitAmount: 0, creditAmount: 15 },
  ]);
  const t = await svc.Trail.trail(String(id));
  assert.equal(t.voucher.voucherNo, "SA-2088-0001");
  assert.equal(t.voucher.typeLabel, "Stock adjustment");
  assert.equal(t.voucher.narration, "Stock loss: Rice (-3)");
  assert.equal(t.source.kind, "stock_adjustment");
  assert.deepEqual(t.source.facts, []);
  assert.equal(t.ledger.balanced, true);
  assert.equal(t.voucher.totalAmount, 15);
});

// ------------------------------------------------------------------------------------ what stays as it was

test("a real voucher still answers with the voucher's own trail, with no source block", { skip }, async () => {
  const v = await svc.Financial.createVoucher({ voucherType: "journal", date: day("2089-07-01"), narration: "plain", lines: [{ accountId: A["Rent Expense"]._id, debit: 40 }, { accountId: A["Cash in Hand"]._id, credit: 40 }] }, admin);
  const t = await svc.Trail.trail(String(v._id));
  assert.equal(t.voucher.typeLabel, "Journal voucher");
  assert.equal(t.source, undefined);
  assert.equal(t.ledger.balanced, true);
});

test("an id that nothing was posted under is still not found", { skip }, async () => {
  await assert.rejects(() => svc.Trail.trail(String(new mongoose.Types.ObjectId())), { statusCode: 404, message: "Voucher not found" });
  await assert.rejects(() => svc.Trail.trail("not-an-id"), { statusCode: 404 });
});
