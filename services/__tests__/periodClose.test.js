// Closing a month inside an open fiscal year, and the stock-versus-ledger check the close uses. Throwaway database; see
// yearEnd.test.js, whose style and fixtures this follows.
//
// Two stories. 2024 is in the past, so its checks read the stock "as at" a day that has gone (the history basis) and a
// month there has ended. 2093 and 2094 are far enough ahead that none of their months has "ended" whichever day this runs,
// so every close there acknowledges MONTH_NOT_ENDED and the test is the same in any year.
//
//   npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const admin = new mongoose.Types.ObjectId();
const req = { admin: { id: String(admin), name: "Mariam" } };
const NOT_ENDED = "MONTH_NOT_ENDED";
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

let svc;
let A = {}; // accounts by name
let years = {}; // fiscal years by code
let rice;
let vendor;
let customer;

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Financial: require("../financial/financialService"),
    Config: require("../financial/accountConfigService"),
    YearEnd: require("../financial/yearEndService"),
    Period: require("../financial/periodCloseService"),
    Stock: require("../reports/stockReportsService"),
    Posting: require("../financial/postingService"),
    Tx: require("../orderPurchase/transactionService"),
    FiscalYear: require("../core/fiscalYearService"),
    FYModel: require("../../models/modules/financial/fiscalYearModel"),
    Branch: require("../../models/core/branchModel"),
    Activity: require("../../models/modules/financial/activityLogModel"),
    ...require("../../models/modules/financial/financialModels"),
    Transaction: require("../../models/modules/transactionModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    StockItem: require("../../models/modules/stockModel"),
    tenant: require("../../utils/tenantContext"),
    orgLocale: require("../../utils/orgLocale"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);

  // the default current year is replaced by the years of the stories
  await svc.FYModel.deleteMany({});
  for (const code of ["2024", "2093", "2094"]) {
    years[code] = await svc.FiscalYear.create({ code, startDate: svc.orgLocale.dayStart(`${code}-01-01`), endDate: svc.orgLocale.endOfDay(`${code}-12-31`) }, req);
  }
  for (const n of ["Cash in Hand", "Owner's Capital", "Other Income", "Rent Expense", "Utilities", "Retained Earnings"]) {
    A[n] = await svc.LedgerAccount.findOne({ accountName: n });
  }
  A.Inventory = await svc.LedgerAccount.findById(await svc.Config.resolveAccount("inventory-asset"));
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Gulf Mills", contactPerson: "x", address: "y" });
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", creditLimit: 500 });
  rice = await svc.StockItem.create({ itemId: "RICE", sku: "RICE", itemName: "Rice", category: new mongoose.Types.ObjectId() });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const day = (d) => new Date(`${d}T00:00:00.000Z`);
const journal = (d, debit, credit, amount, narration = "test") =>
  svc.Financial.createVoucher({ voucherType: "journal", date: day(d), narration, lines: [{ accountId: A[debit]._id, debit: amount }, { accountId: A[credit]._id, credit: amount }] }, admin);
const refused = (promise, code) => assert.rejects(() => promise, (e) => e.code === code, `expected ${code}`);
const refusedWith = (promise, code, message) => assert.rejects(() => promise, (e) => e.code === code && e.message === message, `expected ${code}: ${message}`);
const live = (filter = {}) => svc.LedgerEntry.find({ isReversed: { $ne: true }, ...filter }).lean();
const lockOf = async (code) => (await svc.FYModel.findById(years[code]._id).lean()).lockedThrough;
const close = (code, key, ...ack) => svc.Period.close(years[code]._id, key, { acknowledge: ack }, req);
const reopen = (code, key) => svc.Period.reopen(years[code]._id, key, req);
const preview = (code, key) => svc.Period.preview(years[code]._id, key);
const stateOf = async (code, key) => (await svc.Period.months(years[code]._id)).months.find((m) => m.key === key);
const buy = async (date, qty, price) => {
  const t = await svc.Tx.createTransaction({
    type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", date: day(date),
    items: [{ itemId: rice._id, description: "Rice", qty, price, rate: price, vatPercent: 5 }],
  }, "tester");
  await svc.Tx.processTransaction(t._id, "approve", "tester");
  return t;
};
const inventoryJournal = (date, amount, side) =>
  svc.Financial.createVoucher({
    voucherType: "journal", date: day(date), narration: "Inventory count correction",
    lines: side === "debit" ? [{ accountId: A.Inventory._id, debit: amount }, { accountId: A["Cash in Hand"]._id, credit: amount }] : [{ accountId: A["Cash in Hand"]._id, debit: amount }, { accountId: A.Inventory._id, credit: amount }],
  }, admin);

// ================================================================================================ stock against the ledger, as at a day

test("stock against the ledger is computed as at any day, and says what that can and cannot prove", { skip }, async () => {
  await buy("2024-01-20", 10, 50); // 500 of stock, 500 into the Inventory account
  await inventoryJournal("2024-03-10", 120, "debit"); // a hand entry to the Inventory account that no stock movement stands behind

  const before = await svc.Stock.ledgerCheck({ asOn: "2024-01-10" });
  assert.deepEqual([before.stockValue, before.ledgerBalance, before.reconciles], [0, 0, true], "before the purchase there was nothing on either side");

  const feb = await svc.Stock.ledgerCheck({ asOn: "2024-02-29" });
  assert.deepEqual([feb.stockValue, feb.ledgerBalance, feb.difference, feb.reconciles], [500, 500, 0, true]);
  assert.equal(feb.basis, "history", "a day that has gone is worked out from the movements dated up to it");
  assert.equal(feb.exact, false, "so it is not claimed to be exact");
  assert.match(feb.note, /as the books stand now/);
  assert.equal(feb.asOn, "2024-02-29");

  const mar = await svc.Stock.ledgerCheck({ asOn: "2024-03-31" });
  assert.deepEqual([mar.stockValue, mar.ledgerBalance, mar.difference, mar.reconciles], [500, 620, -120, false]);
  assert.equal(mar.sources[0].key, "journals", "the difference is traced to the hand entry");
  assert.deepEqual([mar.sources[0].stock, mar.sources[0].ledger, mar.sources[0].difference], [0, 120, -120]);
  assert.equal(mar.unexplained, 0);
  assert.equal(mar.account.name, A.Inventory.accountName);

  const now = await svc.Stock.ledgerCheck();
  assert.equal(now.basis, "today");
  assert.equal(now.exact, true, "today the stock side adds up to the item records");
  assert.deepEqual([now.stockValue, now.ledgerBalance], [500, 620]);
  assert.equal(now.items.outOfSync, 0);

  // it is the SAME reconciliation the valuation screen shows
  const valuation = await svc.Stock.valuation({ asOn: "2024-03-31" });
  assert.equal(valuation.reconciliation.difference, mar.difference);
  assert.equal(valuation.reconciliation.basis, "history");
});

test("a quantity written to an item with no movement is seen today, and the check says it is not exact", { skip }, async () => {
  await svc.StockItem.updateOne({ _id: rice._id }, { $set: { currentStock: 99 } }); // as if typed straight onto the item
  const now = await svc.Stock.ledgerCheck();
  assert.equal(now.items.outOfSync, 1);
  assert.equal(now.exact, false);
  assert.match(now.note, /One item shows a quantity on the item record that the movements do not add up to/);
  const past = await svc.Stock.ledgerCheck({ asOn: "2024-03-31" });
  assert.equal(past.items.outOfSync, 0, "for a past day there is nothing to compare it with");
  await svc.StockItem.updateOne({ _id: rice._id }, { $set: { currentStock: 10 } });
  const again = await svc.Stock.ledgerCheck();
  assert.equal(again.exact, true);
  assert.match(again.note, /so it is exact/);
});

// ================================================================================================ 2024: months that have ended

test("a month whose stock agrees with the ledger closes with nothing to tick, and the check is shown as passed", { skip }, async () => {
  const pre = await preview("2024", "2024-01");
  assert.equal(pre.canClose, true);
  assert.deepEqual(pre.warnings, []);
  assert.deepEqual(pre.checks.map((c) => c.code), ["ALL_BRANCHES", "EARLIER_MONTHS_CLOSED", "DOCUMENTS_FINISHED", "LEDGER_BALANCED", "STOCK_AGREES"]);
  assert.match(pre.checks.at(-1).title, /^Stock agrees with the Inventory ledger \(AED 500\.00\)$/);
  assert.equal(pre.stock.reconciles, true);

  const out = await close("2024", "2024-01");
  assert.equal(out.closedNow, true);
  assert.equal(await lockOf("2024"), "2024-01-31");
  const jan = await stateOf("2024", "2024-01");
  assert.equal(jan.status, "closed");
  assert.equal(jan.closedBy, "Mariam");
  assert.ok(jan.closedAt);
  await close("2024", "2024-02");
  assert.equal(await lockOf("2024"), "2024-02-29");
});

test("a month where stock and ledger differ is a warning that must be ticked, with the difference and where it comes from", { skip }, async () => {
  const pre = await preview("2024", "2024-03");
  assert.equal(pre.canClose, true, "a warning never blocks");
  const w = pre.warnings.find((x) => x.code === "STOCK_NOT_RECONCILED");
  assert.ok(w, JSON.stringify(pre.checks));
  assert.equal(w.title, "Stock differs from the Inventory ledger by AED 120.00");
  assert.match(w.detail, /At 31 Mar 2024 the stock is worth AED 500\.00 and .* shows AED 620\.00/);
  assert.match(w.detail, /Largest: Journals and other vouchers posted to Inventory \(stock 0\.00, ledger 120\.00\)/);
  assert.match(w.detail, /as the books stand now/, "it is a past day: the caveat is part of the line");
  assert.equal(pre.stock.basis, "history");

  await refused(close("2024", "2024-03"), "MONTH_CLOSE_WARNINGS");
  await refused(close("2024", "2024-03", "SOMETHING_ELSE"), "MONTH_CLOSE_WARNINGS");
  assert.equal(await lockOf("2024"), "2024-02-29", "nothing changed");

  const out = await close("2024", "2024-03", "STOCK_NOT_RECONCILED");
  assert.equal(await lockOf("2024"), "2024-03-31");
  const row = (await svc.FYModel.findById(years["2024"]._id).lean()).monthCloses.find((c) => c.month === "2024-03");
  assert.deepEqual(row.acknowledged, ["STOCK_NOT_RECONCILED"], "what was accepted is on record");
  assert.equal(out.monthKey, "2024-03");
});

test("only the latest closed month is reopened; the lock falls back to the month before", { skip }, async () => {
  const pre = await preview("2024", "2024-01");
  assert.equal(pre.reopen.canReopen, false);
  assert.deepEqual(pre.reopen.blockers.map((b) => b.code), ["LATER_MONTH_CLOSED"]);
  await refused(reopen("2024", "2024-01"), "MONTH_REOPEN_BLOCKED");
  await refused(reopen("2024", "2024-04"), "NOT_CLOSED");

  const out = await reopen("2024", "2024-03");
  assert.equal(out.reopenedNow, true);
  assert.equal(await lockOf("2024"), "2024-02-29");
  assert.equal((await stateOf("2024", "2024-03")).status, "open");
  assert.equal((await svc.FYModel.findById(years["2024"]._id).lean()).monthCloses.length, 2, "its record goes with it");
  await journal("2024-03-12", "Utilities", "Cash in Hand", 5); // March takes postings again

  await close("2024", "2024-03", "STOCK_NOT_RECONCILED");
  assert.equal(await lockOf("2024"), "2024-03-31");
});

test("a correcting entry in an open month brings stock and ledger back together from that day on", { skip }, async () => {
  await inventoryJournal("2024-04-02", 120, "credit");
  assert.equal((await svc.Stock.ledgerCheck({ asOn: "2024-03-31" })).reconciles, false, "March as it stood still shows the difference");
  assert.equal((await svc.Stock.ledgerCheck({ asOn: "2024-04-30" })).reconciles, true);
  assert.equal((await preview("2024", "2024-04")).stock.reconciles, true);
});

test("a year flipped closed the old way (a plain flag) still locks the whole year, and its months come back as they were", { skip }, async () => {
  await svc.FiscalYear.setStatus(years["2024"]._id, "closed", admin);
  await refusedWith(journal("2024-09-01", "Rent Expense", "Cash in Hand", 1), "PERIOD_CLOSED", "Fiscal year 2024 is closed");
  const closedState = await svc.Period.months(years["2024"]._id);
  assert.deepEqual(closedState.months.slice(0, 5).map((m) => m.status), ["closed", "closed", "closed", "yearClosed", "yearClosed"]);
  assert.equal(closedState.months.some((m) => m.canClose || m.canReopen), false);
  await refused(close("2024", "2024-04"), "YEAR_CLOSED");
  await refused(reopen("2024", "2024-03"), "YEAR_CLOSED");
  assert.equal(await lockOf("2024"), "2024-03-31", "closing the year did not touch the month lock");

  await svc.FiscalYear.setStatus(years["2024"]._id, "open", admin);
  assert.equal(await lockOf("2024"), "2024-03-31", "and reopening it did not either");
  await refusedWith(journal("2024-03-31", "Rent Expense", "Cash in Hand", 1), "PERIOD_CLOSED", "Posting is closed up to 31 Mar 2024");
  await journal("2024-04-03", "Rent Expense", "Cash in Hand", 1);
  await svc.FiscalYear.setStatus(years["2024"]._id, "closed", admin); // the year is done: 2093 may begin
});

// ================================================================================================ 2093: the books

test("the books of 2093", { skip }, async () => {
  await journal("2093-01-10", "Cash in Hand", "Owner's Capital", 10000);
  await journal("2093-01-20", "Cash in Hand", "Other Income", 500);
  await journal("2093-02-05", "Rent Expense", "Cash in Hand", 200);
  await journal("2093-03-05", "Utilities", "Cash in Hand", 50);
});

test("a year's months are listed with where each stands, and the fiscal-year list carries them", { skip }, async () => {
  const { year, months } = await svc.Period.months(years["2093"]._id);
  assert.equal(months.length, 12);
  assert.deepEqual([year.startDay, year.endDay, year.lockedThrough], ["2093-01-01", "2093-12-31", null]);
  assert.deepEqual(months.filter((m) => m.canClose).map((m) => m.key), ["2093-01"], "only January may be closed first");
  assert.equal(months.every((m) => m.status === "open"), true);

  const list = await svc.FiscalYear.list(req);
  const row = list.find((y) => y.code === "2093");
  assert.equal(row.months.length, 12);
  assert.equal(row.startDay, "2093-01-01");
  assert.equal(list.find((y) => y.code === "2024").months.filter((m) => m.status === "closed").length, 3, "2024's three closed months show under the year that is closed");
  await refused(svc.Period.months("not-an-id"), "NOT_FOUND");
  await refused(svc.Period.preview(years["2093"]._id, "2094-01"), "MONTH_NOT_FOUND");
  await refused(svc.Period.preview(years["2093"]._id, "nonsense"), "MONTH_NOT_FOUND");
});

test("months are closed in order, and the reason is given before anything is changed", { skip }, async () => {
  const pre = await preview("2093", "2093-03");
  assert.equal(pre.canClose, false);
  assert.deepEqual(pre.blockers.map((b) => b.code), ["EARLIER_MONTH_OPEN"]);
  assert.equal(pre.blockers[0].title, "Close January 2093 first");
  await refused(close("2093", "2093-03", NOT_ENDED), "MONTH_CLOSE_BLOCKED");
  assert.equal(await lockOf("2093"), undefined);
});

test("a month that has not ended needs that warning ticked by name", { skip }, async () => {
  const pre = await preview("2093", "2093-01");
  assert.equal(pre.canClose, true);
  assert.deepEqual(pre.warnings.map((w) => w.code), [NOT_ENDED]);
  assert.match(pre.warnings[0].detail, /It runs until 31 Jan 2093/);
  await refused(close("2093", "2093-01"), "MONTH_CLOSE_WARNINGS");
  assert.equal(await lockOf("2093"), undefined);
});

test("a draft document dated in the month stops it, and one dated in another month does not", { skip }, async () => {
  const draft = await svc.Tx.createTransaction({
    type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", date: day("2093-01-25"),
    items: [{ itemId: rice._id, description: "Rice", qty: 1, price: 10, rate: 10, vatPercent: 5 }],
  }, "tester");
  const pre = await preview("2093", "2093-01");
  assert.deepEqual(pre.blockers.map((b) => b.code), ["UNFINISHED_DOCUMENTS"]);
  assert.match(pre.blockers[0].title, /1 document dated in January 2093 is not approved/);
  await refused(close("2093", "2093-01", NOT_ENDED), "MONTH_CLOSE_BLOCKED");
  assert.equal((await preview("2093", "2093-02")).blockers.some((b) => b.code === "UNFINISHED_DOCUMENTS"), false, "February is another month's business");
  await svc.Transaction.deleteOne({ _id: draft._id });
  assert.equal((await preview("2093", "2093-01")).canClose, true);
});

test("a ledger that does not balance up to the month end stops it", { skip }, async () => {
  const bad = await svc.LedgerEntry.create({
    voucherId: new mongoose.Types.ObjectId(), voucherNo: "BAD-1", voucherType: "journal", accountId: A["Cash in Hand"]._id,
    accountName: "Cash in Hand", date: day("2093-01-12"), debitAmount: 7, createdBy: admin,
  });
  const pre = await preview("2093", "2093-01");
  assert.deepEqual(pre.blockers.map((b) => b.code), ["LEDGER_OUT_OF_BALANCE"]);
  assert.match(pre.blockers[0].detail, /Head office: debits and credits differ by AED 7\.00 up to 31 Jan 2093/);
  await refused(close("2093", "2093-01", NOT_ENDED), "MONTH_CLOSE_BLOCKED");
  await svc.LedgerEntry.deleteOne({ _id: bad._id });
  assert.equal((await preview("2093", "2093-01")).canClose, true);
});

// ================================================================================================ the lock

test("closing January locks it: nothing is posted, edited or reversed on or before its last day", { skip }, async () => {
  const res = await close("2093", "2093-01", NOT_ENDED);
  assert.equal(res.closedNow, true);
  assert.equal(await lockOf("2093"), "2093-01-31");
  assert.equal((await stateOf("2093", "2093-01")).status, "closed");
  const row = (await svc.FYModel.findById(years["2093"]._id).lean()).monthCloses[0];
  assert.deepEqual([row.month, row.closedByName, row.acknowledged], ["2093-01", "Mariam", [NOT_ENDED]]);

  // a new posting, on the last day and on the first
  await refusedWith(journal("2093-01-31", "Rent Expense", "Cash in Hand", 5), "PERIOD_CLOSED", "Posting is closed up to 31 Jan 2093");
  await refusedWith(journal("2093-01-01", "Rent Expense", "Cash in Hand", 5), "PERIOD_CLOSED", "Posting is closed up to 31 Jan 2093");
  // a document
  await refused(svc.Tx.createTransaction({
    type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", date: day("2093-01-15"),
    items: [{ itemId: rice._id, description: "Rice", qty: 1, price: 10, rate: 10, vatPercent: 5 }],
  }, "tester"), "PERIOD_CLOSED");
  // the day after is open
  await journal("2093-02-01", "Utilities", "Cash in Hand", 10);
  await svc.FiscalYear.assertPostingAllowed(day("2093-02-01"));
});

test("undoing or changing something dated in a closed month is refused, and moving a voucher into one is too", { skip }, async () => {
  const [jan] = await svc.Voucher.find({ date: day("2093-01-20") });
  await refused(svc.Financial.deleteVoucher(jan._id, admin), "PERIOD_CLOSED");
  await refused(svc.Financial.updateVoucher(jan._id, { narration: "changed", forceUpdate: true }, admin), "PERIOD_CLOSED");
  assert.equal((await svc.Voucher.findById(jan._id)).status, jan.status, "nothing happened to it");

  const feb = await journal("2093-02-02", "Utilities", "Cash in Hand", 3);
  await refused(svc.Financial.updateVoucher(feb._id, { date: day("2093-01-30"), forceUpdate: true }, admin), "PERIOD_CLOSED");
  assert.equal((await svc.Voucher.findById(feb._id)).date.toISOString().slice(0, 10), "2093-02-02", "it stayed where it was");
  await svc.Financial.deleteVoucher(feb._id, admin); // a voucher in the open month is still deleted
});

test("the lock is the organisation's calendar day, and covers every branch", { skip }, async () => {
  // 23:59 in the organisation's zone on the 31st is January; two hours later it is February there
  const lastMinute = new Date(svc.orgLocale.endOfDay("2093-01-31").getTime());
  const nextMorning = new Date(lastMinute.getTime() + 1);
  await refused(svc.FiscalYear.assertPostingAllowed(lastMinute), "PERIOD_CLOSED");
  await svc.FiscalYear.assertPostingAllowed(nextMorning);

  await svc.Branch.create({ code: "shj", name: "Sharjah", isActive: true });
  const sharjah = { companyId: "default", branchId: "shj", branchView: "shj" };
  await svc.tenant.runWithTenant(sharjah, async () => {
    await refused(journal("2093-01-15", "Rent Expense", "Cash in Hand", 5), "PERIOD_CLOSED");
    await journal("2093-02-15", "Cash in Hand", "Other Income", 40);
    // a person looking at one branch cannot lock or unlock the organisation
    const pre = await preview("2093", "2093-02");
    assert.ok(pre.blockers.some((b) => b.code === "ALL_BRANCHES_REQUIRED"));
    await refused(close("2093", "2093-02", NOT_ENDED), "MONTH_CLOSE_BLOCKED");
    await refused(reopen("2093", "2093-01"), "ALL_BRANCHES_REQUIRED");
  });
  assert.equal(await lockOf("2093"), "2093-01-31");
});

test("the audit log records who closed and reopened a month", { skip }, async () => {
  const rows = await svc.Activity.find({ action: "PERIOD_MONTH_CLOSED", entity: "FiscalYear", entityId: String(years["2093"]._id) }).lean();
  assert.equal(rows.length, 1);
  assert.match(rows[0].summary, /January 2093 closed \(2093\); posting is closed up to 31 Jan 2093/);
  assert.equal(rows[0].after.lockedThrough, "2093-01-31");
  assert.deepEqual(rows[0].after.acknowledged, [NOT_ENDED]);
  assert.ok(await svc.Activity.exists({ action: "PERIOD_MONTH_REOPENED", entity: "FiscalYear", entityId: String(years["2024"]._id) }), "and the reopening of March 2024 earlier");
});

test("two people closing the same month at once: one closes it, the other is told it is closed", { skip }, async () => {
  const results = await Promise.allSettled([close("2093", "2093-02", NOT_ENDED), close("2093", "2093-02", NOT_ENDED)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one succeeds");
  const lost = results.find((r) => r.status === "rejected");
  assert.equal(lost.reason.code, "ALREADY_CLOSED");
  assert.equal(await lockOf("2093"), "2093-02-28");
  assert.equal((await svc.FYModel.findById(years["2093"]._id).lean()).monthCloses.length, 2, "recorded once");
});

// ================================================================================================ the year over its months

test("closing the year after all its months: the closing entry is written inside the locked December, and nothing else can be", { skip }, async () => {
  for (const key of ["2093-03", "2093-04", "2093-05", "2093-06", "2093-07", "2093-08", "2093-09", "2093-10", "2093-11", "2093-12"]) await close("2093", key, NOT_ENDED);
  assert.equal(await lockOf("2093"), "2093-12-31");
  assert.equal((await svc.Period.months(years["2093"]._id)).months.every((m) => m.status === "closed"), true);
  await refusedWith(journal("2093-12-20", "Rent Expense", "Cash in Hand", 5), "PERIOD_CLOSED", "Posting is closed up to 31 Dec 2093");

  const pre = await svc.YearEnd.preview(years["2093"]._id, req);
  assert.equal(pre.canClose, true, JSON.stringify(pre.blockers));
  const res = await svc.YearEnd.close(years["2093"]._id, { acknowledge: pre.warnings.map((w) => w.code) }, req);
  assert.equal(res.closing.posted, true, "the closing entry is a direct write: the month lock does not stop it");
  const entries = await live({ voucherType: "closing", voucherNo: res.closing.voucherNo });
  assert.ok(entries.length >= 4);
  assert.ok(entries.every((e) => e.date.toISOString().slice(0, 10) === "2093-12-31"), "dated inside the month that is closed");
  assert.equal(r2(entries.reduce((t, e) => t + e.debitAmount - e.creditAmount, 0)), 0);
  assert.equal(await lockOf("2093"), "2093-12-31", "closing the year left the month lock as it was");
  await refusedWith(journal("2093-12-20", "Rent Expense", "Cash in Hand", 5), "PERIOD_CLOSED", "Fiscal year 2093 is closed");
  await refused(reopen("2093", "2093-12"), "YEAR_CLOSED");
});

test("the next year's months follow the previous year, which may be closed or locked right to its last day", { skip }, async () => {
  const pre = await preview("2094", "2094-01");
  assert.equal(pre.blockers.length, 0, "2093 is closed");
  await close("2094", "2094-01", NOT_ENDED);
  assert.equal(await lockOf("2094"), "2094-01-31");
  // 2093 cannot be reopened while 2094 has a month closed on its figures
  const yearPre = await svc.YearEnd.preview(years["2093"]._id, req);
  assert.equal(yearPre.reopen.canReopen, false);
  assert.deepEqual(yearPre.reopen.blockers.map((b) => b.code), ["LATER_MONTHS_CLOSED"]);
  await refused(svc.YearEnd.reopen(years["2093"]._id, req), "YEAR_REOPEN_BLOCKED");
  await reopen("2094", "2094-01");
  assert.equal(await lockOf("2094"), undefined, "the first month reopened: no lock at all");
});

test("reopening the year gives back exactly the months that were closed before it", { skip }, async () => {
  await svc.YearEnd.reopen(years["2093"]._id, req);
  assert.equal((await svc.FYModel.findById(years["2093"]._id).lean()).status, "open");
  assert.equal(await lockOf("2093"), "2093-12-31", "all twelve are still closed");
  assert.equal((await live({ voucherType: "closing", voucherNo: /^YEC-2093/ })).length, 0, "the closing entry is reversed");
  await refusedWith(journal("2093-12-20", "Rent Expense", "Cash in Hand", 5), "PERIOD_CLOSED", "Posting is closed up to 31 Dec 2093");

  // 2094 may begin because 2093 is locked right to its last day, even though it is not closed as a year
  await close("2094", "2094-01", NOT_ENDED);
  const dec = await preview("2093", "2093-12");
  assert.equal(dec.reopen.canReopen, false);
  assert.deepEqual(dec.reopen.blockers.map((b) => b.code), ["LATER_YEAR_LOCKED"]);
  await reopen("2094", "2094-01");

  await reopen("2093", "2093-12");
  assert.equal(await lockOf("2093"), "2093-11-30");
  await journal("2093-12-20", "Rent Expense", "Cash in Hand", 5); // December takes postings again
  await refused(close("2094", "2094-01", NOT_ENDED), "MONTH_CLOSE_BLOCKED");
  assert.deepEqual((await preview("2094", "2094-01")).blockers.map((b) => b.code), ["EARLIER_YEAR_OPEN"]);
});

// ================================================================================================ catch-up

test("catching the ledger up posts an approved document into a month that has since been closed", { skip }, async () => {
  // approved while ledger posting was off, so it never reached the ledger; December is then closed (posting off is a
  // warning the person ticks); switching posting on catches the document up - the lock is for people posting, not for this
  await svc.Config.setPostingEnabled(false);
  const doc = await buy("2093-12-15", 2, 50);
  assert.equal(await svc.LedgerEntry.countDocuments({ voucherId: doc._id }), 0, "nothing reached the ledger");
  const pre = await preview("2093", "2093-12");
  assert.equal(pre.warnings.some((w) => w.code === "POSTING_OFF"), true);
  assert.equal(pre.warnings.some((w) => w.code === "STOCK_NOT_RECONCILED"), false, "posting off already says the ledger is not receiving");
  await close("2093", "2093-12", NOT_ENDED, "POSTING_OFF");
  assert.equal(await lockOf("2093"), "2093-12-31");

  await svc.Config.setPostingEnabled(true);
  const result = await svc.Posting.catchUp({ createdBy: admin });
  assert.equal(result.posted, 1, JSON.stringify(result));
  assert.deepEqual(result.failed, []);
  const entries = await live({ voucherId: doc._id });
  assert.ok(entries.length >= 2);
  assert.ok(entries.every((e) => e.date.toISOString().slice(0, 10) === "2093-12-15"), "dated in the closed month");
  await refusedWith(journal("2093-12-15", "Rent Expense", "Cash in Hand", 5), "PERIOD_CLOSED", "Posting is closed up to 31 Dec 2093");
});
