// Recurring invoices against a real database: drafts made on schedule, once, dated their day, and nothing posted.
//   node --require ./utils/testSetup.js --test services/__tests__/recurringInvoices.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_rec_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
let svc, customer, item, SHOP, rent;
const at = (d) => new Date(`${d}T09:00:00.000Z`);
const draftsOf = (id) => svc.Transaction.find({ "recurringRef.id": id }).sort({ date: 1 }).lean();
const dayOf = (d) => new Date(d).toISOString().slice(0, 10);

test.before(async () => {
  if (skip) return;
  process.env.LOG_SILENT = "1";
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Config: require("../financial/accountConfigService"),
    Tx: require("../orderPurchase/transactionService"),
    Rec: require("../orderPurchase/recurringInvoiceService"),
    CC: require("../financial/costCentreService"),
    Checks: require("../core/notificationChecksService"),
    Notification: require("../../models/core/notificationModel"),
    RecurringInvoice: require("../../models/modules/recurringInvoiceModel"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Customer: require("../../models/modules/customerModel"),
    FiscalYear: require("../../models/modules/financial/fiscalYearModel"),
    ...require("../../models/modules/financial/financialModels"),
  };
  require("../../models/modules/uomModel");
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault();
  await svc.seed({ log: () => {} });
  await svc.Config.setPostingEnabled(true);
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", creditLimit: 1e6 });
  item = await svc.Stock.create({ itemId: "SVC", sku: "SVC", itemName: "Maintenance contract", itemType: "service", category: new mongoose.Types.ObjectId(), salesPrice: 1000 });
  SHOP = await svc.CC.create({ code: "SHOP1", name: "Deira shop" }, { admin: { id: "t" } });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const line = (extra = {}) => ({ itemId: String(item._id), qty: 1, price: 1000, vatPercent: 5, ...extra });

test("a template is checked and priced, and says when it runs", { skip }, async () => {
  await assert.rejects(() => svc.Rec.create({ name: "x", partyId: String(customer._id), items: [line()], frequency: "daily", startDay: "2026-01-15" }, "t"), { code: "INVALID_SCHEDULE" });
  await assert.rejects(() => svc.Rec.create({ name: "", partyId: String(customer._id), items: [line()], frequency: "monthly", startDay: "2026-01-15" }, "t"), { code: "NAME_REQUIRED" });
  await assert.rejects(() => svc.Rec.create({ name: "x", partyId: String(customer._id), items: [], frequency: "monthly", startDay: "2026-01-15" }, "t"), { code: "ITEMS_REQUIRED" });
  rent = await svc.Rec.create({
    name: "Maintenance - Al Noor", partyId: String(customer._id), items: [line({ costCentreId: String(SHOP._id) })],
    frequency: "monthly", startDay: "2026-01-31", maxCount: 4, notes: "Monthly service",
  }, "t");
  assert.equal(rent.nextRunDay, "2026-01-31");
  assert.equal(rent.status, "ACTIVE");
  assert.equal(rent.totalAmount, 1050);
  assert.equal(String(rent.items[0].costCentreId), String(SHOP._id));
  const shown = svc.Rec.present(rent);
  assert.deepEqual(shown.upcoming, ["2026-01-31", "2026-02-28", "2026-03-31"]);
  assert.equal(shown.describe, "Every month");
});

test("a due run makes ONE draft per scheduled day, dated that day, with the template's lines, and posts nothing", { skip }, async () => {
  const out = await svc.Rec.runDue(at("2026-03-05"));
  assert.equal(out.made, 2);
  const drafts = await draftsOf(rent._id);
  assert.deepEqual(drafts.map((d) => dayOf(d.date)), ["2026-01-31", "2026-02-28"]);
  for (const d of drafts) {
    assert.equal(d.status, "DRAFT");
    assert.equal(d.type, "sales_order");
    assert.equal(d.totalAmount, 1050);
    assert.equal(d.recurringRef.name, "Maintenance - Al Noor");
    assert.equal(String(d.items[0].costCentreId), String(SHOP._id));
    assert.match(d.notes, /^Recurring: Maintenance - Al Noor/);
    assert.equal(await svc.LedgerEntry.countDocuments({ voucherId: d._id }), 0, "a draft posts nothing");
  }
  const t = await svc.RecurringInvoice.findById(rent._id).lean();
  assert.equal(t.made, 2);
  assert.equal(t.nextRunDay, "2026-03-31");
  assert.equal(t.runs.length, 2);
  // running again the same day, or twice at once, makes nothing more
  const again = await Promise.all([svc.Rec.runDue(at("2026-03-05")), svc.Rec.runDue(at("2026-03-05"))]);
  assert.equal(again[0].made + again[1].made, 0);
  assert.equal((await draftsOf(rent._id)).length, 2);
});

test("two runs racing for the same slot make one invoice", { skip }, async () => {
  const t = await svc.RecurringInvoice.findById(rent._id).lean();
  const results = await Promise.allSettled([svc.Rec.runSlot(String(t._id), t.cursor, "a"), svc.Rec.runSlot(String(t._id), t.cursor, "b")]);
  const made = results.filter((r) => r.status === "fulfilled" && r.value.made).length;
  assert.equal(made, 1);
  assert.equal((await draftsOf(rent._id)).length, 3);
});

test("a refused run (a closed month) records why, moves nothing, and is made once the month is open again", { skip }, async () => {
  const lease = await svc.Rec.create({ name: "Lease", partyId: String(customer._id), items: [line()], frequency: "monthly", startDay: "2026-01-10" }, "t");
  const year = await svc.FiscalYear.findOne({ startDate: { $lte: new Date("2026-06-30") }, endDate: { $gte: new Date("2026-06-30") } });
  await svc.FiscalYear.updateOne({ _id: year._id }, { $set: { lockedThrough: "2026-01-31" } });
  const out = await svc.Rec.runDue(at("2026-02-15"));
  assert.ok(out.failed >= 1);
  let t = await svc.RecurringInvoice.findById(lease._id).lean();
  assert.equal(t.made, 0);
  assert.equal(t.nextRunDay, "2026-01-10");
  assert.equal(t.lastError.day, "2026-01-10");
  assert.match(t.lastError.message, /closed/i);
  assert.ok(t.retryAfter > at("2026-02-15"));
  assert.equal((await draftsOf(lease._id)).length, 0);
  await svc.Checks.checkRecurringInvoices(at("2026-02-15"));
  assert.ok(await svc.Notification.findOne({ dedupeKey: `recurring_failed:${lease._id}`, resolvedAt: null }));
  // not tried again before retryAfter
  await svc.Rec.runDue(at("2026-02-15"));
  assert.equal((await svc.RecurringInvoice.findById(lease._id).lean()).made, 0);

  await svc.FiscalYear.updateOne({ _id: year._id }, { $unset: { lockedThrough: 1 } });
  const later = new Date(t.retryAfter.getTime() + 1000);
  await svc.Rec.runDue(later);
  t = await svc.RecurringInvoice.findById(lease._id).lean();
  assert.ok(t.made >= 1);
  assert.equal(t.lastError, undefined);
  await svc.Checks.checkRecurringInvoices(later);
  assert.equal(await svc.Notification.findOne({ dedupeKey: `recurring_failed:${lease._id}`, resolvedAt: null }), null, "the warning resolves itself");
  await svc.Rec.remove(lease._id);
  await svc.Transaction.deleteMany({ "recurringRef.id": lease._id });
});

test("pause and resume: the paused months are skipped, the number of invoices is kept, and it ends after the last", { skip }, async () => {
  await svc.Rec.pause(String(rent._id), "t");
  await svc.Rec.runDue(at("2026-06-01"));
  assert.equal((await svc.RecurringInvoice.findById(rent._id).lean()).made, 3, "a paused template makes nothing");
  await assert.rejects(() => svc.Rec.pause(String(rent._id), "t"), { code: "RECURRING_STATE" });
  const resumed = await svc.Rec.resume(String(rent._id), "t");
  assert.equal(resumed.status, "ACTIVE");
  assert.ok(resumed.nextRunDay >= require("../../utils/documentExpiry").todayInOrg(), "carries on from today, no back-fill");
  assert.equal(resumed.made, 3);
  const r = await svc.Rec.runNow(String(rent._id), "t");
  assert.equal(r.invoice.status, "DRAFT");
  const t = await svc.RecurringInvoice.findById(rent._id).lean();
  assert.equal(t.made, 4);
  assert.equal(t.status, "ENDED");
  assert.equal(t.nextRunDay, null);
  await assert.rejects(() => svc.Rec.runNow(String(rent._id), "t"), { code: "RECURRING_ENDED" });
});

test("the drafts waiting notice counts them, and resolves once they are approved", { skip }, async () => {
  await svc.Checks.checkRecurringInvoices(new Date());
  const n = await svc.Notification.findOne({ dedupeKey: "recurring_drafts", resolvedAt: null }).lean();
  assert.ok(n);
  assert.match(n.title, /4 recurring invoices are drafts/);
  for (const d of await draftsOf(rent._id)) await svc.Tx.processTransaction(d._id, "approve", "t");
  await svc.Checks.checkRecurringInvoices(new Date());
  assert.equal(await svc.Notification.findOne({ dedupeKey: "recurring_drafts", resolvedAt: null }), null);
});

test("an edited schedule carries on after the last invoice; a body cannot forge recurringRef; the list filter finds them", { skip }, async () => {
  const fees = await svc.Rec.create({ name: "Fees", partyId: String(customer._id), items: [line()], frequency: "monthly", startDay: "2026-01-15" }, "t");
  await svc.Rec.runSlot(String(fees._id), 0, "t");
  const edited = await svc.Rec.update(String(fees._id), { frequency: "quarterly", items: [line({ price: 2000 })] }, "t");
  assert.equal(edited.nextRunDay, "2026-04-15");
  assert.equal(edited.totalAmount, 2100);
  // an edit cannot attach a document to a schedule (a request body never reaches createTransaction with it: the controller strips it)
  const plain = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", items: [line({ description: "x" })] }, "t");
  await svc.Tx.updateTransaction(plain._id, { recurringRef: { id: fees._id, name: "x" }, items: [line({ description: "x" })] }, "t");
  assert.equal((await svc.Transaction.findById(plain._id).lean()).recurringRef?.id, undefined);
  const { query } = await svc.Tx.listQuery({ type: "sales_order", recurring: String(fees._id) });
  assert.equal(await svc.Transaction.countDocuments(query), 1);
  await assert.rejects(() => svc.Tx.listQuery({ recurring: "nope" }), { code: "INVALID_FILTER" });
});
