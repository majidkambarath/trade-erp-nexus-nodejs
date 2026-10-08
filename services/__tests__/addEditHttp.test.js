// Add and Edit are separate permissions: someone may add a record without being able to change one that exists, and the
// other way round. Against a strict server with real sign-ins, with roles made through the API the way a customer's
// administrator makes them. Also: editing an item may not move its quantity on hand - that is a stock adjustment, and
// needs its own permission - so a person who may edit cannot correct away a shortage.
//
// A refusal must be the server's own 403 PERMISSION_DENIED. An allowed call only has to get PAST the gate: it may still
// fail on its payload or on an id that matches nothing (404), which is a different answer and proves the gate let it in.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";
const FAKE = "64b64b64b64b64b64b64b64b";

let child, M, Org, ctx;
let logs = "";
const T = {};
const ID = {};

async function call(method, url, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode, details: data?.details };
}
const as = (code, fn) => ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const api = (who, method, url, body) => call(method, url, { token: T[who], body: method === "GET" || method === "DELETE" ? undefined : body });
const login = async (email) => (await call("POST", "/login", { body: { email, password: PASSWORD } })).body?.tokens?.accessToken;

const cannot = async (who, method, url, body) => {
  const r = await api(who, method, url, body);
  assert.equal(r.status, 403, `${who} ${method} ${url} should be refused: ${r.status} ${JSON.stringify(r.data)?.slice(0, 200)}`);
  assert.equal(r.code, "PERMISSION_DENIED", `${who} ${method} ${url}`);
  return r;
};
const can = async (who, method, url, body) => {
  const r = await api(who, method, url, body);
  assert.notEqual(r.status, 403, `${who} ${method} ${url} should get past the gate: ${JSON.stringify(r.data)?.slice(0, 200)}`);
  assert.notEqual(r.status, 401, `${who} ${method} ${url}`);
  return r;
};

// a role made the way a customer's administrator makes it, and a person holding it
async function roleAndPerson(key, permissions) {
  const made = await api("owner", "POST", "/access/roles", { key, name: key.replace(/_/g, " "), rank: 50, permissions });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const added = await api("owner", "POST", "/access/users", { name: key, email: `${key}@acc.test`, password: PASSWORD, role: key });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  T[key] = await login(`${key}@acc.test`);
  assert.ok(T[key], `${key} signs in`);
}

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = { Admin: require("../../models/core/adminModel"), Stock: require("../../models/modules/stockModel") };
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

test("an organisation, its owner, an item, and three roles: one that only adds, one that only edits, one that edits and adjusts", { skip }, async () => {
  assert.equal((await Org.create({ legalName: "Acc Trading", code: "acc", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" })).provisioning.complete, true);
  await as("acc", () => new M.Admin({ name: "owner", email: "owner@acc.test", password: PASSWORD, status: "active", isActive: true, type: "super_admin" }).save());
  T.owner = await login("owner@acc.test");
  assert.ok(T.owner);
  ID.stock = String((await as("acc", () => new M.Stock({ itemId: "RICE5", sku: "RICE5", itemName: "Rice 5kg", category: new mongoose.Types.ObjectId(), currentStock: 10 }).save()))._id);

  await roleAndPerson("adder", ["sales.create", "inventory.create", "finance.create"]);
  await roleAndPerson("editor", ["sales.edit", "inventory.edit", "finance.edit"]);
  await roleAndPerson("editor_adjuster", ["inventory.edit", "inventory.adjust"]);
});

test("each one brings View with it and nothing of the other: add does not edit, edit does not add", { skip }, async () => {
  const roles = (await api("owner", "GET", "/access/roles")).body.roles;
  const held = (key) => roles.find((r) => r.key === key).permissions;
  assert.ok(held("adder").includes("sales.view") && held("adder").includes("lookups.view"));
  assert.ok(!held("adder").some((k) => k.endsWith(".edit")), "adding brings no editing");
  assert.ok(held("editor").includes("sales.view") && held("editor").includes("lookups.view"));
  assert.ok(!held("editor").some((k) => k.endsWith(".create")), "editing brings no adding");
  // both the buttons and the server read the same expanded set from the status
  const status = (await api("editor", "GET", "/organisation/status")).body.me.grants;
  assert.ok(status.includes("sales.edit") && !status.includes("sales.create"));
});

test("a person who may only ADD adds, and is refused every change to what exists", { skip }, async () => {
  await can("adder", "POST", "/customers", {});
  await can("adder", "POST", "/quotations", {});
  await can("adder", "POST", "/stock/stock", {});
  await can("adder", "POST", "/vouchers/vouchers", { voucherType: "receipt" });
  await can("adder", "POST", "/transactions/transactions", { type: "sales_order" });

  await cannot("adder", "PUT", `/customers/${FAKE}`, {});
  await cannot("adder", "PUT", `/quotations/${FAKE}`, {});
  await cannot("adder", "PUT", `/stock/stock/${ID.stock}`, { itemName: "Renamed" });
  await cannot("adder", "PUT", `/vouchers/vouchers/${FAKE}`, {});
  await cannot("adder", "PUT", `/transactions/transactions/${FAKE}`, { type: "sales_order" });
});

test("a person who may only EDIT changes what exists, and is refused every new record", { skip }, async () => {
  await can("editor", "PUT", `/customers/${FAKE}`, {});
  await can("editor", "PUT", `/quotations/${FAKE}`, {});
  await can("editor", "PUT", `/vouchers/vouchers/${FAKE}`, {});
  await can("editor", "PUT", `/transactions/transactions/${FAKE}`, { type: "sales_order" });

  await cannot("editor", "POST", "/customers", {});
  await cannot("editor", "POST", "/quotations", {});
  await cannot("editor", "POST", "/stock/stock", {});
  await cannot("editor", "POST", "/vouchers/vouchers", { voucherType: "receipt" });
  await cannot("editor", "POST", "/transactions/transactions", { type: "sales_order" });
});

test("on the shared trade-document router the module follows the document, not the address", { skip }, async () => {
  // this editor holds sales.edit, not purchase.edit: the same URL is open for a sales order and shut for a purchase order
  await can("editor", "PUT", `/transactions/transactions/${FAKE}`, { type: "sales_return" });
  await cannot("editor", "PUT", `/transactions/transactions/${FAKE}`, { type: "purchase_order" });
  await cannot("editor", "PUT", `/transactions/transactions/${FAKE}`, { type: "purchase_return" });
});

test("editing an item changes its details, never its quantity on hand, unless the person may adjust stock", { skip }, async () => {
  const before = await as("acc", () => M.Stock.findById(ID.stock));
  assert.equal(before.currentStock, 10);

  // the item form sends the unchanged quantity back with every save: that is an edit, not an adjustment
  const rename = await api("editor", "PUT", `/stock/stock/${ID.stock}`, { itemName: "Rice 5kg (bag)", currentStock: 10 });
  assert.equal(rename.status, 200, JSON.stringify(rename.data));
  assert.equal((await as("acc", () => M.Stock.findById(ID.stock))).itemName, "Rice 5kg (bag)");

  // a different quantity is a stock adjustment: refused, and the quantity stays put
  const bypass = await cannot("editor", "PUT", `/stock/stock/${ID.stock}`, { currentStock: 3 });
  assert.deepEqual(bypass.details.required, ["inventory.adjust"]);
  assert.equal((await as("acc", () => M.Stock.findById(ID.stock))).currentStock, 10, "the shortage was not corrected away");

  // the quantity route has always been its own permission
  await cannot("editor", "PATCH", `/stock/stock/${ID.stock}/quantity`, { quantity: 3 });

  // someone who holds both is let through
  const adjusted = await can("editor_adjuster", "PUT", `/stock/stock/${ID.stock}`, { currentStock: 8, unitCost: 4 });
  assert.notEqual(adjusted.code, "PERMISSION_DENIED");
});

test("the refusal names what was missing, so the screen can say so", { skip }, async () => {
  const r = await cannot("adder", "PUT", `/customers/${FAKE}`, {});
  assert.deepEqual(r.details.required, ["sales.edit"]);
  assert.equal(r.details.role, "adder");
  const s = await cannot("editor", "POST", "/customers", {});
  assert.deepEqual(s.details.required, ["sales.create"]);
});

test("the built-in roles keep working as they always did: an operator, a sales executive and a storekeeper can still change what they enter", { skip }, async () => {
  for (const [key, type, probes] of [
    ["operator", "operator", [["PUT", `/customers/${FAKE}`], ["PUT", `/vouchers/vouchers/${FAKE}`], ["PUT", `/stock/stock/${ID.stock}`, { itemName: "Rice" }]]],
    ["salesx", "sales", [["PUT", `/quotations/${FAKE}`], ["PUT", `/customers/${FAKE}`]]],
    ["store", "storekeeper", [["PUT", `/stock/stock/${ID.stock}`, { itemName: "Rice" }]]],
  ]) {
    await as("acc", () => new M.Admin({ name: key, email: `${key}@acc.test`, password: PASSWORD, status: "active", isActive: true, type: "viewer", roleKey: type }).save());
    T[key] = await login(`${key}@acc.test`);
    for (const [m, u, b] of probes) await can(key, m, u, b || {});
  }
});
