// A customer's usual way of paying the van salesman (Customer.vanPaymentMode), against a throwaway database: kept by the
// customer's own save (create, edit, clear, import), refused when it is not one of the ways, and carried to the van (the
// pick list, which also answers a named customer past its page, the door insight and the offline pack).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vpm_${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Org: require("../core/organisationService"),
    Customers: require("../customer/customerService"),
    Imports: require("../masters/partyImportService"),
    Van: require("../vansales/vanService"),
    Trip: require("../vansales/vanTripService"),
    Sales: require("../vansales/vanTripSales"),
    Chart: require("../financial/defaultChartService"),
    Customer: require("../../models/modules/customerModel"),
    Admin: require("../../models/core/adminModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
  await svc.Chart.provision();
  await svc.Org.ensureDefault();
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

let cheque, plain;
const stored = async (id) => (await svc.Customer.findById(id).lean()).vanPaymentMode;

test("a customer is saved with how they usually pay, and without one when nothing is said", { skip }, async () => {
  cheque = await svc.Customers.createCustomer({ customerName: "Al Noor Grocery", vanPaymentMode: "cheque" });
  plain = await svc.Customers.createCustomer({ customerName: "Bin Zayed Market" });
  assert.equal(await stored(cheque._id), "cheque");
  assert.equal(await stored(plain._id), undefined, "no preference is stored as no field");
  const blank = await svc.Customers.createCustomer({ customerName: "Carrefour Corner", vanPaymentMode: "" });
  assert.equal(await stored(blank._id), undefined);
  await assert.rejects(() => svc.Customers.createCustomer({ customerName: "Delta Foods", vanPaymentMode: "bitcoin" }), { code: "INVALID_VAN_PAYMENT_MODE" });
  await assert.rejects(() => svc.Customers.createCustomer({ customerName: "Delta Foods", vanPaymentMode: ["cash"] }), { code: "INVALID_VAN_PAYMENT_MODE" });
  assert.equal(await svc.Customer.countDocuments({ customerName: "Delta Foods" }), 0, "a refused create writes nothing");
});

test("an edit changes it, leaves it when it does not name it, and clears it with an empty value", { skip }, async () => {
  await svc.Customers.updateCustomer(plain._id, { vanPaymentMode: "credit" });
  assert.equal(await stored(plain._id), "credit");
  await svc.Customers.updateCustomer(plain._id, { salesPerson: "Rashid" });
  assert.equal(await stored(plain._id), "credit", "an edit that says nothing keeps it");
  await assert.rejects(() => svc.Customers.updateCustomer(plain._id, { vanPaymentMode: "later maybe" }), { code: "INVALID_VAN_PAYMENT_MODE" });
  assert.equal(await stored(plain._id), "credit", "a refused edit changes nothing");
  await svc.Customers.updateCustomer(plain._id, { vanPaymentMode: "" });
  assert.equal(await stored(plain._id), undefined);
  const raw = await svc.Customer.collection.findOne({ _id: plain._id });
  assert.equal("vanPaymentMode" in raw, false, "cleared means removed, not stored empty");
});

test("a spreadsheet brings it in", { skip }, async () => {
  const r = await svc.Imports.run("customer", [{ line: 2, name: "Eastern Mart", vanPaymentMode: "Pay later" }, { line: 3, name: "Falcon Store", vanPaymentMode: "crypto" }], { dryRun: false });
  assert.equal(r.summary.created, 1);
  const eastern = await svc.Customer.findOne({ customerName: "Eastern Mart" }).lean();
  assert.equal(eastern.vanPaymentMode, "credit");
});

test("the van is told: the pick list (and a named customer past its page), the door and the offline pack", { skip }, async () => {
  const all = await svc.Van.customerChoices();
  assert.equal(all.find((c) => c.name === "Al Noor Grocery").payMode, "cheque");
  assert.equal(all.find((c) => c.name === "Bin Zayed Market").payMode, "");
  // a page of one: the customer being sold to is still in the answer when named
  const last = await svc.Customer.findOne({ customerName: "Eastern Mart" }).lean();
  const page = await svc.Van.customerChoices({ limit: "1", ids: `${last._id},not-an-id` });
  assert.deepEqual(page.map((c) => [c.name, c.payMode]), [["Al Noor Grocery", "cheque"], ["Eastern Mart", "credit"]]);
  assert.equal((await svc.Van.customerChoices({ limit: "1", ids: String(cheque._id) })).length, 1, "never twice");

  const salesman = await svc.Admin.create({ name: "Rashid", email: `rashid-pm.${Date.now()}@test.uae`, password: "12312312", type: "operator" });
  const route = await svc.Van.createRoute({ name: "North", customers: [{ customerId: String(cheque._id) }] }, "tester");
  const van = await svc.Van.create({ code: "VAN-P", name: "Van P", salesmanId: String(salesman._id), defaultRouteId: route.id }, "tester");
  const trip = await svc.Trip.open({ vanId: van._id }, "tester");
  assert.equal((await svc.Sales.insight(trip._id, cheque._id)).payMode, "cheque");
  assert.equal((await svc.Sales.insight(trip._id, plain._id)).payMode, "");
  const pack = await svc.Sales.offlinePack(trip._id);
  assert.deepEqual(pack.customers.map((c) => [c.name, c.payMode]), [["Al Noor Grocery", "cheque"]]);
});
