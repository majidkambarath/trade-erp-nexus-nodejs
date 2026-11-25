// Van loads through a request, over real HTTP against a spawned strict server: the salesman opens his own van's trip and
// asks, the BUILT-IN Storekeeper role loads, the salesman accepts; nobody acts on another salesman's van; bodies nobody
// meant to send are answered cleanly.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vlh_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const PORT = 4320 + Math.floor(Math.random() * 180);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";
const CODE = "vanload";

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
let rice, vanAli, vanOmar, tripId;

test("setup: an owner, a storekeeper on the ready-made role, two salesmen with their own vans, rice", { skip }, async () => {
  await Org.create({ legalName: "Van Load Foods LLC", code: CODE, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "internal", moduleOverrides: { vansales: true } });
  await person(CODE, "owner", { type: "super_admin" });
  await person(CODE, "sam", { type: "viewer", roleKey: "storekeeper" });
  const role = await call("owner", "POST", "/access/roles", { key: "van_salesman", name: "Van salesman", description: "Sells from a van", rank: 30, permissions: ["vansales.sell"] });
  assert.equal(role.status, 201, JSON.stringify(role.data));
  const ali = await person(CODE, "ali", { type: "viewer", roleKey: "van_salesman" });
  const omar = await person(CODE, "omar", { type: "viewer", roleKey: "van_salesman" });
  const cat = await call("owner", "POST", "/categories/categories", { name: "Food" });
  const vendor = await call("owner", "POST", "/vendors/vendors", { vendorName: "Wholesale Co", contactPerson: "x", address: "Dubai", paymentTerms: "Net 30" });
  const base = { categoryId: cat.body.category._id, unitOfMeasure: new mongoose.Types.ObjectId().toString(), origin: "UAE", brand: "x" };
  rice = (await call("owner", "POST", "/stock/stock", { ...base, sku: "RICE", itemName: "Rice 5kg", salesPrice: 20 })).body.stock;
  const buy = await call("owner", "POST", "/transactions/transactions", { type: "purchase_order", partyId: vendor.body._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: rice._id, description: "Rice 5kg", qty: 100, price: 10, rate: 10, vatPercent: 0 }] });
  assert.equal((await call("owner", "PATCH", `/transactions/transactions/${buy.body._id}/process`, { action: "approve" })).status, 200);
  vanAli = (await call("owner", "POST", "/van-sales/vans", { code: "van-1", name: "Van One", salesmanId: String(ali._id) })).body.id;
  vanOmar = (await call("owner", "POST", "/van-sales/vans", { code: "van-2", name: "Van Two", salesmanId: String(omar._id) })).body.id;
});

test("off: a salesman cannot open a trip; on: he opens his own van's trip, never another's", { skip }, async () => {
  assert.equal((await call("ali", "POST", "/van-sales/trips", { vanId: vanAli })).status, 403, "loads are not requested here, so trips are the storekeeper's");
  assert.equal((await call("owner", "PUT", "/van-sales/settings", { loadRequests: true })).status, 200);
  assert.equal((await call("ali", "POST", "/van-sales/trips", { vanId: vanOmar })).status, 403, "not his van");
  assert.equal((await call("ali", "POST", "/van-sales/trips", { vanId: vanAli, salesmanId: "000000000000000000000000" })).status, 403, "not for somebody else");
  const opened = await call("ali", "POST", "/van-sales/trips", { vanId: vanAli });
  assert.equal(opened.status, 201, JSON.stringify(opened.data));
  tripId = opened.body.id;
  assert.equal((await call("ali", "GET", `/van-sales/trips/${tripId}/suggested-load`)).status, 200, "he may start from the suggestion");
});

test("asked, loaded by the ready-made Storekeeper, accepted by the salesman; nobody does another's part", { skip }, async () => {
  assert.equal((await call("sam", "POST", `/van-sales/trips/${tripId}/load`, { lines: [{ stockId: rice._id, qty: 5 }] })).code, "VAN_LOAD_REQUEST_REQUIRED");
  const asked = await call("ali", "POST", `/van-sales/trips/${tripId}/load-requests`, { lines: [{ stockId: rice._id, qty: 30 }], note: "Usual" });
  assert.equal(asked.status, 201, JSON.stringify(asked.data));
  assert.equal((await call("omar", "POST", `/van-sales/trips/${tripId}/load-requests/1/cancel`)).status, 403, "another salesman cannot touch it");
  assert.equal((await call("ali", "POST", `/van-sales/trips/${tripId}/load-requests/1/load`, { lines: [{ stockId: rice._id, qty: 30 }] })).status, 403, "a salesman cannot load his own request");
  assert.equal((await call("ali", "GET", "/van-sales/load-requests")).status, 403);

  const list = await call("sam", "GET", "/van-sales/load-requests");
  assert.equal(list.status, 200, JSON.stringify(list.data));
  assert.equal(list.body[0].lines[0].free, 100);
  assert.deepEqual((await call("sam", "GET", "/van-sales/load-requests/counts")).body, { toLoad: 1, toAccept: 0 });
  const loaded = await call("sam", "POST", `/van-sales/trips/${tripId}/load-requests/1/load`, { lines: [{ stockId: rice._id, qty: 28 }] });
  assert.equal(loaded.status, 200, JSON.stringify(loaded.data));
  assert.deepEqual((await call("ali", "GET", "/van-sales/load-requests/counts")).body, { toLoad: 0, toAccept: 1 });
  assert.equal((await call("sam", "POST", `/van-sales/trips/${tripId}/load-requests/1/accept`, {})).status, 403, "the storekeeper cannot accept for the salesman");
  assert.equal((await call("omar", "POST", `/van-sales/trips/${tripId}/load-requests/1/accept`, {})).status, 403);
  assert.equal((await call("sam", "POST", `/van-sales/trips/${tripId}/depart`)).code, "LOAD_REQUEST_OPEN");

  const ok = await call("ali", "POST", `/van-sales/trips/${tripId}/load-requests/1/accept`, { lines: [{ stockId: rice._id, accepted: 27 }], reason: "One bag split" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.body.trip.sellable[0].qty, 27);
  assert.equal(ok.body.trip.loadRequests[0].status, "ACCEPTED");
  assert.equal((await call("sam", "POST", `/van-sales/trips/${tripId}/depart`)).status, 200);
  const ActivityLog = require("../../models/modules/financial/activityLogModel");
  const row = await as(CODE, () => ActivityLog.findOne({ action: "VAN_LOAD_ACCEPTED" }).lean());
  assert.match(row.summary, /1 units short: One bag split/);
});

test("bodies nobody meant to send", { skip }, async () => {
  for (const body of [{ lines: "rice" }, { lines: [{ stockId: { $ne: null }, qty: 1 }] }, { lines: [{ stockId: rice._id, qty: [1] }] }, { lines: [{ stockId: rice._id, qty: -2 }] }]) {
    const r = await call("ali", "POST", `/van-sales/trips/${tripId}/load-requests`, body);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)} -> ${r.status} ${JSON.stringify(r.data)}`);
  }
  for (const no of ["x", "1e3", "-1", "{}"]) {
    const r = await call("ali", "POST", `/van-sales/trips/${tripId}/load-requests/${encodeURIComponent(no)}/accept`, {});
    assert.ok(r.status >= 400 && r.status < 500, `${no} -> ${r.status}`);
  }
});
