// The money alerts on the notification feed, end to end on a throwaway database (utils/moneyNotices.js, services/core/
// notificationChecksService.js): overdue customer invoices, supplier bills falling due, customers', suppliers' and employees'
// documents running out, batches expiring, e-invoices that need a person. What is told, to whom, that it is ONE row however many
// documents lie behind it, that a new week tells again, that it resolves itself, and that an organisation is judged on its plan.
//
//   node --require ./utils/testSetup.js --test services/__tests__/moneyAlerts.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_mny_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const DAY = 86400000;
let svc, today;

test.before(async () => {
  if (skip) return;
  process.env.LOG_SILENT = "1";
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    Org: require("../core/organisationService"),
    OrgModel: require("../../models/core/organisationModel"),
    Notification: require("../core/notificationService"),
    NotificationModel: require("../../models/core/notificationModel"),
    Checks: require("../core/notificationChecksService"),
    Transaction: require("../../models/modules/transactionModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Stock: require("../../models/modules/stockModel"),
    StockBatch: require("../../models/modules/stockBatchModel"),
    Staff: require("../../models/modules/staffModel"),
    EmployeeDocument: require("../../models/modules/hr/employeeDocumentModel"),
    ...require("../../models/modules/einvoiceModels"),
    ctx: require("../../utils/tenantContext"),
    day: require("../../utils/documentExpiry"),
    notices: require("../../utils/moneyNotices"),
  };
  await mongoose.connection.syncIndexes();
  const make = (code, planCode) => svc.Org.create({ legalName: code, code, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode }, { by: "dev" });
  await make("mnyfull", "premium"); // every module and feature
  await make("mnytrade", "trading"); // sales, purchase and stock: no finance, no HR, no e-invoicing
  today = svc.day.todayInOrg();
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const inOrg = (code, fn) => svc.ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const FULL = (fn) => inOrg("mnyfull", fn);
const seer = (grants) => ({ admin: { id: "p1", grants } });
const at = (n) => svc.day.addDays(today, n); // a YYYY-MM-DD day, n days from today
const feed = async (code, grants) => (await inOrg(code, () => svc.Notification.forPerson(seer(grants)))).items;
const ofKind = (items, text) => items.filter((n) => n.title.includes(text));
const overdueRows = (items) => items.filter((n) => /^\d+ invoices? overdue:/.test(n.title)); // "1 invoice overdue" or "3 invoices overdue"
let seq = 0;

const customer = (code, name, extra = {}) => inOrg(code, () => svc.Customer.create({ customerId: `C-${++seq}`, customerName: name, contactPerson: "Ali", billingAddress: "Deira", ...extra }));
const vendor = (code, name, extra = {}) => inOrg(code, () => svc.Vendor.create({ vendorId: `V-${++seq}`, vendorName: name, contactPerson: "Omar", address: "Jebel Ali", ...extra }));
const invoice = (code, type, party, outstanding, dueDay, over = {}) => inOrg(code, () => svc.Transaction.create({
  type, transactionNo: `MA-${++seq}`, partyId: party._id, partyType: type === "sales_order" ? "Customer" : "Vendor", partyTypeRef: type === "sales_order" ? "Customer" : "Vendor",
  items: [], totalAmount: outstanding, outstandingAmount: outstanding, status: "APPROVED", date: new Date(Date.now() - 60 * DAY),
  dueDate: new Date(`${dueDay}T00:00:00.000Z`), createdBy: "tester", ...over,
}));
const rowsOf = (code, kind) => inOrg(code, () => svc.NotificationModel.find({ kind }).lean());

// ---------------------------------------------------------------------------------------------------------------------------------
// customers who owe
// ---------------------------------------------------------------------------------------------------------------------------------

test("overdue invoices are ONE row however many lie behind it, with their sum, and it is told to whoever may see sales", { skip }, async () => {
  const noor = await customer("mnyfull", "Al Noor Trading");
  const gulf = await customer("mnyfull", "Gulf Foods");
  await invoice("mnyfull", "sales_order", noor, 100, at(-5));
  await invoice("mnyfull", "sales_order", noor, 250.5, at(-12));
  await invoice("mnyfull", "sales_order", gulf, 49.5, at(-2));
  await invoice("mnyfull", "sales_order", gulf, 900, at(0)); // due today: not late yet
  await invoice("mnyfull", "sales_order", gulf, 900, at(10)); // not due
  await invoice("mnyfull", "sales_order", gulf, 0, at(-30), { paidAmount: 700, totalAmount: 700 }); // paid in full: owes nothing

  const r = await FULL(() => svc.Checks.checkOverdueReceivables(new Date()));
  assert.equal(r.told, 1, JSON.stringify(r));
  const rows = await rowsOf("mnyfull", "overdue_receivables");
  assert.equal(rows.length, 1, "one row, not one per invoice");
  assert.equal(rows[0].title, "3 invoices overdue: AED 400.00 owed by 2 customers");
  assert.match(rows[0].body, /The oldest is 12 days past its due date/);
  assert.equal(rows[0].dedupeKey, `overdue_receivables:${svc.notices.weekKey(today)}`, "keyed by the Monday of this week");

  const seen = ofKind(await feed("mnyfull", ["sales.view"]), "invoices overdue");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].link, "/ageing");
  assert.equal(seen[0].severity, "warning");
  assert.equal(ofKind(await feed("mnyfull", ["finance.view"]), "invoices overdue").length, 0, "a person who may not see sales is not told");
  assert.ok(!JSON.stringify(rows[0]).includes("Al Noor") && !JSON.stringify(rows[0]).includes("Gulf Foods"), "no customer is named on a money row");
});

test("running it again changes nothing, a read notice stays read, and paying the last overdue invoice resolves it", { skip }, async () => {
  const first = ofKind(await feed("mnyfull", ["sales.view"]), "invoices overdue")[0];
  await inOrg("mnyfull", () => svc.Notification.markRead(seer(["sales.view"]), first.id));
  await FULL(() => svc.Checks.checkOverdueReceivables(new Date()));
  const again = ofKind(await feed("mnyfull", ["sales.view"]), "invoices overdue");
  assert.equal(again.length, 1, "no duplicate");
  assert.equal(again[0].read, true, "re-detecting a condition does not un-read it");

  // one of the three is paid: the figures change in place
  await inOrg("mnyfull", () => svc.Transaction.updateOne({ type: "sales_order", totalAmount: 250.5 }, { $set: { outstandingAmount: 0, paidAmount: 250.5 } }));
  await FULL(() => svc.Checks.checkOverdueReceivables(new Date()));
  const fewer = ofKind(await feed("mnyfull", ["sales.view"]), "invoices overdue")[0];
  assert.equal(fewer.title, "2 invoices overdue: AED 149.50 owed by 2 customers");
  assert.equal(fewer.id, first.id, "the same row, updated");
  assert.equal(fewer.read, true);

  // everything overdue is paid: it closes itself
  await inOrg("mnyfull", () => svc.Transaction.updateMany({ dueDate: { $lt: new Date(`${at(0)}T00:00:00.000Z`) } }, { $set: { outstandingAmount: 0 } }));
  const r = await FULL(() => svc.Checks.checkOverdueReceivables(new Date()));
  assert.equal(r.told, 0);
  assert.equal(ofKind(await feed("mnyfull", ["sales.view"]), "invoices overdue").length, 0);
});

test("a new week tells again: a fresh unread row, and last week's is closed", { skip }, async () => {
  const noor = await customer("mnyfull", "Weekly Customer");
  const late = await invoice("mnyfull", "sales_order", noor, 300, at(-20));
  await FULL(() => svc.Checks.checkOverdueReceivables(new Date()));
  const thisWeek = overdueRows(await feed("mnyfull", ["sales.view"]))[0];
  assert.ok(thisWeek, "told");
  assert.equal(thisWeek.title, "1 invoice overdue: AED 300.00 owed by 1 customer");
  await inOrg("mnyfull", () => svc.Notification.markRead(seer(["sales.view"]), thisWeek.id));

  // a week on, the invoice that was due today is late too, so the figures differ - but it is the SAME condition, told again
  const nextWeek = new Date(Date.now() + 7 * DAY);
  await FULL(() => svc.Checks.checkOverdueReceivables(nextWeek));
  const items = overdueRows(await feed("mnyfull", ["sales.view"]));
  assert.equal(items.length, 1, "last week's row was closed, not left beside the new one");
  assert.equal(items[0].read, false, "still true a week later: told again");
  assert.notEqual(items[0].id, thisWeek.id);
  const stored = await rowsOf("mnyfull", "overdue_receivables"); // the feed's shape leaves the key out: read it where it is kept
  assert.deepEqual(stored.filter((r) => !r.resolvedAt).map((r) => r.dedupeKey), [`overdue_receivables:${svc.notices.weekKey(svc.day.todayInOrg(nextWeek))}`]);
  assert.ok(stored.some((r) => r.resolvedAt && r.dedupeKey === `overdue_receivables:${svc.notices.weekKey(today)}`), "last week's row is kept, closed");
  await inOrg("mnyfull", () => svc.Transaction.updateOne({ _id: late._id }, { $set: { outstandingAmount: 0 } }));
  await FULL(() => svc.Checks.checkOverdueReceivables(nextWeek));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// bills to pay
// ---------------------------------------------------------------------------------------------------------------------------------

test("supplier bills: the overdue and those due within a week, for whoever may see purchases", { skip }, async () => {
  const mill = await vendor("mnyfull", "Gulf Mills");
  await invoice("mnyfull", "purchase_order", mill, 500, at(-4));
  await invoice("mnyfull", "purchase_order", mill, 120, at(0));
  await invoice("mnyfull", "purchase_order", mill, 80, at(5));
  await invoice("mnyfull", "purchase_order", mill, 999, at(30)); // a month away: not told
  const r = await FULL(() => svc.Checks.checkPayablesDue(new Date()));
  assert.equal(r.told, 1);
  const seen = ofKind(await feed("mnyfull", ["purchase.view"]), "Supplier bills");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].title, "Supplier bills: 1 overdue (AED 500.00), 2 due within 7 days (AED 200.00)");
  assert.equal(seen[0].link, "/ageing?type=payable");
  assert.equal(ofKind(await feed("mnyfull", ["sales.view"]), "Supplier bills").length, 0, "sales does not pay suppliers");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// documents running out
// ---------------------------------------------------------------------------------------------------------------------------------

test("a customer's and a supplier's documents are told to their own desks; an employee's are counted, never named, and need hr.view", { skip }, async () => {
  const doc = (n, number) => ({ typeName: "Trade licence", number, expiryDate: new Date(`${at(n)}T00:00:00.000Z`) });
  await customer("mnyfull", "Licence Customer", { documents: [doc(-2, "LC-1"), doc(5, "LC-2"), doc(90, "LC-3")] });
  await vendor("mnyfull", "Licence Vendor", { documents: [doc(10, "LV-1")] });
  const staff = await inOrg("mnyfull", () => svc.Staff.create({ staffId: "EMP-MNY-1", name: "Ali Passport", designation: "Driver", contactNo: "0501234567", idNo: "784199000000777", joiningDate: new Date("2024-01-01"), createdBy: "tester" }));
  await inOrg("mnyfull", () => svc.EmployeeDocument.create({ staffId: staff._id, name: "Passport", number: "STAFF-SECRET-1", expiryDate: new Date(`${at(7)}T00:00:00.000Z`) }));

  assert.equal((await FULL(() => svc.Checks.checkDocumentsExpiring("customer", new Date()))).told, 1);
  assert.equal((await FULL(() => svc.Checks.checkDocumentsExpiring("vendor", new Date()))).told, 1);
  assert.equal((await FULL(() => svc.Checks.checkDocumentsExpiring("staff", new Date()))).told, 1);

  const sales = await feed("mnyfull", ["sales.view"]);
  const customers = ofKind(sales, "Customer documents");
  assert.equal(customers.length, 1);
  assert.equal(customers[0].title, "Customer documents: 1 expired, 1 expiring within 30 days", "the far one is not told");
  assert.match(customers[0].body, /Trade licence of Licence Customer \(expired 2 days ago\)/);
  assert.equal(customers[0].link, "/kyc-documents");
  assert.equal(ofKind(sales, "Supplier documents").length, 0, "a supplier's documents are the purchase desk's");
  assert.equal(ofKind(await feed("mnyfull", ["purchase.view"]), "Supplier documents")[0].title, "Supplier documents: 1 expiring within 30 days");

  const hr = ofKind(await feed("mnyfull", ["hr.view"]), "Staff documents");
  assert.equal(hr.length, 1);
  assert.equal(hr[0].title, "Staff documents: 1 expiring within 30 days");
  assert.ok(!JSON.stringify(hr[0]).includes("Ali Passport") && !JSON.stringify(hr[0]).includes("STAFF-SECRET-1"), "an employee is not named");
  assert.equal(hr[0].link, "/hr/documents");
  assert.equal(ofKind(await feed("mnyfull", ["sales.view", "purchase.view"]), "Staff documents").length, 0, "sales and purchase never see staff documents, even in a count");
});

test("a renewed document resolves its row", { skip }, async () => {
  await inOrg("mnyfull", () => svc.Customer.updateMany({}, { $set: { "documents.$[].expiryDate": new Date(`${at(400)}T00:00:00.000Z`) } }));
  const r = await FULL(() => svc.Checks.checkDocumentsExpiring("customer", new Date()));
  assert.equal(r.told, 0);
  assert.equal(ofKind(await feed("mnyfull", ["sales.view"]), "Customer documents").length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// batches
// ---------------------------------------------------------------------------------------------------------------------------------

test("batches: expired and expiring ones with stock still on hand, for inventory.view", { skip }, async () => {
  const yoghurt = await inOrg("mnyfull", () => svc.Stock.create({ itemId: "YOG1", sku: "YO0001", itemName: "Yoghurt", category: new mongoose.Types.ObjectId() }));
  const milk = await inOrg("mnyfull", () => svc.Stock.create({ itemId: "MIL1", sku: "MI0001", itemName: "Milk", category: new mongoose.Types.ObjectId() }));
  const batch = (stock, n, qty, number) => inOrg("mnyfull", () => svc.StockBatch.create({ stockId: stock._id, itemCode: stock.itemId, batchNumber: number, receivedQty: 100, qtyOnHand: qty, expiryDate: new Date(`${at(n)}T00:00:00.000Z`) }));
  await batch(yoghurt, -3, 40, "B1");
  await batch(milk, 4, 120, "B2");
  await batch(milk, 90, 50, "B3"); // far
  await batch(milk, 2, 0, "B4"); // nothing left on hand
  const r = await FULL(() => svc.Checks.checkBatchesExpiring(new Date()));
  assert.equal(r.told, 1);
  const seen = ofKind(await feed("mnyfull", ["inventory.view"]), "Batches");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].title, "Batches: 1 expired, 1 expiring within 30 days");
  assert.match(seen[0].body, /Yoghurt, 40 left \(expired\); Milk, 120 left/);
  assert.equal(seen[0].link, "/batches");
  assert.equal(ofKind(await feed("mnyfull", ["sales.view"]), "Batches").length, 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// e-invoices
// ---------------------------------------------------------------------------------------------------------------------------------

test("e-invoices: a rejection or a failure that will not retry is told to whoever approves sales; a failure that retries by itself is not", { skip }, async () => {
  const sub = (over) => inOrg("mnyfull", () => svc.EInvoiceSubmission.create({ sourceId: new mongoose.Types.ObjectId(), documentNo: `INV-${++seq}`, invoiceTypeCode: "380", status: "FAILED", ...over }));
  const retrying = await sub({ status: "FAILED", nextRetryAt: new Date(Date.now() + 600000) });
  assert.equal((await FULL(() => svc.Checks.checkEinvoiceAttention(new Date()))).told, 0, "it will be tried again without anybody");

  const gaveUp = await sub({ status: "FAILED", nextRetryAt: null, retryable: false });
  await FULL(() => svc.Checks.checkEinvoiceAttention(new Date()));
  const first = ofKind(await feed("mnyfull", ["sales.approve"]), "e-invoice")[0];
  assert.equal(first.title, "1 e-invoice needs attention");
  assert.equal(first.severity, "warning");
  assert.equal(first.link, "/e-invoicing/dashboard");
  assert.equal(ofKind(await feed("mnyfull", ["sales.view"]), "e-invoice").length, 0, "viewing is not fixing: it needs sales.approve");
  await inOrg("mnyfull", () => svc.Notification.markRead(seer(["sales.approve"]), first.id));

  // a NEW rejection by the tax authority is a new unread row at once, not at the start of next week, and the old one is closed
  await new Promise((resolve) => setTimeout(resolve, 20)); // updatedAt orders them
  const rejected = await sub({ status: "REJECTED", rejectedBy: "fta" });
  await FULL(() => svc.Checks.checkEinvoiceAttention(new Date()));
  const items = ofKind(await feed("mnyfull", ["sales.approve"]), "e-invoice");
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "2 e-invoices need attention");
  assert.equal(items[0].severity, "critical");
  assert.equal(items[0].read, false, "a new problem is told");
  assert.match(items[0].body, /1 rejected by the tax authority, 1 failed and will not be tried again on their own/);

  // corrected and sent again: both leave the list, and the row resolves
  await inOrg("mnyfull", () => svc.EInvoiceSubmission.updateMany({ _id: { $in: [gaveUp._id, rejected._id] } }, { $set: { status: "QUEUED" } }));
  assert.equal((await FULL(() => svc.Checks.checkEinvoiceAttention(new Date()))).told, 0);
  assert.equal(ofKind(await feed("mnyfull", ["sales.approve"]), "e-invoice").length, 0);
  assert.ok(retrying);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the registry: plan and pace
// ---------------------------------------------------------------------------------------------------------------------------------

test("an organisation is judged on its plan: a trade-only one gets the money checks but not staff documents or e-invoices", { skip }, async () => {
  const org = await svc.ctx.runUnscoped("test: read the organisation row a job is handed", () => svc.OrgModel.findOne({ code: "mnytrade" }).lean());
  const ran = await inOrg("mnytrade", () => svc.Checks.runAll(new Date(), org));
  for (const key of ["overdueReceivables", "payablesDue", "kycCustomers", "kycVendors", "batchesExpiring"]) {
    assert.equal(typeof ran[key]?.checked, "number", `${key} ran and finished: ${JSON.stringify(ran[key])}`); // not skipped, and not an { error }
  }
  assert.deepEqual(ran.staffDocuments, { skipped: "not in the plan" }, "no HR module");
  assert.deepEqual(ran.einvoiceAttention, { skipped: "not in the plan" }, "no e-invoicing feature");
});

test("the heavier checks run at most once an hour per organisation; the e-invoice one every quarter of an hour; a direct call is never held back", { skip }, async () => {
  const org = await svc.ctx.runUnscoped("test: read the organisation row a job is handed", () => svc.OrgModel.findOne({ code: "mnyfull" }).lean());
  svc.Checks.lastRun.clear();
  const t0 = new Date("2026-12-01T09:00:00.000Z");
  const first = await inOrg("mnyfull", () => svc.Checks.runAll(t0, org));
  assert.equal(first.overdueReceivables.skipped, undefined, "the first pass runs it");
  assert.equal(first.einvoiceAttention.skipped, undefined);

  const soon = await inOrg("mnyfull", () => svc.Checks.runAll(new Date(t0.getTime() + 10 * 60000), org));
  assert.deepEqual(soon.overdueReceivables, { skipped: "ran recently" }, "ten minutes later");
  assert.deepEqual(soon.einvoiceAttention, { skipped: "ran recently" });
  assert.equal(soon.lowStock.skipped, undefined, "a check with no pace still runs every pass");

  const quarter = await inOrg("mnyfull", () => svc.Checks.runAll(new Date(t0.getTime() + 16 * 60000), org));
  assert.deepEqual(quarter.overdueReceivables, { skipped: "ran recently" }, "sixteen minutes: still within the hour");
  assert.equal(quarter.einvoiceAttention.skipped, undefined, "but the e-invoice check is due again");

  const hour = await inOrg("mnyfull", () => svc.Checks.runAll(new Date(t0.getTime() + 61 * 60000), org));
  assert.equal(hour.overdueReceivables.skipped, undefined, "an hour later");

  // no organisation to name (a direct call, as the tests above make): never held back
  const direct1 = await FULL(() => svc.Checks.runAll(t0));
  const direct2 = await FULL(() => svc.Checks.runAll(t0));
  assert.equal(direct1.overdueReceivables.skipped, undefined);
  assert.equal(direct2.overdueReceivables.skipped, undefined);
});
