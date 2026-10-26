// The post-dated cheque lifecycle on a throwaway database. Stage 1: presentment (deposit) and hold.
// The recurring point: deposit, hold and resume POST NOTHING - the money stays in "Cheques in Hand" until the cheque clears.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const admin = new mongoose.Types.ObjectId();

let svc, customer, enbd;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Financial: require("../financial/financialService"),
    Cheques: require("../banking/chequeService"),
    Chart: require("../financial/chartOfAccountsService"),
    Recon: require("../banking/reconciliationCore"),
    FiscalYear: require("../core/fiscalYearService"),
    FiscalYearModel: require("../../models/modules/financial/fiscalYearModel"),
    ...require("../../models/modules/banking/bankingModels"),
    ...require("../../models/modules/financial/financialModels"),
    AccountGroup: require("../../models/modules/financial/accountGroupModel"),
    Customer: require("../../models/modules/customerModel"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", creditLimit: 1e6 });
  const bankGroup = await svc.AccountGroup.findOne({ name: "Bank" });
  enbd = await svc.Chart.createAccount({ accountName: "ENBD Current", groupId: bankGroup._id }, {}, admin);
});
test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

// ---- helpers ----
const day = (n = 0) => new Date(Date.now() + n * 86400000);
const balance = async (name) => (await svc.LedgerAccount.findOne({ accountName: name }))?.currentBalance ?? 0;
const entries = () => svc.LedgerEntry.countDocuments({});
let seq = 0;
// A customer's cheque dated `due` days from now, received today. Returns the voucher and its register row.
const cheque = async ({ amount = 100, due = 10, bank = "Mashreq" } = {}) => {
  seq += 1;
  const voucher = await svc.Financial.createVoucher({
    voucherType: "receipt", customerId: customer._id, totalAmount: amount, date: day(),
    paymentMode: "cheque", paymentDetails: { chequeNo: `PDC${1000 + seq}`, chequeDate: day(due), drawnOnBankName: bank, accountId: enbd._id },
  }, admin);
  return { voucher, row: await svc.Cheque.findOne({ voucherId: voucher._id }) };
};
const reread = (row) => svc.Cheque.findById(row._id);

// ---- deposit ----
test("deposit marks the cheque presented and posts NOTHING: the money stays in cheques in hand", { skip }, async () => {
  const { row } = await cheque();
  const hand = await balance("Cheques in Hand");
  const bank = await balance("ENBD Current");
  const before = await entries();

  const done = await svc.Cheques.deposit(row._id, { depositedOn: day(10), slipNo: "SLIP-77" }, {}, admin);
  assert.equal(done.status, "deposited");
  assert.equal(done.depositSlipNo, "SLIP-77");
  assert.ok(done.presentedOn);
  assert.equal(done.history.at(-1).status, "deposited");
  assert.match(done.history.at(-1).note, /slip SLIP-77/);

  assert.equal(await entries(), before, "no ledger row was written");
  assert.equal(await balance("Cheques in Hand"), hand, "still in cheques in hand");
  assert.equal(await balance("ENBD Current"), bank, "not in the bank until it clears");
});

test("the bank will not take a cheque before its date", { skip }, async () => {
  const { row } = await cheque({ due: 10 });
  await assert.rejects(() => svc.Cheques.deposit(row._id, { depositedOn: day(2) }, {}, admin), { code: "CHEQUE_NOT_MATURE" });
  assert.equal((await reread(row)).status, "pending", "a refused deposit changes nothing");
  assert.equal((await reread(row)).presentedOn, null);
});

test("deposit validates its inputs and cannot be done twice", { skip }, async () => {
  const { row } = await cheque({ due: 0 });
  await assert.rejects(() => svc.Cheques.deposit(row._id, { depositedOn: "not a date" }, {}, admin), { code: "INVALID_DATE" });
  await assert.rejects(() => svc.Cheques.deposit(row._id, { slipNo: "x".repeat(41) }, {}, admin), { code: "INVALID_SLIP" });
  await svc.Cheques.deposit(row._id, {}, {}, admin);
  await assert.rejects(() => svc.Cheques.deposit(row._id, {}, {}, admin), { code: "CHEQUE_NOT_PENDING" });
});

test("two people depositing at once: exactly one wins, and the cheque is deposited once", { skip }, async () => {
  const { row } = await cheque({ due: 0 });
  const results = await Promise.allSettled([svc.Cheques.deposit(row._id, {}, {}, admin), svc.Cheques.deposit(row._id, {}, {}, admin)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const lost = results.find((r) => r.status === "rejected");
  assert.ok(["CHEQUE_NOT_PENDING", "CHEQUE_CHANGED"].includes(lost.reason.code), lost.reason.code);
  const fresh = await reread(row);
  assert.equal(fresh.history.filter((h) => h.status === "deposited").length, 1, "one history entry, not two");
});

// ---- hold ----
test("a held cheque needs a reason, cannot be deposited or cleared, and posts nothing", { skip }, async () => {
  const { row } = await cheque({ due: 0 });
  const before = await entries();
  await assert.rejects(() => svc.Cheques.hold(row._id, {}, {}, admin), { code: "REASON_REQUIRED" });
  await assert.rejects(() => svc.Cheques.hold(row._id, { reason: "x".repeat(251) }, {}, admin), { code: "REASON_TOO_LONG" });
  await assert.rejects(() => svc.Cheques.hold(row._id, { reason: "ok", until: "garbage" }, {}, admin), { code: "INVALID_DATE" });

  const held = await svc.Cheques.hold(row._id, { reason: "Customer asked us to wait for a transfer", until: day(5) }, {}, admin);
  assert.equal(held.status, "hold");
  assert.equal(held.holdReason, "Customer asked us to wait for a transfer");
  assert.ok(held.holdUntil);

  await assert.rejects(() => svc.Cheques.deposit(row._id, {}, {}, admin), { code: "CHEQUE_ON_HOLD" });
  await assert.rejects(() => svc.Cheques.clear(row._id, {}, {}, admin), { code: "CHEQUE_ON_HOLD" });
  assert.equal(await entries(), before, "holding posted nothing");
});

test("resume puts the cheque back in play and forgets the hold", { skip }, async () => {
  const { row } = await cheque({ due: 0 });
  await svc.Cheques.hold(row._id, { reason: "wait", until: day(3) }, {}, admin);
  const notHeld = (await cheque()).row;
  await assert.rejects(() => svc.Cheques.resume(notHeld._id, {}, {}, admin), { code: "CHEQUE_NOT_HELD" });
  const back = await svc.Cheques.resume(row._id, {}, {}, admin);
  assert.equal(back.status, "pending");
  assert.equal(back.holdReason, "");
  assert.equal(back.holdUntil, null);
  assert.deepEqual(back.history.map((h) => h.status).slice(-2), ["hold", "pending"]);
  await svc.Cheques.deposit(row._id, {}, {}, admin); // and now it can be deposited
});

// ---- bank reconciliation must still see a deposited cheque, and must not see a held one ----
test("a deposited cheque is still a reconciliation candidate; a held one is not", { skip }, async () => {
  const dep = (await cheque({ due: 0 })).row;
  const held = (await cheque({ due: 0 })).row;
  const pend = (await cheque({ due: 0 })).row;
  await svc.Cheques.deposit(dep._id, {}, {}, admin);
  await svc.Cheques.hold(held._id, { reason: "drawer" }, {}, admin);

  const ids = (await svc.Recon.loadPendingCheques(enbd._id, { req: {} })).map((c) => String(c.chequeId));
  assert.ok(ids.includes(String(dep._id)), "deposited: at the bank, waiting for its statement line - matching it is how it clears");
  assert.ok(ids.includes(String(pend._id)));
  assert.equal(ids.includes(String(held._id)), false, "held: in the drawer on purpose, so not offered as something the bank can have cleared");
  const row = (await svc.Recon.loadPendingCheques(enbd._id, { req: {} })).find((c) => String(c.chequeId) === String(dep._id));
  assert.match(row.narration, /deposited/);
});

// ---- clearing from deposited ----
test("a deposited cheque clears into the bank exactly as a pending one does", { skip }, async () => {
  const { row } = await cheque({ amount: 250, due: 0 });
  await svc.Cheques.deposit(row._id, {}, {}, admin);
  const hand = await balance("Cheques in Hand");
  const bank = await balance("ENBD Current");
  const done = await svc.Cheques.clear(row._id, { clearedOn: day(0) }, {}, admin);
  assert.equal(done.status, "cleared");
  assert.equal(await balance("Cheques in Hand"), hand - 250);
  assert.equal(await balance("ENBD Current"), bank + 250);
  const clearing = await svc.LedgerEntry.find({ voucherId: row.voucherId, voucherType: "cheque_clearance" }).lean();
  assert.equal(clearing.length, 2, "one clearing pair, as before");
});

// ---- the register's summary ----
test("the register's pending-money summary counts hold and deposited, not just pending", { skip }, async () => {
  const baseline = (await svc.Cheques.list({}, {})).summary.receivable;
  const a = (await cheque({ amount: 10, due: 0 })).row;
  const b = (await cheque({ amount: 20, due: 0 })).row;
  const c = (await cheque({ amount: 40, due: 0 })).row;
  await svc.Cheques.deposit(b._id, {}, {}, admin);
  await svc.Cheques.hold(c._id, { reason: "r" }, {}, admin);
  const now = (await svc.Cheques.list({}, {})).summary.receivable;
  assert.equal(now.count - baseline.count, 3);
  assert.equal(now.amount - baseline.amount, 70, "all three are still money not yet in the bank");
  const listed = await svc.Cheques.list({}, { status: "hold" });
  assert.ok(listed.rows.every((r) => r.status === "hold"));
  assert.ok(listed.rows.some((r) => String(r._id) === String(c._id)));
  assert.ok(a);
});

// ---- a cheque at the bank is not ours to withdraw ----
test("a deposited cheque cannot be cancelled or have its voucher deleted, but it can bounce", { skip }, async () => {
  const { voucher, row } = await cheque({ amount: 300, due: 0 });
  await svc.Cheques.deposit(row._id, {}, {}, admin);
  await assert.rejects(() => svc.Cheques.cancel(row._id, {}, {}, admin), { code: "CHEQUE_WITH_BANK" });
  await assert.rejects(() => svc.Financial.deleteVoucher(voucher._id, admin), { code: "CHEQUE_WITH_BANK" });
  assert.equal((await reread(row)).status, "deposited", "the refusals changed nothing");

  const hand = await balance("Cheques in Hand");
  const bounced = await svc.Cheques.bounce(row._id, { reason: "Insufficient funds" }, {}, admin);
  assert.equal(bounced.status, "bounced");
  assert.equal(await balance("Cheques in Hand"), hand - 300, "the whole voucher was reversed");
  assert.equal((await svc.Voucher.findById(voucher._id)).status, "bounced");
});

test("a held cheque can be withdrawn, and a cheque on hold or at the bank keeps its number", { skip }, async () => {
  const held = (await cheque({ due: 0 })).row;
  const atBank = (await cheque({ due: 0 })).row;
  await svc.Cheques.hold(held._id, { reason: "drawer" }, {}, admin);
  await svc.Cheques.deposit(atBank._id, {}, {}, admin);

  const again = (row) => svc.Financial.createVoucher({
    voucherType: "receipt", customerId: customer._id, totalAmount: 100, date: day(), paymentMode: "cheque",
    paymentDetails: { chequeNo: row.chequeNo, chequeDate: day(0), drawnOnBankName: row.drawnOnBankName, accountId: enbd._id },
  }, admin);
  await assert.rejects(() => again(held), { code: "DUPLICATE_CHEQUE" });
  await assert.rejects(() => again(atBank), { code: "DUPLICATE_CHEQUE" });

  const withdrawn = await svc.Cheques.cancel(held._id, {}, {}, admin);
  assert.equal(withdrawn.status, "cancelled");
  await again(held); // the number is free once the first is closed
});

// ---- bulk ----
test("bulk deposit: the good ones go through and every failure says why", { skip }, async () => {
  const a = (await cheque({ due: 0 })).row;
  const b = (await cheque({ due: 0 })).row;
  const future = (await cheque({ due: 30 })).row;
  const held = (await cheque({ due: 0 })).row;
  await svc.Cheques.hold(held._id, { reason: "r" }, {}, admin);

  const out = await svc.Cheques.bulk("deposit", [a._id, b._id, future._id, held._id, "not-an-id", String(a._id)], { slipNo: "BULK-1" }, {}, admin);
  assert.deepEqual(out.successful.map((s) => s.id).sort(), [String(a._id), String(b._id)].sort(), "a repeated id is done once");
  const codes = Object.fromEntries(out.failed.map((f) => [f.id, f.code]));
  assert.equal(codes[String(future._id)], "CHEQUE_NOT_MATURE");
  assert.equal(codes[String(held._id)], "CHEQUE_ON_HOLD");
  assert.equal(codes["not-an-id"], "INVALID_ID");
  assert.equal((await reread(a)).depositSlipNo, "BULK-1");
  assert.equal((await reread(future)).status, "pending", "a failure left its cheque alone");

  const cleared = await svc.Cheques.bulk("clear", [a._id, b._id], { on: day(0) }, {}, admin);
  assert.equal(cleared.successful.length, 2);
  assert.equal(cleared.failed.length, 0);
});

test("bulk is bounded and will not bounce", { skip }, async () => {
  await assert.rejects(() => svc.Cheques.bulk("bounce", ["x"], {}, {}, admin), { code: "INVALID_ACTION" });
  await assert.rejects(() => svc.Cheques.bulk("deposit", [], {}, {}, admin), { code: "NO_CHEQUES" });
  await assert.rejects(() => svc.Cheques.bulk("deposit", "nope", {}, {}, admin), { code: "NO_CHEQUES" });
  const many = Array.from({ length: 201 }, () => String(new mongoose.Types.ObjectId()));
  await assert.rejects(() => svc.Cheques.bulk("deposit", many, {}, {}, admin), { code: "BULK_TOO_LARGE" });
});

// ---- the period lock ----
test("a cheque may be deposited in a closed period (nothing posts) but not cleared (a clearance posts)", { skip }, async () => {
  const { row } = await cheque({ due: 0 });
  const fy = await svc.FiscalYearModel.findOne();
  await svc.FiscalYear.setStatus(fy._id, "closed");
  try {
    const done = await svc.Cheques.deposit(row._id, { depositedOn: day(0) }, {}, admin);
    assert.equal(done.status, "deposited", "presenting a cheque posts nothing, so the lock has nothing to protect");
    await assert.rejects(() => svc.Cheques.clear(row._id, { clearedOn: day(0) }, {}, admin), { code: "PERIOD_CLOSED" });
    assert.equal((await reread(row)).status, "deposited");
  } finally {
    await svc.FiscalYear.setStatus(fy._id, "open");
  }
});

// ======================================================================================================
// Stage 2: the dishonour. A bounce records the bank's memo, can post the bank's charge and charge the customer
// back - all inside the bounce's own transaction, so a refusal anywhere leaves everything as it was.
// ======================================================================================================
const legsOf = async (voucherId) => (await svc.LedgerEntry.find({ voucherId, isReversed: { $ne: true } }).lean())
  .map((e) => `${e.accountName}:${e.debitAmount ? "Dr" + e.debitAmount : "Cr" + e.creditAmount}`).sort();
const limited = (limit) => ({ admin: { id: String(admin), name: "junior", role: { approvalLimit: limit }, grants: [] } });
const voucherCount = (type) => svc.Voucher.countDocuments({ voucherType: type });

test("a bounce records the bank's memo and reverses the whole voucher", { skip }, async () => {
  const { voucher, row } = await cheque({ amount: 400, due: 0 });
  const hand = await balance("Cheques in Hand");
  const done = await svc.Cheques.bounce(row._id, { reasonCode: "insufficient_funds", memoDate: day(0), memoRef: "RM-1", certificateRef: "CERT-9" }, {}, admin);
  assert.equal(done.status, "bounced");
  assert.equal(done.reason, "Insufficient funds", "a code alone is worded from the list");
  assert.deepEqual([done.returnMemo.reasonCode, done.returnMemo.memoRef, done.certificateRef], ["insufficient_funds", "RM-1", "CERT-9"]);
  assert.ok(done.returnMemo.memoDate && done.bouncedOn);
  assert.equal(await balance("Cheques in Hand"), hand - 400);
  assert.equal((await svc.Voucher.findById(voucher._id)).status, "bounced");
});

test("bad input is refused before anything is opened: the cheque stays as it was", { skip }, async () => {
  const { row } = await cheque({ due: 0 });
  for (const [input, code] of [
    [{}, "REASON_REQUIRED"], [{ reasonCode: "nope" }, "RETURN_REASON_INVALID"], [{ reason: "r", bankCharge: { amount: -1 } }, "INVALID_CHARGE"],
    [{ reason: "r", memoDate: "2099-01-01" }, "INVALID_DATE"], [{ reason: "r", partialAmount: 9999 }, "INVALID_PARTIAL"],
    [{ reason: "r", recharge: { amount: 5 } }, "ACCOUNT_REQUIRED"], [{ reason: "r", on: "garbage" }, "INVALID_DATE"],
  ]) await assert.rejects(() => svc.Cheques.bounce(row._id, input, {}, admin), { code }, code);
  assert.equal((await reread(row)).status, "pending");
});

test("the bank's charge posts as an expense out of the cheque's own bank account", { skip }, async () => {
  const { row } = await cheque({ amount: 300, due: 0 });
  const bank = await balance("ENBD Current");
  const done = await svc.Cheques.bounce(row._id, { reason: "Insufficient funds", bankCharge: { amount: 52.5 } }, {}, admin);
  assert.equal(done.charges.amount, 52.5);
  const fee = await svc.Voucher.findById(done.charges.expenseVoucherId);
  assert.equal(fee.voucherType, "expense");
  assert.match(done.charges.expenseVoucherNo, /^EV-/);
  assert.deepEqual(await legsOf(fee._id), ["Bank Charges:Dr52.5", "ENBD Current:Cr52.5"]);
  assert.equal(await balance("ENBD Current"), bank - 52.5, "the bank took the fee");
});

test("the bank's charge with VAT: the gross is split, and the VAT lands on its own account", { skip }, async (t) => {
  const code = await svc.TaxCode.findOne({ isActive: true, isDefault: true });
  if (!code) return t.skip("this organisation has no default tax code, so there is nothing to split"); // said aloud, never a silent pass
  const { row } = await cheque({ amount: 300, due: 0 });
  const done = await svc.Cheques.bounce(row._id, { reason: "r", bankCharge: { amount: 105, taxCodeId: String(code._id) } }, {}, admin);
  const legs = await legsOf(done.charges.expenseVoucherId);
  assert.ok(legs.includes("ENBD Current:Cr105"), `the bank was charged the gross: ${legs}`);
  assert.ok(legs.some((l) => /^Bank Charges:Dr100$/.test(l)), `the net is the expense: ${legs}`);
  assert.equal(legs.length, 3, "plus one VAT leg");
});

test("charging it back: a debit note on the customer, credited to the account you choose", { skip }, async () => {
  const income = await svc.LedgerAccount.findOne({ accountName: "Other Income" });
  const { row } = await cheque({ amount: 300, due: 0 });
  const done = await svc.Cheques.bounce(row._id, { reason: "r", recharge: { amount: 60, accountId: String(income._id), description: "Bounce fee" } }, {}, admin);
  assert.equal(done.charges.rechargeAmount, 60);
  assert.equal((await svc.Voucher.findById(done.charges.rechargeVoucherId)).voucherType, "debit_note");
  assert.deepEqual(await legsOf(done.charges.rechargeVoucherId), ["Customer - Al Noor:Dr60", "Other Income:Cr60"]);
  assert.equal(done.charges.expenseVoucherId, undefined, "no bank charge was asked for");
});

test("ALL OR NOTHING: if the charge-back is refused, the bounce and the bank charge are rolled back with it", { skip }, async () => {
  const { voucher, row } = await cheque({ amount: 300, due: 0 });
  const hand = await balance("Cheques in Hand");
  const bank = await balance("ENBD Current");
  const expenses = await voucherCount("expense");
  const notes = await voucherCount("debit_note");
  const ghost = String(new mongoose.Types.ObjectId()); // an account that does not exist
  await assert.rejects(() => svc.Cheques.bounce(row._id, { reason: "r", bankCharge: { amount: 10 }, recharge: { amount: 5, accountId: ghost } }, {}, admin));
  assert.equal((await reread(row)).status, "pending", "the cheque was not marked bounced");
  assert.equal((await svc.Voucher.findById(voucher._id)).status, "approved", "its voucher was not reversed");
  assert.equal(await balance("Cheques in Hand"), hand);
  assert.equal(await balance("ENBD Current"), bank, "the bank charge, posted first, was undone");
  assert.equal(await voucherCount("expense"), expenses, "no orphan bank-charge voucher");
  assert.equal(await voucherCount("debit_note"), notes);
});

test("a charge that needs an approver stops the whole bounce, and says the charge is why", { skip }, async () => {
  const { row } = await cheque({ amount: 300, due: 0 });
  const hand = await balance("Cheques in Hand");
  await assert.rejects(
    () => svc.Cheques.bounce(row._id, { reason: "r", bankCharge: { amount: 800 } }, limited(500), admin),
    (err) => { assert.equal(err.code, "APPROVAL_LIMIT_EXCEEDED"); assert.match(err.message, /not marked bounced, because its charge needs an approver/); return true; }
  );
  assert.equal((await reread(row)).status, "pending");
  assert.equal(await balance("Cheques in Hand"), hand);
  // the same charge inside the person's limit goes through
  const done = await svc.Cheques.bounce(row._id, { reason: "r", bankCharge: { amount: 80 } }, limited(500), admin);
  assert.equal(done.status, "bounced");
});

test("a part payment is recorded as a fact: the cheque still reverses in full, and no receipt is invented", { skip }, async () => {
  const { row } = await cheque({ amount: 400, due: 0 });
  const hand = await balance("Cheques in Hand");
  const receipts = await voucherCount("receipt");
  const done = await svc.Cheques.bounce(row._id, { reason: "Part paid by the bank", partialAmount: 150, partialOn: day(0) }, {}, admin);
  assert.equal(done.partialPayment.amount, 150);
  assert.equal(await balance("Cheques in Hand"), hand - 400, "the whole cheque came off, not just the unpaid part");
  assert.equal(await voucherCount("receipt"), receipts, "the 150 is for a person to enter as an ordinary receipt");
});

test("a bounce works from hold too, and a bounced cheque cannot bounce again", { skip }, async () => {
  const { row } = await cheque({ due: 0 });
  await svc.Cheques.hold(row._id, { reason: "drawer" }, {}, admin);
  assert.equal((await svc.Cheques.bounce(row._id, { reason: "r" }, {}, admin)).status, "bounced");
  await assert.rejects(() => svc.Cheques.bounce(row._id, { reason: "r" }, {}, admin), { code: "CHEQUE_NOT_PENDING" });
});

// ---- handed back to the party ----
test("handing a cheque back reverses its voucher, reads 'returned', and the voucher reads cancelled - no new voucher status", { skip }, async () => {
  const { voucher, row } = await cheque({ amount: 250, due: 20 });
  const hand = await balance("Cheques in Hand");
  await assert.rejects(() => svc.Cheques.giveBack(row._id, {}, {}, admin), { code: "REASON_REQUIRED" });
  await assert.rejects(() => svc.Cheques.giveBack(row._id, { reason: "r", bankCharge: { amount: 5 } }, {}, admin), { code: "CHARGE_NOT_APPLICABLE" });
  const done = await svc.Cheques.giveBack(row._id, { reason: "Customer replaced it with a transfer" }, {}, admin);
  assert.equal(done.status, "returned");
  assert.ok(done.returnedOn);
  assert.equal(done.reason, "Customer replaced it with a transfer");
  assert.equal((await svc.Voucher.findById(voucher._id)).status, "cancelled", "the voucher status vocabulary did not grow");
  assert.equal(await balance("Cheques in Hand"), hand - 250);
});

test("a cheque at the bank cannot be handed back; one on hold can; the number is free afterwards", { skip }, async () => {
  const atBank = (await cheque({ due: 0 })).row;
  await svc.Cheques.deposit(atBank._id, {}, {}, admin);
  await assert.rejects(() => svc.Cheques.giveBack(atBank._id, { reason: "r" }, {}, admin), { code: "CHEQUE_WITH_BANK" });

  const held = (await cheque({ due: 0 })).row;
  await svc.Cheques.hold(held._id, { reason: "drawer" }, {}, admin);
  assert.equal((await svc.Cheques.giveBack(held._id, { reason: "r" }, {}, admin)).status, "returned");
  await svc.Financial.createVoucher({
    voucherType: "receipt", customerId: customer._id, totalAmount: 100, date: day(), paymentMode: "cheque",
    paymentDetails: { chequeNo: held.chequeNo, chequeDate: day(0), drawnOnBankName: held.drawnOnBankName, accountId: enbd._id },
  }, admin); // the same number again: the first is closed
});

test("a bounce dated in a closed period is refused and takes its charges with it", { skip }, async () => {
  const { row } = await cheque({ due: 0 });
  const expenses = await voucherCount("expense");
  const fy = await svc.FiscalYearModel.findOne();
  await svc.FiscalYear.setStatus(fy._id, "closed");
  try {
    await assert.rejects(() => svc.Cheques.bounce(row._id, { reason: "r", bankCharge: { amount: 10 } }, {}, admin), { code: "PERIOD_CLOSED" });
  } finally {
    await svc.FiscalYear.setStatus(fy._id, "open");
  }
  assert.equal((await reread(row)).status, "pending");
  assert.equal(await voucherCount("expense"), expenses);
});

// ======================================================================================================
// The maturity report and the forward view, over a scenario of its own: its own bank account, so the figures are
// exactly the cheques made here and the filter by account is exercised.
// ======================================================================================================
let rep; // { bank, vendor }
const reportCheque = async ({ direction = "receipt", amount, due, tag }) => {
  seq += 1;
  const chq = { chequeNo: `RPT${1000 + seq}`, chequeDate: day(due), accountId: rep.bank._id, ...(direction === "receipt" ? { drawnOnBankName: "Mashreq" } : {}) };
  const voucher = direction === "receipt"
    ? await svc.Financial.createVoucher({ voucherType: "receipt", customerId: customer._id, totalAmount: amount, date: day(), paymentMode: "cheque", paymentDetails: chq }, admin)
    : await svc.Financial.createVoucher({ voucherType: "payment", vendorId: rep.vendor._id, totalAmount: amount, date: day(), paymentMode: "cheque", paymentDetails: chq }, admin);
  return svc.Cheque.findOne({ voucherId: voucher._id });
};

test("the maturity report: by how far away, with hold and the bank kept apart", { skip }, async () => {
  const bankGroup = await svc.AccountGroup.findOne({ name: "Bank" });
  rep = {
    bank: await svc.Chart.createAccount({ accountName: "Report Bank", groupId: bankGroup._id }, {}, admin),
    vendor: await mongoose.model("Vendor").create({ vendorId: "V9", vendorName: "Report Vendor", contactPerson: "x", address: "y" }),
  };
  await reportCheque({ amount: 500, due: 3 });
  await reportCheque({ amount: 200, due: -5 });
  const held = await reportCheque({ amount: 70, due: 0 });
  const atBank = await reportCheque({ amount: 40, due: -1 });
  await reportCheque({ direction: "payment", amount: 300, due: 10 });
  await svc.Cheques.hold(held._id, { reason: "wait" }, {}, admin);
  await svc.Cheques.deposit(atBank._id, {}, {}, admin);

  const ChequeReports = require("../banking/chequeReportService");
  const m = await ChequeReports.maturity({ bankAccountId: String(rep.bank._id) });
  const g = Object.fromEntries(m.groups.map((x) => [x.key, x]));
  assert.deepEqual(m.groups.map((x) => x.key), ["overdue", "today", "week", "month"]);
  assert.equal(g.overdue.receivable.amount, 240, "the 200 overdue and the 40 at the bank (still money not yet in)");
  assert.deepEqual([g.today.receivable.amount, g.today.onHold.amount], [0, 70], "held: shown, not expected");
  assert.equal(g.week.receivable.amount, 500);
  assert.equal(g.month.payable.amount, 300);
  assert.deepEqual([m.totals.receivable.amount, m.totals.payable.amount, m.totals.onHold.amount, m.totals.net], [740, 300, 70, 440]);
  assert.deepEqual(m.atBank, { count: 1, amount: 40 });
  assert.equal(m.rows.length, 5);
  assert.equal(m.rows[0].chequeDay < m.rows.at(-1).chequeDay, true, "nearest first");
  assert.equal(m.capped, false);
});

test("the maturity report filters by direction and party, and groups by party and bank", { skip }, async () => {
  const ChequeReports = require("../banking/chequeReportService");
  const bank = String(rep.bank._id);
  const outs = await ChequeReports.maturity({ bankAccountId: bank, direction: "payment" });
  assert.deepEqual([outs.totals.payable.amount, outs.totals.receivable.amount], [300, 0]);
  const byParty = await ChequeReports.maturity({ bankAccountId: bank, groupBy: "party" });
  assert.deepEqual(byParty.groups.map((x) => x.label), ["Al Noor", "Report Vendor"], "biggest first");
  const byBank = await ChequeReports.maturity({ bankAccountId: bank, groupBy: "bank" });
  assert.deepEqual(byBank.groups.map((x) => x.label), ["Report Bank"]);
  const one = await ChequeReports.maturity({ partyId: String(rep.vendor._id), bankAccountId: bank });
  assert.equal(one.rows.length, 1);
});

test("the forward view: due cheques come off the opening balance, then week by week", { skip }, async () => {
  const ChequeReports = require("../banking/chequeReportService");
  const f = await ChequeReports.forward({ bankAccountId: String(rep.bank._id), unit: "week", count: 3 });
  const opening = (await svc.LedgerAccount.findById(rep.bank._id)).currentBalance;
  assert.equal(f.openingKnown, true);
  assert.equal(f.opening, opening);
  assert.equal(f.due.net, 240);
  assert.deepEqual(f.periods.map((p) => [p.receipts.amount, p.payments.amount, p.onHold.amount]), [[500, 0, 70], [0, 300, 0], [0, 0, 0]]);
  assert.deepEqual(f.periods.map((p) => p.closing), [opening + 740, opening + 440, opening + 440]);
  assert.equal(f.totals.closing, opening + 440);
  const months = await ChequeReports.forward({ bankAccountId: String(rep.bank._id), unit: "month", count: 2 });
  assert.equal(months.periods.length, 2);
  assert.equal(months.totals.receipts, 740);
});

test("in a branch view the cheques are the branch's, so the whole organisation's bank balance is not put beside them", { skip }, async () => {
  const ChequeReports = require("../banking/chequeReportService");
  const tenant = require("../../utils/tenantContext");
  const f = await tenant.runWithTenant({ companyId: "default", branchId: "main", branchView: "main" }, () => ChequeReports.forward({ bankAccountId: String(rep.bank._id) }));
  assert.equal(f.openingKnown, false);
  assert.equal(f.opening, 0);
});

test("a report refuses what it cannot answer, and says why", { skip }, async () => {
  const R = require("../banking/chequeReportService");
  await assert.rejects(() => R.maturity({ asOn: "26/10/2026" }), { code: "INVALID_DATE" });
  await assert.rejects(() => R.maturity({ asOn: "2026-02-30" }), { code: "INVALID_DATE" });
  await assert.rejects(() => R.maturity({ direction: "sideways" }), { code: "INVALID_DIRECTION" });
  await assert.rejects(() => R.maturity({ partyId: "nope" }), { code: "INVALID_INPUT" });
  await assert.rejects(() => R.forward({ count: 0 }), { code: "INVALID_PERIODS" });
  await assert.rejects(() => R.forward({ count: 53 }), { code: "INVALID_PERIODS" });
  await assert.rejects(() => R.forward({ count: "x" }), { code: "INVALID_PERIODS" });
});

test("ROUTE ORDER: the fixed report paths are registered above '/cheques/:id', or ':id' would swallow them", { skip }, () => {
  const stack = require("../../routes/banking/bankingRoutes").stack.filter((l) => l.route && l.route.methods.get).map((l) => l.route.path);
  const at = (p) => stack.indexOf(p);
  assert.ok(at("/cheques/maturity") > -1 && at("/cheques/forward") > -1 && at("/cheques/:id") > -1, stack.join(" "));
  assert.ok(at("/cheques/maturity") < at("/cheques/:id"));
  assert.ok(at("/cheques/forward") < at("/cheques/:id"));
});
