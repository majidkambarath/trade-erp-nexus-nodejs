// Two organisations, each with signed-in people, against a real STRICT server: what an account may reach
// is decided by the organisation its database row names, and nothing a request or a token says can change
// that. This is the proof that signing in opens the right scope and that the scope holds.
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

let child, Admin, Org, ctx;
let logs = "";
const ids = {};
const tok = {};

async function call(method, url, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode || data?.error };
}
const login = async (email) => (await call("POST", "/login", { body: { email, password: PASSWORD } })).body?.tokens?.accessToken;
const as = (code, fn) => ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const raw = (fn) => ctx.runUnscoped("a test inspecting what is really stored, across organisations", fn);
const member = async (code, name, type) => {
  const a = await as(code, () => new Admin({ name, email: `${name}@test.uae`, password: PASSWORD, type, status: "active", isActive: true }).save());
  ids[name] = String(a._id);
  tok[name] = await login(`${name}@test.uae`);
  assert.ok(tok[name], `could not sign in as ${name}`);
};
const forged = (claims) => jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: "1h", issuer: "ERP-system", audience: "ERP-admin" });

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  Admin = require("../../models/core/adminModel");
  Org = require("../core/organisationService");
  ctx = require("../../utils/tenantContext");
  await mongoose.connection.syncIndexes();
  const deadline = Date.now() + 60000;
  for (;;) {
    try { { const h = await fetch(`${BASE}/health`); if (h.ok && (await h.json()).ready !== false) break; } } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  await Org.create({ legalName: "Alpha Foods", code: "alpha", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "standard" });
  await Org.create({ legalName: "Bravo Trading", code: "bravo", country: "SA", baseCurrency: "SAR", timezone: "Asia/Riyadh", planCode: "standard" });
  await member("alpha", "alpha-boss", "admin");
  await member("alpha", "alpha-clerk", "viewer");
  await member("bravo", "bravo-boss", "admin");
  await member("bravo", "bravo-clerk", "viewer");
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

test("an account belongs to the organisation that created it, and its token says so", { skip }, async () => {
  const claims = jwt.decode(tok["alpha-boss"]);
  assert.equal(claims.companyId, "alpha");
  assert.equal(jwt.decode(tok["bravo-boss"]).companyId, "bravo");
  const row = await raw(() => Admin.findById(ids["alpha-boss"]).lean());
  assert.equal(row.companyId, "alpha");
  assert.equal(row.branchId, "main", "it works from the head office");
});

test("each organisation reads its own masters through the same route, in its own currency", { skip }, async () => {
  const a = await call("GET", "/currencies", { token: tok["alpha-boss"] });
  const b = await call("GET", "/currencies", { token: tok["bravo-boss"] });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(b.status, 200, JSON.stringify(b.data));
  const baseOf = (res) => (res.body.currencies || res.body.rows || res.body).find?.((c) => c.isBase)?.code;
  assert.equal(baseOf(a), "AED", "Alpha keeps its books in dirhams");
  assert.equal(baseOf(b), "SAR", "Bravo keeps its books in riyals");
});

test("an administrator lists only their own organisation's accounts", { skip }, async () => {
  const a = await call("GET", "/", { token: tok["alpha-boss"] });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const emails = (a.body.admins || a.body.rows || a.body.data || a.body).map?.((x) => x.email) || [];
  assert.ok(emails.includes("alpha-boss@test.uae") && emails.includes("alpha-clerk@test.uae"), `alpha sees its own: ${emails}`);
  assert.ok(!emails.some((e) => e.startsWith("bravo")), `alpha does not see bravo's: ${emails}`);
});

test("an administrator cannot read, change or remove another organisation's account, even by its exact id", { skip }, async () => {
  const target = ids["bravo-clerk"];
  assert.equal((await call("GET", `/${target}`, { token: tok["alpha-boss"] })).status, 404, "it does not exist as far as Alpha can tell");
  assert.equal((await call("PUT", `/${target}`, { token: tok["alpha-boss"], body: { name: "Hijacked" } })).status, 404);
  assert.equal((await call("PATCH", `/${target}/status`, { token: tok["alpha-boss"], body: { status: "suspended" } })).status, 404);
  assert.equal((await call("DELETE", `/${target}`, { token: tok["alpha-boss"] })).status, 404);
  const row = await raw(() => Admin.findById(target).lean());
  assert.equal(row.name, "bravo-clerk", "untouched");
  assert.equal(row.status, "active");
  assert.equal(row.isActive, true);
});

test("an account is always created in the creator's organisation, whatever the request says", { skip }, async () => {
  const made = await call("POST", "/", { token: tok["alpha-boss"], body: { name: "Smuggled", email: "smuggled@test.uae", password: PASSWORD, type: "viewer", companyId: "bravo", branchId: "main" } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const row = await raw(() => Admin.findOne({ email: "smuggled@test.uae" }).lean());
  assert.equal(row.companyId, "alpha", "the body's companyId was ignored");
});

test("one person belongs to one organisation: the same email cannot be used in another", { skip }, async () => {
  const dup = await call("POST", "/", { token: tok["bravo-boss"], body: { name: "Twin", email: "alpha-boss@test.uae", password: PASSWORD, type: "viewer" } });
  assert.ok(dup.status >= 400 && dup.status < 500, `refused with a client error, got ${dup.status}`);
  assert.equal(await raw(() => Admin.countDocuments({ email: "alpha-boss@test.uae" })), 1, "still only Alpha's");
});

test("a token cannot choose its organisation: the account's own row decides", { skip }, async () => {
  const lie = forged({ id: ids["alpha-boss"], email: "alpha-boss@test.uae", type: "super_admin", permissions: ["backup_restore"], name: "x", companyId: "bravo", branchId: "main" });
  const r = await call("GET", "/currencies", { token: lie });
  assert.equal(r.status, 401);
  assert.equal(r.code, "TOKEN_ORGANISATION_MISMATCH");
  // a token that says nothing about the organisation (one issued before organisations existed) still works,
  // and lands in the organisation the account's row names
  const old = forged({ id: ids["alpha-boss"], email: "alpha-boss@test.uae", type: "admin", permissions: [], name: "x" });
  assert.equal((await call("GET", "/currencies", { token: old })).status, 200);
});

test("a token cannot name an account that does not exist, or one that is not active", { skip }, async () => {
  const ghost = forged({ id: new mongoose.Types.ObjectId().toString(), email: "ghost@test.uae", type: "admin", companyId: "alpha" });
  assert.equal((await call("GET", "/currencies", { token: ghost })).status, 401);
  await raw(() => Admin.updateOne({ _id: ids["alpha-clerk"] }, { $set: { status: "inactive" } }));
  assert.equal((await call("GET", "/currencies", { token: tok["alpha-clerk"] })).status, 401, "switched off at once, not when the token runs out");
  await raw(() => Admin.updateOne({ _id: ids["alpha-clerk"] }, { $set: { status: "active" } }));
});

test("a demotion takes effect on the next request, not when the token expires", { skip }, async () => {
  assert.equal((await call("GET", "/", { token: tok["alpha-boss"] })).status, 200, "an administrator may list accounts");
  await raw(() => Admin.updateOne({ _id: ids["alpha-boss"] }, { $set: { type: "viewer" } }));
  assert.equal((await call("GET", "/", { token: tok["alpha-boss"] })).status, 403, "the same token, now a viewer's rights");
  await raw(() => Admin.updateOne({ _id: ids["alpha-boss"] }, { $set: { type: "admin" } }));
  assert.equal((await call("GET", "/", { token: tok["alpha-boss"] })).status, 200);
});

test("refreshing a session keeps the organisation, and the new token says so", { skip }, async () => {
  const res = await fetch(`${BASE}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "bravo-boss@test.uae", password: PASSWORD }) });
  const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  assert.ok(cookie, "the refresh token travels in a cookie");
  const refreshed = await fetch(`${BASE}/refresh-token`, { method: "POST", headers: { Cookie: cookie } });
  const json = await refreshed.json();
  assert.equal(refreshed.status, 200, JSON.stringify(json));
  assert.equal(jwt.decode(json.data.accessToken).companyId, "bravo");
});

test("an account whose organisation is gone is refused, at sign-in and on every request", { skip }, async () => {
  await Org.create({ legalName: "Gone Co", code: "gone-co", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "standard" });
  await member("gone-co", "gone-boss", "admin");
  assert.equal((await call("GET", "/currencies", { token: tok["gone-boss"] })).status, 200);
  await raw(() => mongoose.connection.collection("organisations").deleteOne({ code: "gone-co" }));
  const r = await call("GET", "/currencies", { token: tok["gone-boss"] });
  assert.equal(r.status, 401);
  assert.equal(r.code, "ORGANISATION_NOT_FOUND");
  const again = await call("POST", "/login", { body: { email: "gone-boss@test.uae", password: PASSWORD } });
  assert.equal(again.status, 403);
  assert.equal(again.code, "ORGANISATION_NOT_FOUND");
});

test("a request with no login reaches no organisation's data", { skip }, async () => {
  for (const url of ["/currencies", "/stock", "/customers/customers", "/transactions/transactions", "/quotations"]) {
    assert.equal((await call("GET", url)).status, 401, url);
  }
});
