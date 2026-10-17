// Productions over HTTP against a strict server with real sign-ins (/api/v1/productions).
//
// Who may do what: reading needs inventory.view; saving, posting and reversing need inventory.adjust; a production with
// cost lines moves expenses into stock, so it also needs finance.create (and finance.deletePosted to reverse one).
// Also: the warning tick, the cost report, the audit rows, and that another branch cannot see a production.
//
// A refusal must be the server's own 403 PERMISSION_DENIED. An allowed call only has to get PAST the gate.
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

let child, M, Org, ctx;
let logs = "";
const T = {};
const S = {};

async function call(method, url, { body, token, branch } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (branch) headers["X-Branch"] = branch;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode, details: data?.details };
}
const as = (fn) => ctx.runWithTenant({ companyId: "prd", branchId: "main" }, fn);
const api = (who, method, url, body, extra = {}) => call(method, url, { token: T[who], body: method === "GET" || method === "DELETE" ? undefined : body, ...extra });
const login = async (email) => (await call("POST", "/login", { body: { email, password: PASSWORD } })).body?.tokens?.accessToken;

const cannot = async (who, method, url, body) => {
  const r = await api(who, method, url, body);
  assert.equal(r.status, 403, `${who} ${method} ${url} should be refused: ${r.status} ${JSON.stringify(r.data)?.slice(0, 200)}`);
  assert.equal(r.code, "PERMISSION_DENIED", `${who} ${method} ${url}`);
  return r;
};

async function roleAndPerson(key, permissions) {
  const made = await api("owner", "POST", "/access/roles", { key, name: key.replace(/_/g, " "), rank: 50, permissions });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const added = await api("owner", "POST", "/access/users", { name: key, email: `${key}@prd.test`, password: PASSWORD, role: key });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  await as(() => M.Admin.updateOne({ email: `${key}@prd.test` }, { $set: { mustChangePassword: false } }));
  T[key] = await login(`${key}@prd.test`);
  assert.ok(T[key], `${key} signs in`);
}

const withCosts = () => ({
  finished: { stockId: S.finished, qty: 2 },
  materials: [{ stockId: S.raw, qty: 2 }],
  costs: [{ accountId: S.expense, amount: 30, narration: "coating" }],
});
const materialsOnly = () => ({ finished: { stockId: S.finished, qty: 1 }, materials: [{ stockId: S.raw, qty: 1 }] });

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  const fin = require("../../models/modules/financial/financialModels");
  M = {
    Admin: require("../../models/core/adminModel"), Stock: require("../../models/modules/stockModel"),
    LedgerAccount: fin.LedgerAccount, ActivityLog: require("../../models/modules/financial/activityLogModel"),
  };
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

test("an organisation with a raw item in stock, a finished item, an expense, and people with different rights", { skip }, async () => {
  assert.equal((await Org.create({ legalName: "Prd Works", code: "prd", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium", featureOverrides: { production: true } })).provisioning.complete, true);
  await as(() => new M.Admin({ name: "owner", email: "owner@prd.test", password: PASSWORD, status: "active", isActive: true, type: "super_admin" }).save());
  T.owner = await login("owner@prd.test");
  assert.ok(T.owner);
  S.raw = String((await as(() => new M.Stock({ itemId: "RAW1", sku: "RAW1", itemName: "Raw part", category: new mongoose.Types.ObjectId(), currentStock: 20, purchasePrice: 10, costValue: 200 }).save()))._id);
  S.finished = String((await as(() => new M.Stock({ itemId: "FIN1", sku: "FIN1", itemName: "Coated part", category: new mongoose.Types.ObjectId() }).save()))._id);
  S.expense = String((await as(() => M.LedgerAccount.findOne({ accountName: "Utilities" }).lean()))._id);
  assert.ok(S.expense, "the starter chart has an expense account");

  await roleAndPerson("looker", ["inventory.view"]);
  await roleAndPerson("stockonly", ["inventory.view", "inventory.adjust"]);
  await roleAndPerson("maker", ["inventory.view", "inventory.adjust", "finance.create"]);
});

test("Production is opt-in: an organisation not given it is refused, whatever its plan or its people's roles", { skip }, async () => {
  assert.equal((await Org.create({ legalName: "No Prd", code: "noprd", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "internal" })).provisioning.complete, true);
  await ctx.runWithTenant({ companyId: "noprd", branchId: "main" }, () => new M.Admin({ name: "owner2", email: "owner@noprd.test", password: PASSWORD, status: "active", isActive: true, type: "super_admin" }).save());
  T.other = await login("owner@noprd.test");
  for (const [method, url] of [["GET", "/productions"], ["POST", "/productions"], ["GET", "/productions/cost-report"]]) {
    const r = await api("other", method, url, method === "POST" ? materialsOnly() : undefined);
    assert.equal(r.status, 403, `${method} ${url}`);
    assert.equal(r.code, "FEATURE_NOT_IN_PLAN", `${method} ${url}: even the owner of an "internal" organisation (every other feature)`);
  }
});

test("reading needs inventory.view, saving needs inventory.adjust", { skip }, async () => {
  const list = await api("looker", "GET", "/productions");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, []);
  await cannot("looker", "POST", "/productions", materialsOnly());
});

test("stock rights alone post a production of materials; cost lines also need finance.create", { skip }, async () => {
  const refused = await cannot("stockonly", "POST", "/productions", withCosts());
  assert.deepEqual(refused.details.required, ["finance.create"]);

  const draft = await api("stockonly", "POST", "/productions", materialsOnly());
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  assert.equal(draft.body.status, "DRAFT");
  assert.equal(draft.body.actions.post, true);
  const posted = await api("stockonly", "POST", `/productions/${draft.body._id}/post`, {});
  assert.equal(posted.status, 200, JSON.stringify(posted.data));
  assert.equal(posted.body.status, "POSTED");
  assert.deepEqual([posted.body.totals.materials, posted.body.totals.unitCost], [10, 10]);
  const actions = await as(() => M.ActivityLog.find({ entity: "ProductionOrder", entityId: draft.body._id }).lean());
  assert.deepEqual(actions.map((a) => a.action).sort(), ["PRODUCTION_CREATED", "PRODUCTION_POSTED"]);
  const one = await api("looker", "GET", `/productions/${draft.body._id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.actions.reverse, true);
});

test("a production with costs: the warning tick, then reversing needs finance.deletePosted", { skip }, async () => {
  const draft = await api("maker", "POST", "/productions", withCosts());
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  await cannot("stockonly", "POST", `/productions/${draft.body._id}/post`, {}); // costs on the stored draft

  const warned = await api("maker", "POST", `/productions/${draft.body._id}/post`, {});
  assert.equal(warned.status, 409);
  assert.equal(warned.code, "PRODUCTION_WARNINGS", "nothing was spent on Utilities yet");
  assert.equal(warned.details.warnings[0].code, "COST_EXCEEDS_SPEND");

  const posted = await api("maker", "POST", `/productions/${draft.body._id}/post`, { acknowledge: ["COST_EXCEEDS_SPEND"] });
  assert.equal(posted.status, 200, JSON.stringify(posted.data));
  assert.deepEqual([posted.body.totals.total, posted.body.totals.unitCost], [50, 25], "2 raw at 10 + 30 of costs, for 2 made");

  const trail = await api("owner", "GET", `/vouchers/vouchers/${draft.body._id}/audit`);
  assert.equal(trail.status, 200, JSON.stringify(trail.data)?.slice(0, 300));
  assert.equal(trail.body.source?.kind, "production", "the ledger row's number opens the production's own trail");

  const report = await api("looker", "GET", "/productions/cost-report");
  assert.equal(report.status, 200);
  const row = report.body.items.find((r) => r.itemName === "Coated part");
  assert.deepEqual([row.qty, row.total, row.costLines[0].amount], [3, 60, 30]);

  await cannot("maker", "POST", `/productions/${draft.body._id}/reverse`, {});
  const reversed = await api("owner", "POST", `/productions/${draft.body._id}/reverse`, { reason: "test" });
  assert.equal(reversed.status, 200, JSON.stringify(reversed.data));
  assert.equal(reversed.body.status, "REVERSED");
});

test("another branch cannot see a production", { skip }, async () => {
  const branch = await api("owner", "POST", "/branches", { code: "shj", name: "Sharjah" });
  assert.equal(branch.status, 201, JSON.stringify(branch.data));
  const draft = await api("owner", "POST", "/productions", materialsOnly());
  assert.equal(draft.status, 201);
  const fromShj = await api("owner", "GET", `/productions/${draft.body._id}`, undefined, { branch: "shj" });
  assert.equal(fromShj.status, 404, JSON.stringify(fromShj.data));
  const list = await api("owner", "GET", "/productions", undefined, { branch: "shj" });
  assert.equal(list.body.some((p) => p._id === draft.body._id), false);
  const deleted = await api("owner", "DELETE", `/productions/${draft.body._id}`);
  assert.equal(deleted.status, 200);
});
