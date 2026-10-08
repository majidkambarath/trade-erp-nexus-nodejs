// Who a person IS, in roles: resolved from the database on every request against a strict server. A built-in role
// is code, a custom role is a row of the person's own organisation, a role that is missing or switched off holds
// nothing, and one organisation's custom role means nothing in another.
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

let child, M, Org, ctx, perms;
let logs = "";
const T = {};

async function call(method, url, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode };
}
const as = (code, fn) => ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const me = async (who) => (await call("GET", "/organisation/status", { token: T[who] })).body?.me;

async function person(org, who, fields) {
  await as(org, () => new M.Admin({ name: who, email: `${who}@${org}.test`, password: PASSWORD, status: "active", isActive: true, ...fields }).save());
  const r = await call("POST", "/login", { body: { email: `${who}@${org}.test`, password: PASSWORD } });
  assert.equal(r.status, 200, `${who} signs in: ${JSON.stringify(r.data)}`);
  T[who] = r.body.tokens.accessToken;
}

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = { Admin: require("../../models/core/adminModel"), Role: require("../../models/core/roleModel") };
  Org = require("../core/organisationService");
  ctx = require("../../utils/tenantContext");
  perms = require("../../utils/permissions");
  await mongoose.connection.syncIndexes();
  const deadline = Date.now() + 60000;
  for (;;) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) { /* not up yet */ }
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

test("two organisations, and a person in each", { skip }, async () => {
  for (const code of ["alpha", "bravo"]) {
    const made = await Org.create({ legalName: `${code} Trading`, code, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" });
    assert.equal(made.provisioning.complete, true);
  }
});

test("an account with no role of its own holds the role of its type, exactly as before roles existed", { skip }, async () => {
  for (const type of ["super_admin", "admin", "manager", "operator", "viewer"]) {
    await person("alpha", `legacy-${type.replace("_", "")}`, { type });
    const who = await me(`legacy-${type.replace("_", "")}`);
    assert.equal(who.role.key, type, type);
    assert.equal(who.role.builtIn, true);
    assert.deepEqual(who.grants, perms.BUILT_IN[type].permissions, `${type} holds what its role says`);
  }
});

test("a built-in role can be given to anyone, whatever their type", { skip }, async () => {
  await person("alpha", "clerk", { type: "viewer", roleKey: "sales" });
  const who = await me("clerk");
  assert.equal(who.role.key, "sales");
  assert.equal(who.role.name, "Sales executive");
  assert.ok(who.grants.includes("sales.create") && who.grants.includes("sales.send"));
  assert.ok(!who.grants.includes("sales.approve"), "a sales executive does not approve");
  assert.ok(!who.grants.includes("finance.view"), "and cannot open Finance");
});

test("a custom role is a row of the organisation, expanded like a built-in one", { skip }, async () => {
  await as("alpha", () => M.Role.create({ key: "supervisor", name: "Sales supervisor", rank: 55, permissions: ["sales.create", "sales.approve", "reports.financial"] }));
  await person("alpha", "lead", { type: "viewer", roleKey: "supervisor" });
  const who = await me("lead");
  assert.equal(who.role.key, "supervisor");
  assert.equal(who.role.builtIn, false);
  assert.equal(who.role.rank, 55);
  assert.ok(who.grants.includes("sales.view"), "approving implies seeing");
  assert.ok(who.grants.includes("lookups.view"), "and the pick lists");
  assert.ok(who.grants.includes("reports.view"), "financial reports imply reports");
  assert.ok(!who.grants.includes("finance.approve") && !who.grants.includes("users.manage"));
});

test("editing a role changes what its people hold on their very next request, with the same token", { skip }, async () => {
  await as("alpha", () => M.Role.updateOne({ key: "supervisor" }, { $set: { permissions: ["sales.view"] } }));
  const who = await me("lead");
  assert.deepEqual(who.grants, ["sales.view"], "narrowed at once: nothing is cached in the token");
  await as("alpha", () => M.Role.updateOne({ key: "supervisor" }, { $set: { permissions: ["sales.create", "sales.approve", "reports.financial"] } }));
  assert.ok((await me("lead")).grants.includes("sales.approve"));
});

test("a role that is switched off holds nothing, and so does one that does not exist", { skip }, async () => {
  await as("alpha", () => M.Role.updateOne({ key: "supervisor" }, { $set: { isActive: false } }));
  const off = await me("lead");
  assert.deepEqual(off.grants, [], "switched off: nothing, not a default");
  assert.equal(off.role.active, false);
  await as("alpha", () => M.Role.updateOne({ key: "supervisor" }, { $set: { isActive: true } }));

  await person("alpha", "ghost", { type: "viewer", roleKey: "deleted_role" });
  const gone = await me("ghost");
  assert.deepEqual(gone.grants, [], "a role that is not there grants nothing");
  assert.equal(gone.role.key, "deleted_role");
  assert.equal(gone.role.active, false);
});

test("one organisation's custom role means nothing in another", { skip }, async () => {
  await person("bravo", "outsider", { type: "viewer", roleKey: "supervisor" }); // bravo has no such role
  assert.deepEqual((await me("outsider")).grants, [], "alpha's supervisor is invisible to bravo");
  await as("bravo", () => M.Role.create({ key: "supervisor", name: "A different supervisor", rank: 30, permissions: ["inventory.view"] }));
  const who = await me("outsider");
  assert.deepEqual(who.grants, ["inventory.view"], "bravo's own role of the same name is what resolves");
  assert.equal(who.role.name, "A different supervisor");
  assert.equal((await me("lead")).role.name, "Sales supervisor", "and alpha's is untouched");
});

test("a role key is unique within an organisation, and a built-in key cannot be used", { skip }, async () => {
  await assert.rejects(() => as("alpha", () => M.Role.create({ key: "supervisor", name: "Dup", rank: 30, permissions: [] })), (e) => e.code === 11000);
  await assert.rejects(() => as("alpha", () => M.Role.create({ key: "manager", name: "Fake manager", rank: 30, permissions: [] })), /built-in role/);
  await assert.rejects(() => as("alpha", () => M.Role.create({ key: "okay_key", name: "Bad", rank: 30, permissions: ["sales.fly"] })), /permissions that exist/);
  await assert.rejects(() => as("alpha", () => M.Role.create({ key: "okay_key", name: "Top", rank: 100, permissions: [] })), /rank/i);
});

test("the status route says who is asking and what they hold", { skip }, async () => {
  const who = await me("legacy-manager");
  assert.equal(who.email, "legacy-manager@alpha.test");
  assert.equal(who.role.rank, 60);
  assert.ok(Array.isArray(who.grants) && who.grants.every((k) => perms.isKey(k)), "only real permissions");
  assert.equal(await call("GET", "/organisation/status").then((r) => r.status), 401, "and it still needs a sign-in");
});
