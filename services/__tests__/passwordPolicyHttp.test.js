// How people get in, and stay safe once they are in: a password someone else set must be replaced by the person's own before
// anything else works; a reset locks that in again; a locked account is let in again by a reset and is not locked for hours;
// and an address that keeps failing is slowed. Against strict servers with real sign-ins.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3300 + Math.floor(Math.random() * 200);
const PORT2 = PORT + 200; // a second server on the same database, with a tiny failure limit, for the throttle
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const BASE2 = `http://127.0.0.1:${PORT2}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";
const TEMP = "temporary-pass-1"; // what an administrator types for a new person

let children = [], M, Org, ctx;
let logs = "";
const T = {};

async function call(method, url, { body, token, base = BASE } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode || data?.error, message: data?.message, retryAfter: res.headers.get("retry-after") };
}
const as = (code, fn) => ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const api = (who, method, url, body) => call(method, url, { token: T[who], body: method === "GET" ? undefined : body });
const signIn = (email, password) => call("POST", "/login", { body: { email, password } });
const admin = (email) => as("pol", () => M.Admin.findOne({ email }).select("+password").lean());

function start(port, extraEnv = {}) {
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  const child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(port), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0", ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  children.push(child);
}
async function waitUp(base) {
  const deadline = Date.now() + 90000;
  for (;;) {
    try { const h = await fetch(`${base}/health`); if (h.ok && (await h.json()).ready !== false) return; } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

test.before(async () => {
  if (skip) return;
  start(PORT);
  await mongoose.connect(process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`));
  M = { Admin: require("../../models/core/adminModel"), Activity: require("../../models/modules/financial/activityLogModel") };
  Org = require("../core/organisationService");
  ctx = require("../../utils/tenantContext");
  await mongoose.connection.syncIndexes();
  await waitUp(BASE);
});
test.after(async () => {
  if (skip) return;
  children.forEach((c) => c.kill());
  if (mongoose.connection.readyState === 1) {
    assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test("an organisation and an owner who set their own password long ago", { skip }, async () => {
  assert.equal((await Org.create({ legalName: "Pol Trading", code: "pol", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" })).provisioning.complete, true);
  await as("pol", () => new M.Admin({ name: "owner", email: "owner@pol.test", password: PASSWORD, status: "active", isActive: true, type: "super_admin" }).save());
  const r = await signIn("owner@pol.test", PASSWORD);
  assert.equal(r.status, 200);
  T.owner = r.body.tokens.accessToken;
  assert.equal((await api("owner", "GET", "/organisation/status")).body.me.mustChangePassword, false);
});

test("a person added with a password someone else chose can do nothing but choose their own", { skip }, async () => {
  const added = await api("owner", "POST", "/access/users", { name: "Nadia New", email: "nadia@pol.test", password: TEMP, role: "manager" });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  const r = await signIn("nadia@pol.test", TEMP);
  assert.equal(r.status, 200, "she can sign in with it");
  assert.equal(r.body.admin.mustChangePassword, true, "and is told");
  T.nadia = r.body.tokens.accessToken;

  // what she may do: see who she is and what she may do (so the screen can ask her), and change the password
  const status = await api("nadia", "GET", "/organisation/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.me.mustChangePassword, true);
  assert.equal((await api("nadia", "GET", "/profile/me")).status, 200);

  // everything else is refused, the same way, on every kind of route
  for (const [method, url] of [["GET", "/customers/customers"], ["GET", "/transactions/transactions"], ["POST", "/customers"], ["GET", "/access/roles"], ["GET", "/vouchers/vouchers"], ["GET", "/branches"], ["PUT", "/profile/me"], ["GET", "/company/profile"]]) {
    const refused = await api("nadia", method, url, method === "GET" ? undefined : {});
    assert.equal(refused.status, 403, `${method} ${url}: ${JSON.stringify(refused.data)}`);
    assert.equal(refused.code, "PASSWORD_CHANGE_REQUIRED", `${method} ${url}`);
  }
});

test("choosing a new password has rules, and once chosen everything opens on the same token", { skip }, async () => {
  const change = (body) => api("nadia", "PUT", "/profile/change-password", body);
  assert.equal((await change({ currentPassword: "not-her-temp", newPassword: "a-new-password-1", confirmPassword: "a-new-password-1" })).status, 400, "the wrong current password");
  assert.equal((await change({ currentPassword: TEMP, newPassword: "short", confirmPassword: "short" })).status, 400, "too short");
  const same = await change({ currentPassword: TEMP, newPassword: TEMP, confirmPassword: TEMP });
  assert.equal(same.status, 400);
  assert.equal(same.code, "PASSWORD_UNCHANGED", "it must be a password she chose");
  assert.equal((await change({ currentPassword: TEMP, newPassword: "a-new-password-1", confirmPassword: "different-one-1" })).status, 400, "the two do not match");
  assert.equal((await admin("nadia@pol.test")).mustChangePassword, true, "none of that changed her");

  const ok = await change({ currentPassword: TEMP, newPassword: "a-new-password-1", confirmPassword: "a-new-password-1" });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const after = await admin("nadia@pol.test");
  assert.equal(after.mustChangePassword, false);
  assert.ok(after.passwordChangedAt, "when she chose it is kept");

  assert.notEqual((await api("nadia", "GET", "/customers/customers")).code, "PASSWORD_CHANGE_REQUIRED", "the same token now works");
  assert.equal((await api("nadia", "GET", "/organisation/status")).body.me.mustChangePassword, false);
  assert.equal((await signIn("nadia@pol.test", TEMP)).status, 401, "the password the administrator typed no longer opens anything");
  assert.equal((await signIn("nadia@pol.test", "a-new-password-1")).status, 200);
});

test("an administrator resetting a password ends the person's sign-ins and puts the next one back to choosing their own", { skip }, async () => {
  const nadia = await admin("nadia@pol.test");
  const reset = await api("owner", "PATCH", `/access/users/${nadia._id}`, { password: "reset-by-admin-1" });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.equal((await admin("nadia@pol.test")).mustChangePassword, true);
  // (a password someone else chose ends every sign-in the person holds: the reset is often made because the old one is not safe. Until 10 Oct 2026
  // the token she held stayed open, limited to choosing a new password.)
  assert.equal((await api("nadia", "GET", "/customers/customers")).code, "SESSION_REVOKED", "the token she already holds is over straight away");
  const again = await signIn("nadia@pol.test", "reset-by-admin-1");
  assert.equal(again.status, 200);
  T.nadia = again.body.tokens.accessToken;
  assert.equal((await api("nadia", "GET", "/customers/customers")).code, "PASSWORD_CHANGE_REQUIRED", "and the new sign-in is held to choosing her own");
  const ok = await api("nadia", "PUT", "/profile/change-password", { currentPassword: "reset-by-admin-1", newPassword: "hers-again-pass-1", confirmPassword: "hers-again-pass-1" });
  assert.equal(ok.status, 200);
});

test("the older admin routes obey the same rule: an account made or reset there must also be replaced", { skip }, async () => {
  const made = await api("owner", "POST", "/", { name: "Old Route", email: "old@pol.test", password: TEMP, type: "operator" });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal((await admin("old@pol.test")).mustChangePassword, true);
  const id = (await admin("old@pol.test"))._id;
  await as("pol", () => M.Admin.updateOne({ _id: id }, { $set: { mustChangePassword: false } })); // as if they had chosen their own
  const reset = await api("owner", "PUT", `/${id}`, { password: "reset-old-route-1" });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.equal((await admin("old@pol.test")).mustChangePassword, true);
});

test("five wrong passwords lock an account for minutes, not hours, and a reset lets the person back in", { skip }, async () => {
  const email = "nadia@pol.test";
  let last;
  for (let i = 0; i < 5; i++) last = await signIn(email, "wrong-password-x");
  assert.equal(last.status, 401);
  const locked = await signIn(email, "hers-again-pass-1");
  assert.equal(locked.status, 423, "even the right password is refused while it is locked");
  assert.equal(locked.code, "ACCOUNT_LOCKED");
  const lock = await admin(email);
  const minutes = (new Date(lock.lockUntil).getTime() - Date.now()) / 60000;
  assert.ok(minutes > 10 && minutes <= 15.1, `locked for about 15 minutes, not hours (${minutes.toFixed(1)})`);
  assert.match(locked.message, /Try after (1[0-5]|[1-9]) minutes/);

  const reset = await api("owner", "PATCH", `/access/users/${lock._id}`, { password: "let-back-in-pass-1" });
  assert.equal(reset.status, 200);
  const after = await admin(email);
  assert.ok(!after.lockUntil && !after.loginAttempts, "the lock is gone");
  assert.equal((await signIn(email, "let-back-in-pass-1")).status, 200, "and she is let in at once");
});

test("a lock stops password checks everywhere: a held session cannot change its password to get past it, and the way out is a reset", { skip }, async () => {
  const email = "nadia@pol.test";
  const s = await signIn(email, "let-back-in-pass-1");
  const token = s.body.tokens.accessToken;
  for (let i = 0; i < 5; i++) await signIn(email, "wrong-password-y");
  assert.equal((await signIn(email, "let-back-in-pass-1")).status, 423);
  // the token she already holds still works for everything else, but "change password" is a place to check a password and so it is shut too:
  // were it not, a stolen session could guess the password there without limit, locked or not (it is counted like a sign-in now)
  const ch = await call("PUT", "/profile/change-password", { token, body: { currentPassword: "let-back-in-pass-1", newPassword: "her-own-now-pass-1", confirmPassword: "her-own-now-pass-1" } });
  assert.equal(ch.status, 423, JSON.stringify(ch.data));
  assert.equal(ch.data.errorCode, "ACCOUNT_LOCKED");
  assert.equal((await call("GET", "/organisation/status", { token })).status, 200, "she is not signed out by it");
  // an administrator's reset (above) or the emailed one (accountSecurityHttp) lets her back in; so does the lock running out
  await as("pol", () => M.Admin.updateOne({ email }, { $set: { loginAttempts: 0 }, $unset: { lockUntil: 1 } }));
  assert.equal((await signIn(email, "let-back-in-pass-1")).status, 200);
});

test("an address that keeps failing is slowed - failures only, and the right password is not exempt - on a server with a small limit", { skip }, async () => {
  start(PORT2, { LOGIN_FAILURE_LIMIT: "5", LOGIN_FAILURE_WINDOW_MS: "600000" });
  await waitUp(BASE2);
  const go = (email, password) => call("POST", "/login", { base: BASE2, body: { email, password } });
  // successful sign-ins never count, however many
  for (let i = 0; i < 8; i++) assert.equal((await go("owner@pol.test", PASSWORD)).status, 200, `sign-in ${i + 1}`);
  // failures do
  for (let i = 0; i < 5; i++) assert.equal((await go(`nobody${i}@pol.test`, "whatever-pass-1")).status, 401, `failure ${i + 1}`);
  const slowed = await go("nobody9@pol.test", "whatever-pass-1");
  assert.equal(slowed.status, 429);
  assert.equal(slowed.code, "TOO_MANY_ATTEMPTS");
  assert.match(slowed.message, /Too many failed sign-in attempts from this address/);
  assert.ok(Number(slowed.retryAfter) > 0 && Number(slowed.retryAfter) <= 600, `Retry-After says when: ${slowed.retryAfter}`);
  assert.equal((await go("owner@pol.test", PASSWORD)).status, 429, "while it lasts, the right password is turned away too");
  assert.equal((await call("POST", "/login", { body: { email: "owner@pol.test", password: PASSWORD } })).status, 200, "the other server has its own count: nothing is shared");
});

test("the audit trail has no trace of any password", { skip }, async () => {
  const rows = await as("pol", () => M.Activity.find({}).lean());
  const text = JSON.stringify(rows);
  for (const secret of [TEMP, "a-new-password-1", "reset-by-admin-1", "hers-again-pass-1", "let-back-in-pass-1", "her-own-now-pass-1", PASSWORD]) assert.ok(!text.includes(secret), `no "${secret}" in the trail`);
});
