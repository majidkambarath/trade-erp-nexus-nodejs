// The van sales rules over real HTTP against a spawned strict server: who reads and who changes them, that a change is
// audited, that a hostile body is refused cleanly, and that a rule bites at the door a salesman really uses (his own
// trip's sell) while a supervisor is not held to it.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vset_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3940 + Math.floor(Math.random() * 180);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";
const CODE = "vanrules";

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
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0", SUPPORT_CONTACT: "help@zarvia.example" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = { Admin: require("../../models/core/adminModel"), Customer: require("../../models/modules/customerModel") };
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

let rice, vanId, tripId, onRoute, offRoute, ali;
const sell = (who, customer, extra = {}, item = {}) => call(who, "POST", `/van-sales/trips/${tripId}/sell`, { customerId: String(customer._id), items: [{ itemId: rice._id, qty: 1, ...item }], ...extra });
const rules = (changes) => call("owner", "PUT", "/van-sales/settings", changes);

test("setup: an organisation with van sales, one without, a supervisor, a salesman and a viewer, and a van out on a route", { skip }, async () => {
  await Org.create({ legalName: "Van Rules Foods LLC", code: CODE, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "internal", moduleOverrides: { vansales: true } });
  await Org.create({ legalName: "No Vans Trading LLC", code: "novans2", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "internal" });
  await person(CODE, "owner", { type: "super_admin" });
  await person("novans2", "plain", { type: "super_admin" });
  for (const [key, permissions] of [["van_salesman", ["vansales.sell"]], ["van_viewer", ["vansales.view"]]]) {
    const role = await call("owner", "POST", "/access/roles", { key, name: key, description: key, rank: 30, permissions });
    assert.equal(role.status, 201, JSON.stringify(role.data));
  }
  ali = await person(CODE, "ali", { type: "viewer", roleKey: "van_salesman" });
  await person(CODE, "vera", { type: "viewer", roleKey: "van_viewer" });

  const cat = await call("owner", "POST", "/categories/categories", { name: "Food" });
  const vendor = await call("owner", "POST", "/vendors/vendors", { vendorName: "Wholesale Co", contactPerson: "x", address: "Dubai", paymentTerms: "Net 30" });
  const base = { categoryId: cat.body.category._id, unitOfMeasure: new mongoose.Types.ObjectId().toString(), origin: "UAE", brand: "x" };
  rice = (await call("owner", "POST", "/stock/stock", { ...base, sku: "RICE", itemName: "Rice 5kg", salesPrice: 20 })).body.stock;
  const buy = await call("owner", "POST", "/transactions/transactions", { type: "purchase_order", partyId: vendor.body._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: rice._id, description: "Rice 5kg", qty: 100, price: 10, rate: 10, vatPercent: 0 }] });
  assert.equal((await call("owner", "PATCH", `/transactions/transactions/${buy.body._id}/process`, { action: "approve" })).status, 200);
  const mk = (id, name, terms) => as(CODE, () => M.Customer.create({ customerId: id, customerName: name, contactPerson: name, phone: "0501111111", shippingAddress: "Dubai", paymentTerms: terms }));
  onRoute = await mk("C1", "Al Noor Grocery", "Net 30");
  offRoute = await mk("C2", "Corner Shop", "Net 30");
  const route = await call("owner", "POST", "/van-sales/routes", { name: "North", customers: [{ customerId: String(onRoute._id) }] });
  assert.equal(route.status, 201, JSON.stringify(route.data));
  const van = await call("owner", "POST", "/van-sales/vans", { code: "van-1", name: "Van One", salesmanId: String(ali._id), defaultRouteId: route.body.id });
  vanId = van.body.id;
  tripId = (await call("owner", "POST", "/van-sales/trips", { vanId })).body.id;
  assert.equal((await call("owner", "POST", `/van-sales/trips/${tripId}/load`, { lines: [{ stockId: rice._id, qty: 40 }] })).status, 200);
  assert.equal((await call("owner", "POST", `/van-sales/trips/${tripId}/depart`)).status, 200);
});

test("who reads the rules and who changes them", { skip }, async () => {
  for (const who of ["owner", "ali", "vera"]) {
    const r = await call(who, "GET", "/van-sales/settings");
    assert.equal(r.status, 200, who);
    assert.equal(r.body.customers, "any", "nothing saved: the old behaviour");
    assert.equal(r.body.farMetres, 300);
    assert.deepEqual(r.body.paymentModes, ["cash", "cheque"]);
  }
  assert.equal((await call("plain", "GET", "/van-sales/settings")).code, "MODULE_NOT_IN_PLAN");
  assert.equal((await call("plain", "PUT", "/van-sales/settings", { customers: "route" })).code, "MODULE_NOT_IN_PLAN");
  for (const who of ["ali", "vera"]) {
    const r = await call(who, "PUT", "/van-sales/settings", { customers: "route" });
    assert.equal(r.status, 403, who);
    assert.equal(r.code, "PERMISSION_DENIED", who);
  }
  assert.equal((await call("ali", "GET", "/van-sales/settings")).body.customers, "any", "a refused change changed nothing");
});

test("a change is saved, merged, audited with before and after, and read back by everyone", { skip }, async () => {
  const one = await rules({ customers: "route", farMetres: 450 });
  assert.equal(one.status, 200, JSON.stringify(one.data));
  assert.equal(one.body.customers, "route");
  const two = await rules({ quietHours: 3 });
  assert.equal(two.body.customers, "route", "a second change keeps the first");
  assert.equal((await call("ali", "GET", "/van-sales/settings")).body.farMetres, 450);
  const trail = await call("owner", "GET", "/accounting/audit-log?limit=100");
  const rows = trail.body.rows || trail.body.logs || trail.body;
  const row = (Array.isArray(rows) ? rows : []).find((r) => r.action === "VAN_SALES_SETTINGS_SAVED");
  assert.ok(row, "the change is on the record");
  assert.equal((await rules({ customers: "any", farMetres: 300, quietHours: 2 })).status, 200);
});

test("hostile or wrong bodies are refused cleanly, never a 500, and store nothing", { skip }, async () => {
  const before = (await call("owner", "GET", "/van-sales/settings")).body;
  const bad = [
    { paymentModes: ["card"] }, { paymentModes: [] }, { paymentModes: "cash" }, { farMetres: "far" }, { farMetres: 1 }, { farMetres: [300] },
    { customers: { $ne: "route" } }, { creditSales: ["never"] }, { slipFooter: { $gt: "" } }, { maxDiscountPercent: 500 }, { returnsAllowed: "yes" },
  ];
  for (const body of bad) {
    const r = await rules(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.code, "VAN_SETTING_INVALID", JSON.stringify(body));
  }
  for (const body of [[], "route", 5, null]) {
    const r = await call("owner", "PUT", "/van-sales/settings", body);
    assert.ok([400, 422].includes(r.status), `${JSON.stringify(body)} -> ${r.status}`);
  }
  // keys that are not settings are ignored: an attempt to write somewhere else stores nothing
  const sneaky = await rules({ companyId: "other", crm: { autoAdvance: false }, __proto__: { customers: "route" } });
  assert.equal(sneaky.status, 200);
  assert.deepEqual((await call("owner", "GET", "/van-sales/settings")).body, before, "nothing but the real settings could change");
});

test("a van's own rules over HTTP: set by a supervisor, validated, not by a salesman", { skip }, async () => {
  const set = await call("owner", "PUT", `/van-sales/vans/${vanId}`, { name: "Van One", rules: { creditSales: "never", paymentModes: ["cash"] } });
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.equal(set.body.rules.creditSales, "never");
  assert.equal((await call("vera", "GET", `/van-sales/vans/${vanId}`)).body.rules.creditSales, "never");
  const bad = await call("owner", "PUT", `/van-sales/vans/${vanId}`, { name: "Van One", rules: { customers: { $ne: "x" } } });
  assert.equal(bad.status, 400);
  assert.equal(bad.code, "VAN_SETTING_INVALID");
  assert.equal((await call("ali", "PUT", `/van-sales/vans/${vanId}`, { name: "Van One", rules: { creditSales: "allowed" } })).status, 403, "a salesman cannot loosen his own van's rules");
  assert.equal((await call("owner", "GET", `/van-sales/vans/${vanId}`)).body.rules.creditSales, "never");
  // the trip carries what is in force, for the phone
  const mine = await call("ali", "GET", "/van-sales/trips/mine");
  assert.equal(mine.body[0].rules.creditSales, "never");
  assert.deepEqual(mine.body[0].rules.paymentModes, ["cash"]);
  const cleared = await call("owner", "PUT", `/van-sales/vans/${vanId}`, { name: "Van One", rules: {} });
  assert.equal(cleared.body.rules, undefined);
});

test("a rule bites at the salesman's own door, and the supervisor is not held to it", { skip }, async () => {
  await rules({ creditSales: "never", customers: "route", priceChange: "locked" });
  const credit = await sell("ali", onRoute);
  assert.equal(credit.status, 409, JSON.stringify(credit.data));
  assert.equal(credit.code, "VAN_PAYMENT_REQUIRED");
  assert.equal((await sell("ali", offRoute, { payNow: { mode: "cash", full: true } })).code, "CUSTOMER_NOT_ON_ROUTE");
  assert.equal((await sell("ali", onRoute, { payNow: { mode: "cash", full: true } }, { price: 25 })).code, "PRICE_LOCKED");
  assert.equal((await sell("ali", onRoute, { payNow: { mode: "cash", full: true } }, { price: 20, discountPercent: 10 })).code, "DISCOUNT_TOO_HIGH");
  // an order for the next visit is a door of its own: the route rule is judged there too, before anything else
  const order = await call("ali", "POST", `/van-sales/trips/${tripId}/preorders`, { customerId: String(offRoute._id), items: [{ itemId: rice._id, qty: 1 }] });
  assert.equal(order.code, "CUSTOMER_NOT_ON_ROUTE");
  const fine = await sell("ali", onRoute, { payNow: { mode: "cash", full: true } }, { price: 20 });
  assert.equal(fine.status, 201, JSON.stringify(fine.data));
  assert.equal(fine.body.receipt.status, "approved");
  // the supervisor sells off the route, at his own price. Being paid at the door is the business's rule, not a permission: it holds for him too
  const unpaid = await sell("owner", offRoute, {}, { price: 15 });
  assert.equal(unpaid.code, "VAN_PAYMENT_REQUIRED");
  const boss = await sell("owner", offRoute, { payNow: { mode: "cash", full: true } }, { price: 15 });
  assert.equal(boss.status, 201, JSON.stringify(boss.data));
  assert.equal(boss.body.receipt.status, "approved");
  await rules({ creditSales: "allowed", customers: "any", priceChange: "up_only" });
});

test("a salesman cannot give a discount the organisation has not allowed, even by sending it in a sync", { skip }, async () => {
  const direct = await sell("ali", onRoute, {}, { discountPercent: 5 });
  assert.equal(direct.code, "DISCOUNT_TOO_HIGH");
  const synced = await call("ali", "POST", `/van-sales/trips/${tripId}/sync`, { ops: [{ clientId: "op-1", kind: "sell", at: new Date().toISOString(), body: { customerId: String(onRoute._id), items: [{ itemId: rice._id, qty: 1, discountPercent: 5 }] } }] });
  assert.equal(synced.status, 200, JSON.stringify(synced.data));
  assert.equal(synced.body.results[0].ok, false);
  assert.equal(synced.body.results[0].error.code, "DISCOUNT_TOO_HIGH");
  await rules({ maxDiscountPercent: 5 });
  assert.equal((await sell("ali", onRoute, {}, { discountPercent: 5 })).status, 201);
  assert.equal((await sell("ali", onRoute, {}, { discountPercent: 6 })).code, "DISCOUNT_TOO_HIGH");
});
