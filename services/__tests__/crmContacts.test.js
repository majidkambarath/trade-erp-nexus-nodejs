// Contacts, against a throwaway database (random name, dropped afterwards).
//
// The whole point of this file is ONE invariant: a person who belongs to a party is stored twice, under the same id,
// and the two sides can never disagree. `Contact._id === Customer.contacts[i]._id`. Everything below is that rule seen
// from a different direction - written from the CRM, written from the party form, removed, backfilled from rows that
// existed before the collection did, and created by qualifying a lead.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Contacts: require("../crm/contactService"),
    Lead: require("../crm/leadService"),
    Act: require("../crm/activityService"),
    Customers: require("../customer/customerService"),
    Vendors: require("../vendor/vendorService"),
    ContactModel: require("../../models/modules/crm/contactModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Admin: require("../../models/core/adminModel"),
    migrations: require("../../utils/migrations"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const fails = async (fn, code) => {
  try {
    await fn();
    assert.fail(`expected ${code}`);
  } catch (error) {
    assert.equal(error.errorCode || error.code, code, error.message);
    return error;
  }
};

/** The two sides of one person, read fresh. */
const bothSides = async (customerId) => {
  const party = await svc.Customer.findById(customerId).select("contacts contactPerson email phone").lean();
  const rows = await svc.ContactModel.find({ customerId }).sort({ name: 1 }).lean();
  return { party, rows };
};

let customer, vendor, rajesh;

test("setup: a customer and a supplier", { skip }, async () => {
  customer = await svc.Customers.createCustomer({
    customerName: "Al Noor Foods Trading",
    contactPerson: "Hassan Al Noor",
    phone: "0501234567",
    email: "buyer@alnoor.test",
    status: "Active",
  });
  vendor = await svc.Vendors.createVendor({ vendorName: "Gulf Rice Mills", contactPerson: "Imran", phone: "0559876543", address: "Industrial Area 4, Sharjah" });
  assert.ok(customer._id && vendor._id);
});

test("a person added in the CRM is the same row the party form shows", { skip }, async () => {
  rajesh = await svc.Contacts.create(
    { name: "Rajesh Kumar", designation: "Purchase Manager", email: "RAJESH@alnoor.test", phone: "0507778888", customerId: String(customer._id), notes: "Prefers a call before noon" },
    "tester"
  );
  const { party, rows } = await bothSides(customer._id);
  assert.equal(rows.length, 1);
  // The invariant, stated plainly.
  assert.equal(String(party.contacts[0]._id), String(rajesh._id), "the party's row and the CRM's row are one person");
  assert.equal(party.contacts[0].name, "Rajesh Kumar");
  assert.equal(party.contacts[0].email, "rajesh@alnoor.test", "lower-cased by the party master's own rule, not by a second one");
  assert.equal(rows[0].email, "rajesh@alnoor.test");
  // The CRM-only field lives on this side alone: the party's embedded row has no notes to carry.
  assert.equal(rows[0].notes, "Prefers a call before noon");
  assert.equal(party.contacts[0].notes, undefined);
  // The first person in is the primary, settled by utils/partyMaster.js, and the party's flat fields follow them.
  assert.equal(party.contacts[0].isPrimary, true);
});

test("a change made on the customer form reaches the CRM", { skip }, async () => {
  const party = await svc.Customer.findById(customer._id).lean();
  const rows = party.contacts.map((c) => ({ ...c, designation: c.designation }));
  rows[0].designation = "Head of Purchasing";
  await svc.Customers.updateCustomer(String(customer._id), { contacts: rows });
  const after = await bothSides(customer._id);
  assert.equal(after.rows.length, 1, "still one person, not a second copy under a new id");
  assert.equal(String(after.rows[0]._id), String(rajesh._id), "the id survived an edit through the party form");
  assert.equal(after.rows[0].designation, "Head of Purchasing");
  assert.equal(after.rows[0].notes, "Prefers a call before noon", "a CRM-only field is not wiped by a party save");
});

test("a second person, and exactly one primary", { skip }, async () => {
  const fatima = await svc.Contacts.create({ name: "Fatima Noor", phone: "0501110000", customerId: String(customer._id), isPrimary: true }, "tester");
  const { party, rows } = await bothSides(customer._id);
  assert.equal(rows.length, 2);
  assert.equal(party.contacts.filter((c) => c.isPrimary).length, 1, "the party master settles the primary; the CRM does not get its own rule");
  assert.equal(String(party.contacts.find((c) => c.isPrimary)._id), String(fatima._id));
  // Both ids are shared, not only the first one.
  const partyIds = party.contacts.map((c) => String(c._id)).sort();
  const crmIds = rows.map((r) => String(r._id)).sort();
  assert.deepEqual(crmIds, partyIds);
});

test("removing a person in the CRM takes them off the party too", { skip }, async () => {
  const fatima = (await svc.ContactModel.findOne({ name: "Fatima Noor" }).lean());
  await svc.Contacts.remove(String(fatima._id), "tester");
  const { party, rows } = await bothSides(customer._id);
  assert.equal(rows.length, 1);
  assert.equal(party.contacts.length, 1);
  assert.equal(String(party.contacts[0]._id), String(rajesh._id));
});

test("a person removed on the party form stops existing in the CRM", { skip }, async () => {
  await svc.Customers.updateCustomer(String(customer._id), { contacts: [] });
  const { party, rows } = await bothSides(customer._id);
  assert.equal(party.contacts.length, 0);
  assert.equal(rows.length, 0, "gone from the party is gone from here");
});

test("a person who belongs to nobody yet", { skip }, async () => {
  const walkIn = await svc.Contacts.create({ name: "Omar Bakery", phone: "0502223333" }, "tester");
  const shown = svc.Contacts.present(await svc.ContactModel.findById(walkIn._id).lean());
  assert.equal(shown.unlinked, true);
  assert.equal(shown.partyKind, null);
  // And searching finds them by the number, which is usually all anybody has.
  const found = await svc.Contacts.list({ search: "0502223333" });
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "Omar Bakery");
  // "nobody's yet" is its own filter: the ones worth chasing into a customer.
  const loose = await svc.Contacts.list({ linked: "none" });
  assert.ok(loose.some((c) => String(c._id) === String(walkIn._id)));
});

test("a person belongs to a customer or to a supplier, not to both", { skip }, async () => {
  await fails(
    () => svc.Contacts.create({ name: "Two Hats", customerId: String(customer._id), vendorId: String(vendor._id) }, "tester"),
    "CONTACT_TWO_PARTIES"
  );
  await fails(() => svc.Contacts.create({ email: "no-name@test.ae" }, "tester"), "CONTACT_NAME_REQUIRED");
  await fails(() => svc.Contacts.create({ name: "Bad Address", email: "not-an-address" }, "tester"), "CONTACT_EMAIL_INVALID");
  await fails(() => svc.Contacts.getById(new mongoose.Types.ObjectId().toString()), "CONTACT_NOT_FOUND");
});

test("a supplier's people work the same way", { skip }, async () => {
  const imran = await svc.Contacts.create({ name: "Imran Shah", vendorId: String(vendor._id), designation: "Sales" }, "tester");
  const party = await svc.Vendor.findById(vendor._id).select("contacts").lean();
  assert.equal(String(party.contacts[0]._id), String(imran._id));
  const rows = await svc.Contacts.list({ vendorId: String(vendor._id) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].partyKind, "vendor");
});

test("the backfill copies rows that existed before this collection did, and repeats harmlessly", { skip }, async () => {
  // A party written the old way: contacts in the array, nothing in the CRM. The raw driver is used on purpose so
  // PartyMasterService.finish does not run and mirror it for us - that is what makes this a real backfill.
  const older = await svc.Customers.createCustomer({ customerName: "Old Books Trading", contactPerson: "Zaid", phone: "0504445555", status: "Active" });
  const rowId = new mongoose.Types.ObjectId();
  await svc.Customer.collection.updateOne(
    { _id: older._id },
    { $set: { contacts: [{ _id: rowId, name: "Zaid Ali", designation: "Owner", email: "zaid@old.test", phone: "0504445555", isPrimary: true }] } }
  );
  assert.equal(await svc.ContactModel.countDocuments({ _id: rowId }), 0, "nothing in the CRM yet");

  const first = await svc.migrations.runMigrations();
  assert.ok((first.crmContactsBackfilled || 0) >= 1, JSON.stringify(first));
  const made = await svc.ContactModel.findById(rowId).lean();
  assert.ok(made, "the person now has their own record");
  assert.equal(String(made._id), String(rowId), "under the id the party already had for them");
  assert.equal(made.name, "Zaid Ali");
  assert.equal(String(made.customerId), String(older._id));

  // Somebody edits them in the CRM, then the server restarts.
  await svc.ContactModel.updateOne({ _id: rowId }, { $set: { notes: "Only answers on WhatsApp" } });
  const second = await svc.migrations.runMigrations();
  assert.equal(second.crmContactsBackfilled || 0, 0, "a repeat inserts nothing");
  const after = await svc.ContactModel.findById(rowId).lean();
  assert.equal(after.notes, "Only answers on WhatsApp", "a restart does not reset what the CRM knows");
  assert.equal(await svc.ContactModel.countDocuments({ _id: rowId }), 1, "and never makes a second copy");
});

test("qualifying a lead gives the customer the person who actually enquired", { skip }, async () => {
  const lead = await svc.Lead.create(
    { name: "Hassan Rahman", company: "Rahman Supermarket", phone: "0506667777", email: "hassan@rahman.test", source: "referral", interest: "Monthly rice", expectedValue: 40000 },
    "tester"
  );
  const { customerId } = await svc.Lead.qualify(String(lead._id), {}, "tester");
  const party = await svc.Customer.findById(customerId).select("contacts contactPerson").lean();
  assert.equal(party.contactPerson, "Hassan Rahman");
  assert.equal(party.contacts.length, 1, "the enquirer is a real contact, not only a flat string");
  assert.equal(party.contacts[0].name, "Hassan Rahman");
  assert.equal(party.contacts[0].phone, "0506667777");

  // And the CRM has them, under the party's own id for the row.
  const mirrored = await svc.ContactModel.findById(party.contacts[0]._id).lean();
  assert.ok(mirrored, "the mirror ran on create, not only on update");
  assert.equal(String(mirrored.customerId), String(customerId));
});

test("a call can be logged against a person, and is on their page", { skip }, async () => {
  const rows = await svc.Contacts.list({ customerId: String(customer._id) });
  // Rajesh was taken off the party two tests ago; put one back to talk to.
  const who = rows[0] || (await svc.Contacts.create({ name: "Rajesh Kumar", customerId: String(customer._id), phone: "0507778888" }, "tester"));
  const call = await svc.Act.create(
    { kind: "call", subject: "Asked about the rice price", regarding: { kind: "contact", id: String(who._id) }, dueAt: null },
    "tester"
  );
  assert.equal(call.regarding.kind, "contact");
  assert.equal(String(call.customerId), String(customer._id), "the customer is carried across, so the party's CRM tab shows it too");

  const page = await svc.Contacts.getById(String(who._id));
  assert.equal(page.timeline.length, 1);
  assert.equal(page.timeline[0].subject, "Asked about the rice price");
  assert.equal(page.party.kind, "customer");
  assert.equal(page.party.name, "Al Noor Foods Trading");
});

test("the communications log reads everything, newest first; the worklist still reads only what is owed", { skip }, async () => {
  const log = await svc.Act.list({ status: "all", sort: "recent", limit: 50 });
  const worklist = await svc.Act.list({});
  assert.ok(log.length >= worklist.length, "the log is never smaller than the worklist");
  const note = await svc.Act.create({ kind: "note", subject: "Met at the trade fair", regarding: { kind: "customer", id: String(customer._id) } }, "tester");
  assert.equal(note.status, "DONE", "a note is a thing that happened, not a thing to do");
  const again = await svc.Act.list({ status: "all", sort: "recent", limit: 50 });
  assert.equal(String(again[0]._id), String(note._id), "newest first");
  assert.ok(again.some((a) => a.status === "DONE"), "the log shows what is finished, which the worklist never does");
  assert.equal(worklist.every((a) => a.status === "OPEN"), true, "the worklist is still only what is still owed");
});
