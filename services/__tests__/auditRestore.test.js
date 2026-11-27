// The last audit gaps: the CRM, garage, production and document records log their changes, a bulk change (updateMany) is
// logged record by record, and a deleted master can be put back from DeletedRecord. Throwaway database, dropped after.
//
//   node --require ./utils/testSetup.js --test services/__tests__/auditRestore.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const { withActor } = require("../../utils/tenantContext");
const { RESTORABLE, restorableOf, whyNot } = require("../../utils/restorable");
const perms = require("../../utils/permissions");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_ar_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const person = { id: String(new mongoose.Types.ObjectId()), name: "omar@example.ae", ip: "10.1.2.4" };
const as = (fn) => withActor(person, fn);
const reqWith = (grants) => ({ admin: { id: person.id, email: person.name, grants, role: { key: "custom", name: "Custom" } }, method: "POST", path: "/restore", ip: person.ip });
const everything = reqWith(perms.ALL_KEYS);

test("only masters that come back whole are restorable, each behind the permission that adds one", () => {
  for (const [entity, rule] of Object.entries(RESTORABLE)) assert.ok(perms.isKey(rule.permission), `${entity}: ${rule.permission}`);
  for (const no of ["Transaction", "Quotation", "DeliveryNote", "LedgerAccount", "AccountGroup", "CardMaster", "Van", "Admin", "Role", "Branch", "Contact", "Voucher", "Something"]) {
    assert.equal(restorableOf(no), null, no);
    assert.ok(whyNot(no).length > 10, no);
  }
  assert.equal(restorableOf("toString"), null);
  assert.equal(restorableOf({}), null);
  assert.equal(whyNot("Customer"), null);
});

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Customers: require("../customer/customerService"),
    Categories: require("../stock/categoryService"),
    Restore: require("../core/restoreService"),
    Audit: require("../core/auditService"),
    Customer: require("../../models/modules/customerModel"),
    Category: require("../../models/modules/categoryModel"),
    Lead: require("../../models/modules/crm/leadModel"),
    Vehicle: require("../../models/modules/garage/vehicleModel"),
    ProcessRoute: require("../../models/modules/processRouteModel"),
    Transaction: require("../../models/modules/transactionModel"),
    LedgerAccount: require("../../models/modules/financial/financialModels").LedgerAccount,
    Sequence: require("../../models/modules/sequenceModel"),
    ActivityLog: require("../../models/modules/financial/activityLogModel"),
    Deleted: require("../../models/modules/deletedRecordModel"),
  };
  require("../../models/core/organisationModel");
  require("../../models/modules/uomModel");
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const rows = (action) => svc.ActivityLog.find({ action }).sort({ at: 1, _id: 1 }).lean();
const keptOf = (entity, entityId) => svc.Deleted.findOne({ entity, entityId: String(entityId) }).sort({ deletedAt: -1 }).lean();
const refused = (code) => (err) => { assert.equal(err.code, code, err.message); return true; };

test("CRM, garage and production records log their changes with old and new values", { skip }, async () => {
  const lead = await as(() => svc.Lead.create({ name: "Gulf Fabrication", companyName: "Gulf Fab", expectedValue: 1000, number: "LD-T-1" }));
  await as(() => svc.Lead.updateOne({ _id: lead._id }, { $set: { expectedValue: 2500 } }));
  const [changed] = (await rows("LEAD_UPDATED")).filter((r) => r.entityId === String(lead._id));
  assert.deepEqual(changed.changes.find((c) => c.field === "expectedValue"), { field: "expectedValue", from: 1000, to: 2500 });
  assert.equal(changed.username, person.name);
  // the rollups the CRM keeps for itself are not a person's change
  await as(() => svc.Lead.updateOne({ _id: lead._id }, { $set: { lastActivityAt: new Date(), contactCount: 3 } }));
  assert.equal((await rows("LEAD_UPDATED")).filter((r) => r.entityId === String(lead._id)).length, 1);

  const route = await as(() => svc.ProcessRoute.create({ finished: { stockId: new mongoose.Types.ObjectId(), itemName: "Gate" }, batchQty: 1, steps: [{ name: "Cut", mode: "in_house" }] }));
  await as(() => svc.ProcessRoute.deleteOne({ _id: route._id }));
  assert.equal((await rows("PROCESS_ROUTE_CREATED")).length, 1);
  assert.equal((await rows("PROCESS_ROUTE_DELETED")).length, 1);
  assert.ok(await keptOf("ProcessRoute", route._id), "a deleted route is kept whole");
  assert.equal((await rows("LEAD_CREATED")).length, 1);
});

test("a bulk change is logged record by record, with what each one was before", { skip }, async () => {
  const made = await as(() => svc.Category.create([
    { categoryId: "CAT-B1", name: "Bulk one", description: "a" },
    { categoryId: "CAT-B2", name: "Bulk two", description: "a" },
  ]));
  await as(() => svc.Category.updateMany({ _id: { $in: made.map((m) => m._id) } }, { $set: { description: "b" } }));
  const logged = (await rows("CATEGORY_UPDATED")).filter((r) => made.some((m) => String(m._id) === r.entityId));
  assert.equal(logged.length, 2);
  for (const r of logged) assert.deepEqual(r.changes.find((c) => c.field === "description"), { field: "description", from: "a", to: "b" });
  // nobody behind it: nothing is logged in anybody's name
  await svc.Category.updateMany({ _id: { $in: made.map((m) => m._id) } }, { $set: { description: "c" } });
  assert.equal((await rows("CATEGORY_UPDATED")).filter((r) => made.some((m) => String(m._id) === r.entityId)).length, 2);
});

test("a deleted customer comes back with its id, its number and its ledger account, and only once", { skip }, async () => {
  const c = await as(() => svc.Customers.createCustomer({ customerName: "Restore Me Trading", billingAddress: "Deira", phone: "+971501234567" }));
  const account = await svc.LedgerAccount.findOne({ accountName: "Customer - Restore Me Trading" }).lean();
  assert.ok(account, "a customer gets its ledger account");
  await as(() => svc.Customers.deleteCustomer(c._id));
  assert.equal(await svc.Customer.exists({ _id: c._id }), null);
  assert.equal((await svc.LedgerAccount.findById(account._id).lean()).isActive, false);
  const kept = await keptOf("Customer", c._id);
  assert.ok(kept, "the deleted customer is kept whole");

  const page = await svc.Audit.deletedRecords(everything, { entity: "Customer" });
  const row = page.rows.find((r) => String(r._id) === String(kept._id));
  assert.equal(row.restorable, true);
  assert.equal(row.restored, false);
  assert.equal(row.restorePermission, "sales.create");

  // the permission that adds a customer is needed
  await assert.rejects(as(() => svc.Restore.restore(reqWith(["audit.view"]), String(kept._id))), refused("PERMISSION_DENIED"));

  const out = await as(() => svc.Restore.restore(everything, String(kept._id)));
  assert.equal(out.restored, true);
  const back = await svc.Customer.findById(c._id).lean();
  assert.equal(back.customerName, "Restore Me Trading");
  assert.equal(back.customerId, c.customerId);
  assert.equal((await svc.LedgerAccount.findById(account._id).lean()).isActive, true, "its ledger account is switched on again");
  const n = parseInt(c.customerId.slice(8), 10);
  const seq = await svc.Sequence.findOne({ type: "customer", year: c.customerId.slice(4, 8) }).lean();
  assert.ok(seq.usedNumbers.includes(n) && !seq.deletedNumbers.includes(n), "its number is taken again");
  const [logged] = await rows("CUSTOMER_RESTORED");
  assert.equal(logged.entityId, String(c._id));
  assert.match(logged.summary, /restored/);
  assert.equal(logged.username, person.name);

  await assert.rejects(as(() => svc.Restore.restore(everything, String(kept._id))), refused("ALREADY_RESTORED"));
  const again = await svc.Audit.deletedRecords(everything, { entity: "Customer" });
  assert.equal(again.rows.find((r) => String(r._id) === String(kept._id)).restored, true);
  assert.ok(await svc.Deleted.exists({ _id: kept._id }), "the deleted record stays as it was");
});

test("a name taken since is a conflict, and the record stays deleted", { skip }, async () => {
  const cat = await as(() => svc.Category.create({ categoryId: "CAT-R1", name: "Spices", description: "" }));
  await as(() => svc.Category.deleteOne({ _id: cat._id }));
  await as(() => svc.Category.create({ categoryId: "CAT-R1", name: "Spices", description: "taken again" }));
  const kept = await keptOf("Category", cat._id);
  await assert.rejects(as(() => svc.Restore.restore(everything, String(kept._id))), refused("RESTORE_CONFLICT"));
  assert.equal(await svc.Category.exists({ _id: cat._id }), null);
});

test("an item category comes back, a document does not, and a made-up id is not found", { skip }, async () => {
  const cat = await as(() => svc.Category.create({ categoryId: "CAT-R2", name: "Grains", description: "" }));
  await as(() => svc.Category.deleteOne({ _id: cat._id }));
  const kept = await keptOf("Category", cat._id);
  await as(() => svc.Restore.restore(everything, String(kept._id)));
  assert.ok(await svc.Category.exists({ _id: cat._id }));
  assert.equal((await rows("CATEGORY_RESTORED")).length, 1);

  const fake = await svc.Deleted.create({ entity: "Transaction", entityId: String(new mongoose.Types.ObjectId()), label: "SO-1", data: { _id: new mongoose.Types.ObjectId(), transactionNo: "SO-1" } });
  await assert.rejects(svc.Restore.restore(everything, String(fake._id)), refused("NOT_RESTORABLE"));
  await assert.rejects(svc.Restore.restore(everything, String(new mongoose.Types.ObjectId())), refused("DELETED_RECORD_NOT_FOUND"));
  await assert.rejects(svc.Restore.restore(everything, "not-an-id"), refused("DELETED_RECORD_NOT_FOUND"));
  await assert.rejects(svc.Restore.restore(everything, { $ne: null }), refused("DELETED_RECORD_NOT_FOUND"));
  const page = await svc.Audit.deletedRecords(everything, { entity: "Transaction" });
  const row = page.rows.find((r) => String(r._id) === String(fake._id));
  assert.equal(row.restorable, false);
  assert.match(row.notRestorable, /number was released/);
});
