// Payment reminders against a real database (console provider): who is owed one, that each step goes out exactly once, that a setup fault
// gives the claim back, the allowance, the automatic pass and its notice.
//   node --require ./utils/testSetup.js --test services/__tests__/paymentReminders.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let svc, admin, rice, vendor;

test.before(async () => {
  if (skip) return;
  process.env.LOG_SILENT = "1";
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Tx: require("../orderPurchase/transactionService"),
    Msg: require("../messaging/messagingService"),
    R: require("../messaging/paymentReminderService"),
    M: require("../../models/modules/messagingModels"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    Admin: require("../../models/core/adminModel"),
    Notification: require("../../models/core/notificationModel"),
    ActivityLog: require("../../models/modules/financial/activityLogModel"),
    CompanySettings: require("../../models/modules/financial/companySettingsModel"),
    days: require("../../utils/documentExpiry"),
  };
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  await settings({ enabled: true, provider: "console", fromEmail: "accounts@harbour.ae", fromName: "Harbour", retryMax: 3, dailyLimit: 200, attachPdf: true, shareEnabled: true });
  admin = await new svc.Admin({ name: "Boss", email: "boss@test.uae", password: "12312312", type: "super_admin", status: "active", isActive: true, companyInfo: { companyName: "Harbour Trading LLC" } }).save();
  await svc.CompanySettings.updateOne({}, { $set: { "profile.trn": "100999888700003" } }, { upsert: true });
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Vend", contactPerson: "x", address: "y" });
  rice = await svc.Stock.create({ itemId: "ITM1", sku: "SKU1", itemName: "Basmati Rice 5kg", category: new mongoose.Types.ObjectId(), purchasePrice: 7 });
  const buy = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [L(5000, 10)] }, "t");
  await svc.Tx.processTransaction(buy._id, "approve", "t");
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const settings = (set) => svc.M.MessagingSettings.updateOne({ companyId: "default" }, { $set: set }, { upsert: true });
const L = (qty, price) => ({ itemId: rice._id, description: rice.itemName, qty, price, rate: price, vatPercent: 5 });
const ymd = (n = 0) => svc.days.addDays(svc.days.todayInOrg(), n);
const reqOf = () => ({ admin: { id: String(admin._id), name: "Boss", email: "boss@test.uae" }, headers: {}, get: () => undefined });
let seq = 0;

// A customer with an approved invoice whose due day is `late` days ago (negative = in the future), stored on the invoice itself.
async function owing({ late = 7, email, over = {}, customer = {} } = {}) {
  seq += 1;
  const c = await svc.Customer.create({ customerId: `C${seq}`, customerName: `Customer ${seq}`, contactPerson: "Ali", email: email === undefined ? `acct${seq}@client${seq}.ae` : email, phone: "050 111 2222", billingAddress: "Al Quoz", creditLimit: 999999, ...customer });
  const order = await svc.Tx.createTransaction({ type: "sales_order", partyId: c._id, partyType: "Customer", partyTypeRef: "Customer", items: [L(10, 20)], ...over }, "t");
  const so = await svc.Tx.processTransaction(order._id, "approve", "t");
  // made a month ago, so "the day it was made" never hides it; due `late` days ago
  await svc.Transaction.updateOne({ _id: so._id }, { $set: { date: new Date(`${ymd(-40)}T00:00:00.000Z`), dueDate: new Date(`${ymd(-late)}T00:00:00.000Z`) } });
  return { customer: c, id: String(so._id), no: so.invoiceNumber || so.transactionNo };
}
const items = (plan) => plan.rows.map((r) => ({ invoiceId: r.invoiceId, step: r.step }));
const rowFor = (plan, id) => plan.rows.find((r) => r.invoiceId === id);
const remindersOf = (id) => svc.M.DocumentSend.find({ sourceId: id, purpose: "reminder" }).lean();

test("who is owed a reminder: an open, approved, non-opening invoice with a customer who can be written to", { skip }, async () => {
  const late = await owing({ late: 7 });
  const optedOut = await owing({ late: 7, customer: { remindersOff: true } });
  const noEmail = await owing({ late: 7, email: "" });
  const paid = await owing({ late: 7 });
  await svc.Transaction.updateOne({ _id: paid.id }, { $set: { outstandingAmount: 0, paidAmount: 210 } });
  const today = await owing({ late: 7 });
  await svc.Transaction.updateOne({ _id: today.id }, { $set: { date: new Date(`${ymd(0)}T00:00:00.000Z`) } }); // made today
  const future = await owing({ late: -20 });
  await settings({ "reminders.mode": "review" });

  const plan = await svc.R.plan();
  const row = rowFor(plan, late.id);
  assert.ok(row, "the overdue invoice is listed");
  assert.equal(row.step, 7);
  assert.equal(row.stage, "overdue");
  assert.equal(row.daysLate, 7);
  assert.equal(row.to, late.customer.email);
  assert.equal(row.outstanding, 210); // 10 x 20 + 5% VAT
  for (const hidden of [optedOut, noEmail, paid, today, future]) assert.equal(rowFor(plan, hidden.id), undefined);
  assert.ok(plan.skipped.optedOut >= 1);
  assert.ok(plan.skipped.noEmail >= 1);
});

test("a reminder goes out once: the email, its record, the invoice's own summary, and the audit row", { skip }, async () => {
  const inv = await owing({ late: 7 });
  const before = await svc.Transaction.findById(inv.id).lean();
  assert.equal(before.lastSend, undefined);
  const plan = await svc.R.plan();
  const out = await svc.R.sendMany({ items: [{ invoiceId: inv.id, step: 7 }], req: reqOf(), by: String(admin._id), byName: "Boss" });
  assert.equal(out.sent.length, 1);
  assert.equal(out.sent[0].recordedOnly, true, "the console provider says it sent nothing");
  const rows = await remindersOf(inv.id);
  assert.equal(rows.length, 1);
  const [log] = rows;
  assert.equal(log.status, "SENT");
  assert.equal(log.reminderStep, "late7");
  assert.equal(log.idempotencyKey, `reminder:${inv.id}:late7`);
  assert.match(log.subject, /^Overdue payment: /);
  assert.match(log.bodyPreview, /7 days overdue/);
  assert.equal(log.attachment, undefined, "no PDF");
  const after = await svc.Transaction.findById(inv.id).lean();
  assert.equal(after.lastReminder.step, "late7");
  assert.equal(after.lastSend, undefined, "the invoice itself was not 'sent'");
  const audit = await svc.ActivityLog.findOne({ action: "PAYMENT_REMINDER_SENT", entityId: inv.id }).lean();
  assert.ok(audit);
  assert.match(audit.summary, /7 days overdue/);
  assert.equal(audit.after.step, "late7");
  assert.ok(plan.rows.length >= 1);
});

test("the same step is never sent twice: not on a second press, not when two presses race", { skip }, async () => {
  const inv = await owing({ late: 14 });
  const item = [{ invoiceId: inv.id, step: 14 }];
  const [a, b] = await Promise.all([svc.R.sendMany({ items: item, req: reqOf() }), svc.R.sendMany({ items: item, req: reqOf() })]);
  assert.equal(a.sent.length + b.sent.length, 1, "exactly one of the two sent it");
  assert.equal((await remindersOf(inv.id)).length, 1);
  const again = await svc.R.sendMany({ items: item, req: reqOf() });
  assert.equal(again.sent.length, 0);
  assert.equal(again.skipped[0].reason, "NOT_DUE");
  assert.equal(rowFor(await svc.R.plan(), inv.id), undefined, "and it is no longer on the list");
});

test("the screen's list is checked again at the server: a step it was not owed is refused, not sent", { skip }, async () => {
  const inv = await owing({ late: 7 });
  const out = await svc.R.sendMany({ items: [{ invoiceId: inv.id, step: 0 }, { invoiceId: inv.id, step: 30 }], req: reqOf() });
  assert.equal(out.sent.length, 0);
  assert.deepEqual(out.skipped.map((s) => s.reason), ["NOT_DUE", "NOT_DUE"]);
  assert.equal((await remindersOf(inv.id)).length, 0);
  // an invoice paid between the screen and the press
  const paid = await owing({ late: 7 });
  await svc.Transaction.updateOne({ _id: paid.id }, { $set: { outstandingAmount: 0 } });
  assert.equal((await svc.R.sendMany({ items: [{ invoiceId: paid.id, step: 7 }], req: reqOf() })).sent.length, 0);
  // junk ids and steps are dropped, never thrown on
  const junk = await svc.R.sendMany({ items: [{ invoiceId: "nope", step: 7 }, { invoiceId: inv.id, step: "x" }, null], req: reqOf() });
  assert.deepEqual([junk.sent.length, junk.failed.length, junk.skipped.length], [0, 0, 0]);
});

test("a fault that would stop every send gives the claim back and stops the pass; the same step goes once it is fixed", { skip }, async () => {
  const bad = await owing({ late: 7, email: "authfail@client.ae" });
  const next = await owing({ late: 7 });
  const out = await svc.R.sendMany({ items: [{ invoiceId: bad.id, step: 7 }, { invoiceId: next.id, step: 7 }], req: reqOf() });
  assert.equal(out.stopped, "PROVIDER_AUTH");
  assert.equal(out.failed.length, 1);
  assert.equal(out.sent.length, 0, "the pass stopped before the second");
  assert.equal((await remindersOf(next.id)).length, 0, "the second was never claimed");
  const [row] = await remindersOf(bad.id);
  assert.match(row.idempotencyKey, /^released:/, "the claim was given back");
  assert.equal(row.reminderStep, null);
  assert.ok(rowFor(await svc.R.plan(), bad.id), "so it is owed again");
  await svc.Customer.updateOne({ _id: bad.customer._id }, { $set: { email: "fixed@client.ae" } });
  const retry = await svc.R.sendMany({ items: [{ invoiceId: bad.id, step: 7 }], req: reqOf() });
  assert.equal(retry.sent.length, 1);
});

test("a refusal about one invoice's address keeps its claim: it is not retried every day and does not stop the others", { skip }, async () => {
  const badAddress = await owing({ late: 7, email: "badaddr@client.ae" });
  const fine = await owing({ late: 7 });
  const out = await svc.R.sendMany({ items: [{ invoiceId: badAddress.id, step: 7 }, { invoiceId: fine.id, step: 7 }], req: reqOf() });
  assert.equal(out.stopped, null);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].code, "INVALID_ADDRESS");
  assert.equal(out.sent.length, 1);
  assert.equal(rowFor(await svc.R.plan(), badAddress.id), undefined, "the claim stands, so it is not offered again");
});

test("sending switched off, or not set up, refuses the whole call and claims nothing", { skip }, async () => {
  const inv = await owing({ late: 7 });
  await settings({ enabled: false });
  await assert.rejects(() => svc.R.sendMany({ items: [{ invoiceId: inv.id, step: 7 }], req: reqOf() }), { code: "MESSAGING_DISABLED" });
  await settings({ enabled: true, provider: "resend", fromEmail: "" });
  await assert.rejects(() => svc.R.sendMany({ items: [{ invoiceId: inv.id, step: 7 }], req: reqOf() }), { code: "MESSAGING_NOT_CONFIGURED" });
  await settings({ provider: "console", fromEmail: "accounts@harbour.ae" });
  assert.equal((await remindersOf(inv.id)).length, 0);
});

test("reminders never take the last fifth of the daily allowance", { skip }, async () => {
  await settings({ dailyLimit: 5 }); // room = floor(5 x 0.8) - used
  const used = await svc.R.allowance({ dailyLimit: 5 });
  const invoices = [];
  for (let i = 0; i < 6; i += 1) invoices.push(await owing({ late: 7 }));
  const out = await svc.R.sendMany({ items: invoices.map((i) => ({ invoiceId: i.id, step: 7 })), req: reqOf() });
  assert.equal(out.sent.length, used.room);
  assert.equal(out.skipped.filter((s) => s.reason === "ALLOWANCE").length, 6 - used.room);
  assert.equal(out.stopped, "ALLOWANCE");
  await settings({ dailyLimit: 200 });
});

test("settings: validated, kept apart from the Sending form, and automatic needs sending on and starts tomorrow", { skip }, async () => {
  await assert.rejects(() => svc.R.updateSettings({ steps: [0, 0.5] }), { code: "INVALID_REMINDER_SETTINGS" });
  await assert.rejects(() => svc.R.updateSettings({ mode: "always" }), { code: "INVALID_REMINDER_SETTINGS" });
  const r = await svc.R.updateSettings({ mode: "review", steps: [7, 0, -2], sendHour: 8 });
  assert.deepEqual(r.after.steps, [-2, 0, 7]);
  assert.equal(r.after.sendHour, 8);
  // the Sending form saves the whole document: it must not lose the reminders
  const Settings = require("../messaging/settingsService");
  await Settings.update({ signature: "Thanks" }, reqOf());
  assert.equal((await svc.R.settings()).mode, "review");

  await settings({ enabled: false });
  await assert.rejects(() => svc.R.updateSettings({ mode: "automatic" }), { code: "MESSAGING_NOT_READY" });
  await settings({ enabled: true });
  const on = await svc.R.updateSettings({ mode: "automatic" });
  assert.equal(on.after.mode, "automatic");
  const held = await svc.M.MessagingSettings.findOne({ companyId: "default" }).lean();
  assert.equal(held.reminders.lastAutoRunDay, ymd(0), "the first automatic run is tomorrow");
  await svc.R.updateSettings({ mode: "off", steps: [-3, 0, 7, 14, 30], sendHour: 9 });
});

test("the automatic pass: only from the chosen hour, once a day, and a setup fault gives the day back", { skip }, async () => {
  await settings({ enabled: true, "reminders.mode": "automatic", "reminders.sendHour": 10, "reminders.lastAutoRunDay": "2000-01-01", "reminders.steps": [-3, 0, 7, 14, 30], "reminders.catchUpDays": 7 });
  const inv = await owing({ late: 7 });
  const at = (hourUtc) => new Date(`${ymd(0)}T${String(hourUtc).padStart(2, "0")}:00:00.000Z`); // Dubai is UTC+4
  assert.equal((await svc.R.runAutomatic({ now: at(5) })).ran, false, "09:00 in Dubai: before the hour");
  assert.equal((await remindersOf(inv.id)).length, 0);

  // a setup fault: nothing is sent and the day is NOT used up
  await settings({ enabled: false });
  const faulty = await svc.R.runAutomatic({ now: at(6) });
  assert.equal(faulty.error.code, "MESSAGING_DISABLED");
  assert.equal((await svc.R.settings()).lastAutoRunDay, "2000-01-01");
  await settings({ enabled: true });

  // two servers at 10:00. Both read the settings BEFORE either has claimed the day (that is the race), so both pass the "is it due" check and
  // only the compare-and-set on the day stands between them and a double run. The settings read is held back to make that certain.
  const realSettings = svc.R.settings;
  svc.R.settings = async function stale() { return { ...(await realSettings.call(this)), lastAutoRunDay: "2000-01-01" }; };
  let a, b;
  try {
    [a, b] = await Promise.all([svc.R.runAutomatic({ now: at(6) }), svc.R.runAutomatic({ now: at(6) })]);
  } finally {
    svc.R.settings = realSettings;
  }
  assert.equal([a, b].filter((x) => x.ran).length, 1, "only the server that claimed the day runs it");
  assert.equal((await remindersOf(inv.id)).length, 1);
  assert.equal((await svc.R.runAutomatic({ now: at(11) })).ran, false, "and not again the same day");
  assert.equal((await svc.R.settings()).lastAutoRunDay, ymd(0));
  await settings({ "reminders.mode": "off" });
});

test("the notice: review mode says how many are ready and closes itself; automatic mode warns only when it could not send", { skip }, async () => {
  svc.R.lastCheck.clear();
  await settings({ "reminders.mode": "review", enabled: true });
  const inv = await owing({ late: 21 });
  const t0 = new Date();
  const out = await svc.R.check(t0);
  assert.equal(out.ready, true);
  const row = await svc.Notification.findOne({ kind: "payment_reminders_ready" }).lean();
  assert.ok(row);
  assert.match(row.title, /payment reminders? (is|are) ready to send/);
  assert.equal(row.audience.permission, "sales.send");
  assert.equal(row.link, "/payment-reminders");
  assert.deepEqual(await svc.R.check(new Date(t0.getTime() + 60 * 1000)), { skipped: "ran recently" });

  // everything sent: the notice closes at the next check
  const plan = await svc.R.plan();
  await svc.R.sendMany({ items: items(plan), req: reqOf() });
  assert.equal(rowFor(await svc.R.plan(), inv.id), undefined);
  const later = new Date(t0.getTime() + 31 * 60 * 1000);
  assert.equal((await svc.R.check(later)).ready, false);
  assert.equal((await svc.Notification.findOne({ kind: "payment_reminders_ready" }).lean()).resolvedAt != null, true);

  // automatic mode with sending off: one warning, kept for settings.manage
  await settings({ "reminders.mode": "automatic", "reminders.lastAutoRunDay": "2000-01-01", "reminders.sendHour": 0, enabled: false });
  await owing({ late: 7 });
  const blocked = await svc.R.check(new Date(later.getTime() + 31 * 60 * 1000));
  assert.equal(blocked.blocked, true);
  const warn = await svc.Notification.findOne({ kind: "payment_reminders_blocked", resolvedAt: null }).lean();
  assert.ok(warn);
  assert.equal(warn.audience.permission, "settings.manage");
  await settings({ "reminders.mode": "off", enabled: true });
});
