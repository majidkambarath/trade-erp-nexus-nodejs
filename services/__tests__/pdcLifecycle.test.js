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
