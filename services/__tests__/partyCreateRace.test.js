// Customers and vendors created at the same moment (two people, a spreadsheet import) each take the next number from ONE counter
// document (Sequence). Two transactions reading it and then writing it conflict, MongoDB answers a transient write conflict to the loser,
// and the loser must be run again on a fresh transaction - not shown as a failure. Throwaway database, dropped after.
//
//   node --require ./utils/testSetup.js --test services/__tests__/partyCreateRace.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_prc_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;

let Customers, Vendors;
test.before(async () => {
  if (skip) return;
  process.env.LOG_SILENT = "1";
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  Customers = require("../customer/customerService");
  Vendors = require("../vendor/vendorService");
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault(); // as the server arranges at start-up
  await require("../../utils/seedAccounting").seedAccounting({ log: () => {} }); // the chart the parties' ledger accounts are filed in
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

// every promise must be fulfilled; a rejection is reported with its own words so a failure explains itself
const allMade = async (promises) => {
  const settled = await Promise.allSettled(promises);
  const failures = settled.filter((s) => s.status === "rejected").map((s) => `${s.reason?.code ?? s.reason?.statusCode ?? ""} ${s.reason?.message}`.trim());
  assert.deepEqual(failures, [], `${failures.length} of ${settled.length} were refused`);
  return settled.map((s) => s.value);
};

test("vendors created at the same moment each get their own number", { skip }, async () => {
  const made = await allMade(Array.from({ length: 5 }, (_, i) => Vendors.createVendor({ vendorName: `Race Vendor ${i}`, contactPerson: "Omar Ali", address: "Jebel Ali" })));
  const ids = made.map((v) => v.vendorId).sort();
  assert.equal(new Set(ids).size, 5, ids.join(", "));
  assert.ok(ids.every((id) => /^VEND\d{4}\d{3}$/.test(id)), ids.join(", "));
});

test("customers created at the same moment each get their own number", { skip }, async () => {
  const made = await allMade(Array.from({ length: 5 }, (_, i) => Customers.createCustomer({ customerName: `Race Customer ${i}`, contactPerson: "Sara Khan", billingAddress: "Deira, Dubai" })));
  const ids = made.map((c) => c.customerId).sort();
  assert.equal(new Set(ids).size, 5, ids.join(", "));
  assert.ok(ids.every((id) => /^CUST\d{4}\d{3}$/.test(id)), ids.join(", "));
});
