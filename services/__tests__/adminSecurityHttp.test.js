// The user-account routes over HTTP: a real server against a throwaway database, real logins. Each test
// is an attack someone could have made before these were closed: create an admin with no login, delete
// one with no login, promote yourself, suspend a super admin, change a password through the profile.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";

let child;
let Admin;
const ids = {};
const tok = {};
let logs = "";

async function call(method, url, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode };
}
const login = async (email, password = PASSWORD) => {
  const r = await call("POST", "/login", { body: { email, password } });
  return r.body?.tokens?.accessToken;
};
const make = async (name, type) => {
  const a = await new Admin({ name, email: `${name}@test.uae`, password: PASSWORD, type, status: "active", isActive: true }).save();
  ids[name] = String(a._id);
  tok[name] = await login(`${name}@test.uae`);
  assert.ok(tok[name], `could not sign in as ${name}`);
};
const stored = (name) => Admin.findById(ids[name]).select("+password");

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  assert.ok(uri.includes(DB), "could not point the server at the throwaway database");
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  Admin = require("../../models/core/adminModel");
  await mongoose.connection.syncIndexes();
  const deadline = Date.now() + 60000;
  for (;;) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  for (const [name, type] of [["boss", "super_admin"], ["adm", "admin"], ["mgr", "manager"], ["viewer", "viewer"], ["victim", "viewer"]]) await make(name, type);
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

test("creating an account needs a login: nobody can mint themselves an admin", { skip }, async () => {
  const before = await Admin.countDocuments();
  const r = await call("POST", "/", { body: { name: "Mallory", email: "mallory@evil.uae", password: PASSWORD, type: "super_admin" } });
  assert.equal(r.status, 401);
  assert.equal(await Admin.countDocuments(), before, "no account was created");
  assert.equal(await Admin.findOne({ email: "mallory@evil.uae" }), null);
});

test("removing an account needs a login", { skip }, async () => {
  const r = await call("DELETE", `/${ids.victim}`);
  assert.equal(r.status, 401);
  assert.equal((await stored("victim")).isActive, true, "the account is untouched");
});

test("only administrators list accounts; anyone may read their own record but not another's", { skip }, async () => {
  assert.equal((await call("GET", "/", { token: tok.viewer })).status, 403);
  assert.equal((await call("GET", "/", { token: tok.mgr })).status, 403);
  assert.equal((await call("GET", "/", { token: tok.adm })).status, 200);
  assert.equal((await call("GET", `/${ids.viewer}`, { token: tok.viewer })).status, 200, "your own record");
  assert.equal((await call("GET", `/${ids.boss}`, { token: tok.viewer })).status, 403, "someone else's");
});

test("a viewer or manager cannot create an account", { skip }, async () => {
  for (const who of ["viewer", "mgr"]) {
    const r = await call("POST", "/", { token: tok[who], body: { name: "X", email: `x-${who}@test.uae`, password: PASSWORD, type: "viewer" } });
    assert.equal(r.status, 403, who);
    assert.equal(r.code, "INSUFFICIENT_ROLE");
  }
  assert.equal(await Admin.findOne({ email: /^x-/ }), null);
});

test("a viewer cannot promote themselves, or change anyone else", { skip }, async () => {
  const self = await call("PUT", `/${ids.viewer}`, { token: tok.viewer, body: { type: "super_admin" } });
  assert.equal(self.status, 403);
  assert.equal((await stored("viewer")).type, "viewer", "still a viewer");
  const other = await call("PUT", `/${ids.victim}`, { token: tok.viewer, body: { name: "Hacked" } });
  assert.equal(other.status, 403);
  assert.equal((await stored("victim")).name, "victim");
});

test("an admin cannot create or promote anyone to admin or super admin, nor touch a super admin", { skip }, async () => {
  const mk = await call("POST", "/", { token: tok.adm, body: { name: "Up", email: "up@test.uae", password: PASSWORD, type: "super_admin" } });
  assert.equal(mk.status, 403);
  assert.equal(mk.code, "SUPER_ADMIN_REQUIRED");
  assert.equal(await Admin.findOne({ email: "up@test.uae" }), null);

  const promote = await call("PUT", `/${ids.victim}`, { token: tok.adm, body: { type: "admin" } });
  assert.equal(promote.status, 403);
  assert.equal((await stored("victim")).type, "viewer");

  const selfPromote = await call("PUT", `/${ids.adm}`, { token: tok.adm, body: { type: "super_admin" } });
  assert.equal(selfPromote.status, 403);
  assert.equal((await stored("adm")).type, "admin");

  assert.equal((await call("PUT", `/${ids.boss}`, { token: tok.adm, body: { name: "Pwned", password: "newpassword1" } })).status, 403);
  assert.equal((await stored("boss")).name, "boss", "a super admin's account is out of reach of an admin");
  assert.equal((await call("DELETE", `/${ids.boss}`, { token: tok.adm })).status, 403);
  assert.equal((await stored("boss")).isActive, true);
});

test("the status route cannot be used to suspend an account by anyone signed in", { skip }, async () => {
  const byViewer = await call("PATCH", `/${ids.boss}/status`, { token: tok.viewer, body: { status: "suspended" } });
  assert.equal(byViewer.status, 403);
  const byAdmin = await call("PATCH", `/${ids.boss}/status`, { token: tok.adm, body: { status: "suspended" } });
  assert.equal(byAdmin.status, 403);
  assert.equal((await stored("boss")).status, "active", "the super admin is still active");
});

test("an admin can manage ordinary accounts, and the new account gets only its own permissions", { skip }, async () => {
  const mk = await call("POST", "/", { token: tok.adm, body: { name: "Newbie", email: "newbie@test.uae", password: PASSWORD, type: "operator" } });
  assert.equal(mk.status, 201, JSON.stringify(mk.data));
  const row = await Admin.findOne({ email: "newbie@test.uae" });
  assert.equal(row.type, "operator");
  assert.deepEqual([...row.permissions].sort(), ["inventory_manage", "transactions_manage"], "an operator is not handed all seven");
  assert.equal(row.createdBy && String(row.createdBy), ids.adm, "it records who created it");

  const up = await call("PUT", `/${ids.victim}`, { token: tok.adm, body: { type: "manager" } });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const after = await stored("victim");
  assert.equal(after.type, "manager");
  assert.ok(after.permissions.includes("transactions_approve"), "permissions follow the new type");
  assert.ok(!after.permissions.includes("system_settings"));
});

test("a request body cannot write the system's own fields", { skip }, async () => {
  const r = await call("PUT", `/${ids.mgr}`, { token: tok.boss, body: { name: "Mgr", permissions: ["backup_restore", "users_manage"], loginAttempts: 99, createdBy: ids.viewer } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = await stored("mgr");
  assert.ok(!row.permissions.includes("backup_restore"), "permissions were not taken from the request");
  assert.notEqual(row.loginAttempts, 99);
  assert.notEqual(String(row.createdBy || ""), ids.viewer);
});

test("nobody can remove their own account", { skip }, async () => {
  const r = await call("DELETE", `/${ids.boss}`, { token: tok.boss });
  assert.equal(r.status, 403);
  assert.equal(r.code, "CANNOT_REMOVE_SELF");
  assert.equal((await stored("boss")).isActive, true);
});

test("the profile route cannot change the password or the role", { skip }, async () => {
  const r = await call("PUT", "/profile/me", { token: tok.viewer, body: { name: "Viewer Renamed", password: "changed-behind-your-back", type: "super_admin", status: "active" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = await stored("viewer");
  assert.equal(row.name, "Viewer Renamed", "ordinary profile fields still update");
  assert.equal(row.type, "viewer", "the role is not editable from the profile");
  assert.ok(await login("viewer@test.uae", PASSWORD), "the old password still works");
  assert.equal(await login("viewer@test.uae", "changed-behind-your-back"), undefined, "the new one was never set");
});

test("a token carries the permissions of the account's type, not whatever an old row stored", { skip }, async () => {
  const legacy = await new Admin({ name: "legacy", email: "legacy@test.uae", password: PASSWORD, type: "viewer", status: "active", isActive: true }).save();
  await Admin.updateOne({ _id: legacy._id }, { $set: { permissions: ["users_manage", "backup_restore", "system_settings"] } });
  const token = await login("legacy@test.uae");
  assert.deepEqual(jwt.decode(token).permissions, ["financial_reports"], "a viewer's token says viewer, whatever the row says");
});
