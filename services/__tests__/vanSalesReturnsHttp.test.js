// Goods taken back without an invoice, over real HTTP against a spawned strict server: who may change the rule and the
// reasons, a salesman's return through the real route (quote, then the return, then the limit), another salesman's trip
// refused, and hostile bodies answered cleanly.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vrh_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const PORT = 4130 + Math.floor(Math.random() * 180);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";
const CODE = "vanret";

let child, M, Org, ctx;
let logs = "";
const T = {};

async function call(who, method, url, body) {
  const headers = { Authorization: `Bearer ${T[who]}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode };
}
const as = (org, fn) => ctx.runWithTenant({ companyId: org, branchId: "main" }, fn);
async function person(org, who, fields) {
  const doc = await as(org, () => new M.Admin({ name: who, email: `${who}@${org}.test`, password: PASSWORD, status: "active", isActive: true, ...fields }).save());
  const login = await fetch(`${BASE}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${who}@${org}.test`, password: PASSWORD }) });
  const json = await login.json();
  assert.equal(login.status, 200, JSON.stringify(json));
  T[who] = json.data.tokens.accessToken;
  return doc;
}

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = { Admin: require("../../models/core/adminModel"), Customer: require("../../models/modules/customerModel"), Transaction: require("../../models/modules/transactionModel") };
  Org = require("../core/organisationService");
  ctx = require("../../utils/tenantContext");
  await mongoose.connection.syncIndexes();
  const deadline = Date.now() + 90000;
  for (;;) {
    try { const h = await fetch(`${BASE}/health`); if (h.ok && (await h.json()).ready !== false) break; } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.after(async () => {
  if (skip) return;
  child?.kill();
  if (mongoose.connection.readyState === 1) {
    assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

let rice, tripId, otherTripId, cust;
const back = (who, body, trip = tripId) => call(who, "POST", `/van-sales/trips/${trip}/return`, { customerId: String(cust._id), ...body });
const quote = (who, body, trip = tripId) => call(who, "POST", `/van-sales/trips/${trip}/return-quote`, { customerId: String(cust._id), ...body });
const returns = () => as(CODE, () => M.Transaction.countDocuments({ type: "sales_return" }));

test("setup: an owner, two salesmen with their own vans, rice, a customer", { skip }, async () => {
  await Org.create({ legalName: "Van Return Foods LLC", code: CODE, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "internal", moduleOverrides: { vansales: true } });
  await person(CODE, "owner", { type: "super_admin" });
  // the salesmen hold the ready-made Van salesman role (utils/permissions.js)
  const ali = await person(CODE, "ali", { type: "viewer", roleKey: "van_salesman" });
  const omar = await person(CODE, "omar", { type: "viewer", roleKey: "van_salesman" });

  const cat = await call("owner", "POST", "/categories/categories", { name: "Food" });
  const vendor = await call("owner", "POST", "/vendors/vendors", { vendorName: "Wholesale Co", contactPerson: "x", address: "Dubai", paymentTerms: "Net 30" });
  const base = { categoryId: cat.body.category._id, unitOfMeasure: new mongoose.Types.ObjectId().toString(), origin: "UAE", brand: "x" };
  rice = (await call("owner", "POST", "/stock/stock", { ...base, sku: "RICE", itemName: "Rice 5kg", salesPrice: 20 })).body.stock;
  const buy = await call("owner", "POST", "/transactions/transactions", { type: "purchase_order", partyId: vendor.body._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: rice._id, description: "Rice 5kg", qty: 100, price: 10, rate: 10, vatPercent: 0 }] });
  assert.equal((await call("owner", "PATCH", `/transactions/transactions/${buy.body._id}/process`, { action: "approve" })).status, 200);
  cust = await as(CODE, () => M.Customer.create({ customerId: "C1", customerName: "Al Noor Grocery", contactPerson: "Noor", phone: "0501111111", shippingAddress: "Dubai", paymentTerms: "Net 30" }));
  for (const [who, code] of [[ali, "van-1"], [omar, "van-2"]]) {
    const vanId = (await call("owner", "POST", "/van-sales/vans", { code, name: code, salesmanId: String(who._id) })).body.id;
    const id = (await call("owner", "POST", "/van-sales/trips", { vanId })).body.id;
    assert.equal((await call("owner", "POST", `/van-sales/trips/${id}/load`, { lines: [{ stockId: rice._id, qty: 20 }] })).status, 200);
    assert.equal((await call("owner", "POST", `/van-sales/trips/${id}/depart`)).status, 200);
    if (who === ali) tripId = id; else otherTripId = id;
  }
});

test("the rule and the reasons: the salesman reads them, only a manager changes them, and the list is checked", { skip }, async () => {
  const read = await call("ali", "GET", "/van-sales/settings");
  assert.equal(read.status, 200);
  assert.equal(read.body.returnsWithoutInvoice, false);
  assert.equal(read.body.returnReasons.length, 6);
  assert.equal((await call("ali", "PUT", "/van-sales/settings", { returnsWithoutInvoice: true })).status, 403, "a salesman cannot let himself take goods back unchecked");
  const bad = await call("owner", "PUT", "/van-sales/settings", { returnReasons: ["Expired", "expired"] });
  assert.equal(bad.status, 400);
  assert.equal(bad.code, "VAN_SETTING_INVALID");
  assert.equal((await call("owner", "PUT", "/van-sales/settings", { returnReasons: "Expired" })).code, "VAN_SETTING_INVALID");
  assert.equal((await call("owner", "PUT", "/van-sales/settings", { maxReturnWithoutInvoice: { $gt: 0 } })).code, "VAN_SETTING_INVALID");
  const saved = await call("owner", "PUT", "/van-sales/settings", { returnsWithoutInvoice: true, maxReturnWithoutInvoice: 60, returnReasons: ["Expired", "Damaged", "Not selling"] });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const trip = await call("ali", "GET", `/van-sales/trips/${tripId}`);
  assert.deepEqual(trip.body.rules.returnReasons, ["Expired", "Damaged", "Not selling"], "the phone is handed the list it must offer");
});

test("a salesman's return without an invoice: quoted, taken, audited; past the limit refused and nothing written", { skip }, async () => {
  const lines = [{ stockId: rice._id, qty: 2, condition: "damaged" }];
  const q = await quote("ali", { lines });
  assert.equal(q.status, 200, JSON.stringify(q.data));
  assert.equal(q.body.lines[0].price, 20);
  assert.equal(q.body.limit, 60);
  const done = await back("ali", { reason: "Expired", note: "Two sachets past date", lines });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  assert.equal(done.body.creditNote.totalAmount, q.body.total, "credited exactly what was quoted");
  assert.equal(done.body.trip.returns.at(-1).reason, "Expired");
  assert.equal(done.body.trip.damaged[0].qty, 2, "damaged goods kept apart on the van");
  const ActivityLog = require("../../models/modules/financial/activityLogModel");
  const row = await as(CODE, () => ActivityLog.findOne({ action: "VAN_RETURN" }).sort({ _id: -1 }).lean());
  assert.match(row.summary, /without an invoice/, "the audit trail says no invoice stood behind it");

  const big = [{ stockId: rice._id, qty: 5 }];
  const over = await quote("ali", { lines: big });
  assert.equal(over.body.overLimit, true);
  const before = await returns();
  const refused = await back("ali", { reason: "Expired", lines: big });
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "VAN_RETURN_OVER_LIMIT");
  assert.equal(await returns(), before, "nothing written");
  const owner = await back("owner", { reason: "Expired", lines: big });
  assert.equal(owner.status, 201, "a supervisor takes it back whatever the limit");

  const priced = await back("ali", { reason: "Expired", lines: [{ stockId: rice._id, qty: 1, price: 50 }] });
  assert.equal(priced.code, "PRICE_LOCKED", "a salesman cannot raise the credit");
});

test("another salesman's trip, and bodies nobody meant to send", { skip }, async () => {
  const theirs = await quote("ali", { lines: [{ stockId: rice._id, qty: 1 }] }, otherTripId);
  assert.equal(theirs.status, 403, "Ali cannot quote on Omar's van");
  assert.equal((await back("ali", { reason: "Expired", lines: [{ stockId: rice._id, qty: 1 }] }, otherTripId)).status, 403);
  for (const body of [
    { reason: ["Expired"], lines: [{ stockId: rice._id, qty: 1 }] },
    { reason: { $ne: "" }, lines: [{ stockId: rice._id, qty: 1 }] },
    { reason: "Expired", lines: [{ stockId: { $ne: null }, qty: 1 }] },
    { reason: "Expired", lines: [{ stockId: rice._id, qty: [1] }] },
    { reason: "Expired", lines: "rice" },
    { reason: "Expired", returnOfId: { $ne: null }, lines: [{ stockId: rice._id, qty: 1 }] },
  ]) {
    const r = await back("ali", body);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)} -> ${r.status} ${JSON.stringify(r.data)}`);
  }
});

test("by item over the real routes: his own trip only, strictly read, the credit slip printed again", { skip }, async () => {
  const items = (who, trip = tripId) => call(who, "GET", `/van-sales/trips/${trip}/customers/${cust._id}/returnable-items`);
  const plan = (who, body, trip = tripId) => call(who, "POST", `/van-sales/trips/${trip}/return-plan`, { customerId: String(cust._id), ...body });
  const take = (who, body, trip = tripId) => call(who, "POST", `/van-sales/trips/${trip}/return-items`, { customerId: String(cust._id), ...body });
  assert.equal((await items("ali", otherTripId)).status, 403);
  assert.equal((await plan("ali", { lines: [{ stockId: rice._id, qty: 1 }] }, otherTripId)).status, 403);
  assert.equal((await take("ali", { reason: "Expired", lines: [{ stockId: rice._id, qty: 1 }] }, otherTripId)).status, 403);
  assert.equal((await items("ali")).status, 200);
  for (const body of [{ lines: [{ stockId: { $ne: null }, qty: 1 }] }, { lines: [{ stockId: rice._id, qty: 1, condition: { $ne: "x" } }] }, { lines: "rice" }, { lines: [[1]] }, { customerId: { $ne: null }, lines: [{ stockId: rice._id, qty: 1 }] }]) {
    const r = await take("ali", { reason: "Expired", ...body });
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)} -> ${r.status} ${JSON.stringify(r.data)}`);
  }
  // nothing of this shop's was sold on the trip, so one unit goes without an invoice (switched on above, within the limit)
  const done = await take("ali", { reason: "Damaged", lines: [{ stockId: rice._id, qty: 1, condition: "damaged" }] });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  const note = done.body.creditNotes[0];
  const slip = await call("ali", "GET", `/van-sales/trips/${tripId}/returns/${note._id}/slip`);
  assert.equal(slip.status, 200, JSON.stringify(slip.data));
  assert.deepEqual([slip.body.kind, slip.body.invoice.number], ["credit", note.transactionNo]);
  assert.equal((await call("omar", "GET", `/van-sales/trips/${tripId}/returns/${note._id}/slip`)).status, 403);
  assert.equal((await call("omar", "GET", `/van-sales/trips/${otherTripId}/returns/${note._id}/slip`)).status, 404, "a note of another trip is not found on this one");
});
