// Recurring journal and expense vouchers against a real database: pending vouchers made on schedule, once, dated their day, and NOTHING
// posted until somebody approves each one.
//   node --require ./utils/testSetup.js --test services/__tests__/recurringVouchers.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_rv_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
let svc, owner, rent, utilities, cash, sales, journal, expense;
const at = (d) => new Date(`${d}T09:00:00.000Z`);
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);
const madeBy = (id) => svc.Voucher.find({ "recurringRef.id": id }).sort({ date: 1 }).lean();
const entriesOf = (voucher) => svc.LedgerEntry.countDocuments({ voucherId: voucher._id });
const balance = async (a) => (await svc.LedgerAccount.findById(a._id).lean()).currentBalance;

test.before(async () => {
  if (skip) return;
  process.env.LOG_SILENT = "1";
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Financial: require("../financial/financialService"),
    Rec: require("../financial/recurringVoucherService"),
    Checks: require("../core/notificationChecksService"),
    Notification: require("../../models/core/notificationModel"),
    RecurringVoucher: require("../../models/modules/financial/recurringVoucherModel"),
    Admin: require("../../models/core/adminModel"),
    FiscalYear: require("../../models/modules/financial/fiscalYearModel"),
    ...require("../../models/modules/financial/financialModels"),
  };
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  owner = await new svc.Admin({ name: "Accountant", email: "acc@test.uae", password: "12312312", type: "super_admin", status: "active", isActive: true }).save();
  const acct = (name) => svc.LedgerAccount.findOne({ accountName: name });
  [rent, utilities, cash, sales] = await Promise.all([acct("Rent Expense"), acct("Utilities"), acct("Cash in Hand"), acct("Sales Revenue")]);
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const by = () => String(owner._id);
const journalBody = (over = {}) => ({
  name: "Prepaid insurance release", kind: "journal", frequency: "monthly", startDay: "2026-01-31", narration: "One month of cover",
  lines: [{ accountId: String(rent._id), debit: 500 }, { accountId: String(cash._id), credit: 500 }], ...over,
});
const expenseBody = (over = {}) => ({
  name: "Office rent", kind: "expense", frequency: "monthly", startDay: "2026-01-05", description: "Office rent", amount: 2000,
  expenseAccountId: String(rent._id), paymentMode: "cash", ...over,
});

test("a template is checked the way a real save is checked", { skip }, async () => {
  await assert.rejects(() => svc.Rec.create(journalBody({ name: "" }), by()), { code: "NAME_REQUIRED" });
  await assert.rejects(() => svc.Rec.create(journalBody({ kind: "payment" }), by()), { code: "INVALID_KIND" });
  await assert.rejects(() => svc.Rec.create(journalBody({ frequency: "daily" }), by()), { code: "INVALID_SCHEDULE" });
  await assert.rejects(() => svc.Rec.create(journalBody(), "system"), { code: "OWNER_REQUIRED" });
  // a journal that could never post
  await assert.rejects(() => svc.Rec.create(journalBody({ lines: [{ accountId: String(rent._id), debit: 500 }, { accountId: String(cash._id), credit: 400 }] }), by()), { code: "UNBALANCED" });
  await assert.rejects(() => svc.Rec.create(journalBody({ lines: [{ accountId: String(rent._id), debit: 500 }] }), by()), { code: "TOO_FEW_LINES" });
  // an expense that could never post
  await assert.rejects(() => svc.Rec.create(expenseBody({ expenseAccountId: String(sales._id) }), by()), { code: "NOT_AN_EXPENSE_ACCOUNT" });
  await assert.rejects(() => svc.Rec.create(expenseBody({ description: "" }), by()), { code: "DESCRIPTION_REQUIRED" });
  // transfer, cheque and card each need something that changes every time
  for (const paymentMode of ["transfer", "cheque", "card", "online"]) {
    await assert.rejects(() => svc.Rec.create(expenseBody({ paymentMode }), by()), { code: "RECURRING_PAYMENT_MODE" }, paymentMode);
  }
  assert.equal(await svc.RecurringVoucher.countDocuments({}), 0, "nothing was stored by a refusal");

  journal = await svc.Rec.create(journalBody({ maxCount: 3 }), by());
  expense = await svc.Rec.create(expenseBody(), by());
  assert.equal(journal.nextRunDay, "2026-01-31");
  assert.equal(journal.totalAmount, 500);
  assert.equal(expense.totalAmount, 2000);
  assert.equal(String(journal.ownerId), by());
  assert.deepEqual(svc.Rec.present(journal).upcoming, ["2026-01-31", "2026-02-28", "2026-03-31"]); // three, and no more: maxCount is 3
});

test("a due run makes ONE pending journal per day, dated that day, numbered JV-, with NOTHING posted", { skip }, async () => {
  const before = await balance(rent);
  const out = await svc.Rec.runDue(at("2026-03-05"));
  assert.ok(out.made >= 4, `journal 2 + expense 3, got ${out.made}`);
  const made = await madeBy(journal._id);
  assert.deepEqual(made.map((v) => dayOf(v.date)), ["2026-01-31", "2026-02-28"]);
  for (const v of made) {
    assert.equal(v.status, "pending");
    assert.equal(v.approvalStatus, "pending");
    assert.equal(v.effectsDeferred, true);
    assert.match(v.voucherNo, /^JV-/);
    assert.equal(v.recurringRef.name, journal.name);
    assert.equal(String(v.createdBy), by());
    assert.match(v.narration, /^Recurring: Prepaid insurance release/);
    assert.equal(await entriesOf(v), 0, "no ledger entries until it is approved");
  }
  assert.equal(await balance(rent), before, "no balance moved");
  const t = await svc.RecurringVoucher.findById(journal._id).lean();
  assert.equal(t.made, 2);
  assert.equal(t.nextRunDay, "2026-03-31");
  assert.equal(t.runs.length, 2);
  assert.equal(String(t.runs[0].voucherId), String(made[0]._id));
});

test("approving a made voucher posts it, once, with balanced entries", { skip }, async () => {
  const [first] = await madeBy(journal._id);
  const before = await balance(rent);
  await svc.Financial.processVoucherApproval(first._id, "approve", owner._id, "ok");
  const after = await svc.Voucher.findById(first._id).lean();
  assert.equal(after.status, "approved");
  const rows = await svc.LedgerEntry.find({ voucherId: first._id }).lean();
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((s, r) => s + (r.debitAmount || 0), 0), rows.reduce((s, r) => s + (r.creditAmount || 0), 0));
  assert.equal(await balance(rent), before + 500);
  await assert.rejects(() => svc.Financial.processVoucherApproval(first._id, "approve", owner._id, "again"));
});

test("a rejected one posts nothing and leaves no trace on the books", { skip }, async () => {
  const [, second] = await madeBy(journal._id);
  const before = await balance(rent);
  await svc.Financial.processVoucherApproval(second._id, "reject", owner._id, "not this month");
  assert.equal((await svc.Voucher.findById(second._id).lean()).status, "rejected");
  assert.equal(await entriesOf(second), 0);
  assert.equal(await balance(rent), before);
});

test("an expense template makes pending EV- vouchers and posts only on approval", { skip }, async () => {
  const made = await madeBy(expense._id);
  assert.deepEqual(made.map((v) => dayOf(v.date)), ["2026-01-05", "2026-02-05", "2026-03-05"]);
  assert.match(made[0].voucherNo, /^EV-/);
  assert.equal(made[0].status, "pending");
  assert.equal(made[0].totalAmount, 2000);
  assert.equal(made[0].paymentMode, "cash");
  assert.equal(await entriesOf(made[0]), 0);
  const rentBefore = await balance(rent);
  await svc.Financial.processVoucherApproval(made[0]._id, "approve", owner._id, "ok");
  const rows = await svc.LedgerEntry.find({ voucherId: made[0]._id }).lean();
  assert.ok(rows.length >= 2);
  assert.equal(await balance(rent), rentBefore + 2000);
});

test("a run repeated at once makes ONE voucher (the claim is a compare-and-set)", { skip }, async () => {
  const t = await svc.Rec.create(expenseBody({ name: "Race", startDay: "2026-04-10" }), by());
  const results = await Promise.allSettled([svc.Rec.runSlot(String(t._id), 0), svc.Rec.runSlot(String(t._id), 0), svc.Rec.runSlot(String(t._id), 0)]);
  assert.equal(results.filter((r) => r.status === "fulfilled" && r.value.made).length, 1);
  assert.equal((await madeBy(t._id)).length, 1);
  assert.equal((await svc.RecurringVoucher.findById(t._id).lean()).made, 1);
});

test("a refused run (a closed month) records why, makes nothing, and is made once the month is open", { skip }, async () => {
  const lease = await svc.Rec.create(expenseBody({ name: "Lease", startDay: "2026-05-10" }), by());
  const year = await svc.FiscalYear.findOne({ startDate: { $lte: new Date("2026-06-30") }, endDate: { $gte: new Date("2026-06-30") } });
  await svc.FiscalYear.updateOne({ _id: year._id }, { $set: { lockedThrough: "2026-05-31" } });
  const out = await svc.Rec.runDue(at("2026-06-15"));
  assert.ok(out.failed >= 1);
  let t = await svc.RecurringVoucher.findById(lease._id).lean();
  assert.equal(t.made, 0);
  assert.equal(t.nextRunDay, "2026-05-10");
  assert.equal(t.lastError.day, "2026-05-10");
  assert.match(t.lastError.message, /closed/i);
  assert.equal((await madeBy(lease._id)).length, 0);
  await svc.Checks.checkRecurringVouchers(at("2026-06-15"));
  assert.ok(await svc.Notification.findOne({ dedupeKey: `recurring_voucher_failed:${lease._id}`, resolvedAt: null }));

  await svc.FiscalYear.updateOne({ _id: year._id }, { $unset: { lockedThrough: 1 } });
  const later = new Date(t.retryAfter.getTime() + 1000);
  await svc.Rec.runDue(later);
  t = await svc.RecurringVoucher.findById(lease._id).lean();
  assert.equal(t.lastError, undefined);
  assert.ok(t.made >= 1);
  await svc.Checks.checkRecurringVouchers(later);
  assert.equal(await svc.Notification.findOne({ dedupeKey: `recurring_voucher_failed:${lease._id}`, resolvedAt: null }), null);
});

test("the waiting notice counts what is pending and closes when it has all been decided", { skip }, async () => {
  const waiting = await svc.Voucher.countDocuments({ status: "pending", "recurringRef.id": { $exists: true } });
  assert.ok(waiting > 0);
  await svc.Checks.checkRecurringVouchers(at("2026-06-16"));
  const row = await svc.Notification.findOne({ kind: "recurring_vouchers_waiting", resolvedAt: null }).lean();
  assert.ok(row);
  assert.equal(row.audience.permission, "finance.approve");
  for (const v of await svc.Voucher.find({ status: "pending", "recurringRef.id": { $exists: true } })) {
    await svc.Financial.processVoucherApproval(v._id, "approve", owner._id, "ok");
  }
  await svc.Checks.checkRecurringVouchers(at("2026-06-17"));
  assert.equal(await svc.Notification.findOne({ kind: "recurring_vouchers_waiting", resolvedAt: null }), null);
});

test("pause skips days, resume carries on, and maxCount ends it", { skip }, async () => {
  const t = await svc.Rec.create(journalBody({ name: "Provision", startDay: "2026-07-01", maxCount: 2 }), by());
  await svc.Rec.runDue(at("2026-07-02"));
  assert.equal((await madeBy(t._id)).length, 1);
  await svc.Rec.pause(t._id, by());
  await svc.Rec.runDue(at("2026-08-15"));
  assert.equal((await madeBy(t._id)).length, 1, "paused: nothing made");
  await svc.Rec.resume(t._id, by());
  const resumed = await svc.RecurringVoucher.findById(t._id).lean();
  assert.equal(resumed.made, 1, "the skipped days did not count");
  assert.equal(resumed.status, "ACTIVE");
  assert.ok(resumed.nextRunDay > "2026-08-01", "the days the pause skipped are not made");
  assert.equal((await madeBy(t._id)).length, 1);
  await svc.Rec.runDue(at("2026-12-02")); // the first day it is due again (a month that is still inside the 2026 fiscal year)
  const done = await svc.RecurringVoucher.findById(t._id).lean();
  assert.equal(done.made, 2);
  assert.equal(done.status, "ENDED");
  await svc.Rec.runDue(at("2026-12-20"));
  assert.equal((await madeBy(t._id)).length, 2, "never more than maxCount");
});

test("editing keeps the count, rechecks the whole payload, and a bad edit changes nothing", { skip }, async () => {
  const t = await svc.Rec.create(journalBody({ name: "Editable", startDay: "2026-10-01" }), by());
  await svc.Rec.runDue(at("2026-10-02"));
  await assert.rejects(() => svc.Rec.update(t._id, { lines: [{ accountId: String(rent._id), debit: 100 }, { accountId: String(cash._id), credit: 90 }] }, by()), { code: "UNBALANCED" });
  assert.equal((await svc.RecurringVoucher.findById(t._id).lean()).lines[0].debit, 500, "the refused edit stored nothing");
  const edited = await svc.Rec.update(t._id, { lines: [{ accountId: String(utilities._id), debit: 250 }, { accountId: String(cash._id), credit: 250 }], frequency: "quarterly" }, by());
  assert.equal(edited.totalAmount, 250);
  assert.equal(edited.made, 1);
  assert.equal(edited.nextRunDay, "2027-01-01", "carries on after the last voucher made, never repeats a date");
});

test("a template whose owner has left is refused with the reason, and saving it again takes it over", { skip }, async () => {
  const gone = await new svc.Admin({ name: "Leaver", email: "gone@test.uae", password: "12312312", type: "super_admin", status: "active", isActive: true }).save();
  const t = await svc.Rec.create(journalBody({ name: "Orphan", startDay: "2026-12-01" }), String(gone._id));
  await svc.Admin.updateOne({ _id: gone._id }, { $set: { isActive: false, status: "inactive" } });
  const out = await svc.Rec.runDue(at("2026-12-02"));
  assert.ok(out.failed >= 1);
  const stuck = await svc.RecurringVoucher.findById(t._id).lean();
  assert.equal(stuck.made, 0);
  assert.match(stuck.lastError.message, /no longer has an active account/);
  await svc.Rec.update(t._id, { name: "Orphan (mine now)" }, by());
  assert.equal(String((await svc.RecurringVoucher.findById(t._id).lean()).ownerId), by());
  await svc.Rec.runDue(new Date(stuck.retryAfter.getTime() + 1000));
  assert.equal((await madeBy(t._id)).length, 1);
});

test("a recurringRef in a body is never stored, and the list can be filtered to the vouchers a template made", { skip }, async () => {
  const forged = await svc.Financial.createVoucher({
    voucherType: "journal", date: at("2026-11-01"), recurringRef: { id: String(journal._id), name: "forged" },
    lines: [{ accountId: rent._id, debit: 10 }, { accountId: cash._id, credit: 10 }],
  }, owner._id);
  assert.equal((await svc.Voucher.findById(forged._id).lean()).recurringRef?.id, undefined);
  const any = await svc.Financial.getAllVouchers({ recurring: "1", limit: 200 });
  assert.ok(any.vouchers.length >= 4);
  assert.ok(any.vouchers.every((v) => v.recurringRef?.id));
  assert.ok(!any.vouchers.some((v) => String(v._id) === String(forged._id)));
  const one = await svc.Financial.getAllVouchers({ recurring: String(journal._id), limit: 200 });
  assert.ok(one.vouchers.every((v) => String(v.recurringRef.id) === String(journal._id)));
  assert.equal(one.vouchers.length, 3, "the journal template ran to its maxCount of 3 over the test");
});

test("deleting a template keeps the vouchers it made", { skip }, async () => {
  const t = await svc.Rec.create(journalBody({ name: "Short lived", startDay: "2026-12-03" }), by());
  await svc.Rec.runDue(at("2026-12-04"));
  assert.equal((await madeBy(t._id)).length, 1);
  await svc.Rec.remove(t._id);
  assert.equal(await svc.RecurringVoucher.findById(t._id), null);
  assert.equal((await madeBy(t._id)).length, 1);
});
