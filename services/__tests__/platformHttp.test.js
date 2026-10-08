// The developer console over HTTP, against a real STRICT server: who may sign in, that a customer's token and a
// console token can never open each other's doors, creating an organisation with its first administrator and its
// base currency, editing it, extending and suspending it, its people and branches, and the record of all of it.
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
const DEV = { name: "Dev One", email: "dev1@zarvia.test", password: "a-long-passphrase-123" };

let child, PlatformAuth, ctx, M;
let logs = "";
const S = {};

async function call(method, url, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode || data?.error };
}
const plat = (method, url, body, token = S.token) => call(method, `/platform${url}`, { body, token });
const raw = (fn) => ctx.runUnscoped("a test inspecting what is really stored, across organisations", fn);
const erpLogin = async (email, password) => (await call("POST", "/login", { body: { email, password } })).body?.tokens?.accessToken;
const newOrg = (over = {}) => ({ legalName: "Gulf Fresh Foods LLC", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "standard", firstAdmin: { name: "Owner One", email: "owner@gulffresh.test", password: "owner-password-1" }, ...over });

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  PlatformAuth = require("../platform/platformAuthService");
  ctx = require("../../utils/tenantContext");
  M = { Admin: require("../../models/core/adminModel"), Audit: require("../../models/platform/platformAuditModel"), Activity: require("../../models/modules/financial/activityLogModel") };
  await mongoose.connection.syncIndexes();
  const deadline = Date.now() + 60000;
  for (;;) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  await PlatformAuth.create(DEV);
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

test("signing in: the same refusal for a wrong password and for no such person", { skip }, async () => {
  const wrong = await plat("POST", "/login", { email: DEV.email, password: "not-the-password-1" }, null);
  const nobody = await plat("POST", "/login", { email: "nobody@zarvia.test", password: "not-the-password-1" }, null);
  assert.equal(wrong.status, 401);
  assert.equal(nobody.status, 401);
  assert.equal(wrong.data.message, nobody.data.message, "nothing says which one it was");
  assert.equal((await plat("POST", "/login", {}, null)).status, 400);
  const ok = await plat("POST", "/login", { email: DEV.email.toUpperCase(), password: DEV.password }, null);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  S.token = ok.body.token;
  assert.equal(ok.body.user.password, undefined, "the password never leaves the server");
  assert.equal((await plat("GET", "/me")).body.email, DEV.email);
});

test("every console route needs a console token", { skip }, async () => {
  for (const [m, u] of [["GET", "/me"], ["GET", "/catalog"], ["GET", "/organisations"], ["POST", "/organisations"], ["GET", "/organisations/x"], ["PATCH", "/organisations/x"], ["POST", "/organisations/x/extend"], ["POST", "/organisations/x/status"], ["GET", "/organisations/x/users"], ["POST", "/organisations/x/users"], ["GET", "/organisations/x/branches"], ["GET", "/users"], ["POST", "/users"], ["GET", "/audit"]]) {
    assert.equal((await plat(m, u, undefined, null)).status, 401, `${m} ${u}`);
    assert.equal((await plat(m, u, undefined, "not.a.token")).status, 401, `${m} ${u} with garbage`);
  }
});

test("a console account can be made only with a strong password, and not twice", { skip }, async () => {
  assert.equal((await plat("POST", "/users", { name: "Weak One", email: "weak@zarvia.test", password: "short1" })).code, "WEAK_PASSWORD");
  assert.equal((await plat("POST", "/users", { name: "Weak Two", email: "weak2@zarvia.test", password: "onlyletterslongenough" })).code, "WEAK_PASSWORD");
  assert.equal((await plat("POST", "/users", { name: "Dev One Again", email: DEV.email, password: "another-long-pass-1" })).status, 409);
  const made = await plat("POST", "/users", { name: "Dev Two", email: "dev2@zarvia.test", password: "second-long-pass-2" });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.body.password, undefined);
  S.dev2 = made.body._id;
});

test("a customer's token cannot open the console, and a console token cannot open a customer's data", { skip }, async () => {
  const created = await plat("POST", "/organisations", newOrg());
  assert.equal(created.status, 201, JSON.stringify(created.data));
  S.org = created.body.organisation.code;
  const erpToken = await erpLogin("owner@gulffresh.test", "owner-password-1");
  assert.ok(erpToken, "the organisation's first administrator can sign in to the product");

  const intoConsole = await plat("GET", "/organisations", undefined, erpToken);
  assert.equal(intoConsole.status, 401, "a customer's token is not a console token");
  const intoProduct = await call("GET", "/currencies", { token: S.token });
  assert.equal(intoProduct.status, 401, "a console token is not a customer's token");
  assert.equal((await call("GET", "/", { token: S.token })).status, 401, "nor can it list a customer's accounts");
  S.erpToken = erpToken;
});

test("the catalogue offers the plans, features, currencies, and says why a three-decimal currency is not offered", { skip }, async () => {
  const c = (await plat("GET", "/catalog")).body;
  assert.deepEqual(c.plans.map((p) => p.code).sort(), ["internal", "premium", "standard", "trial"]);
  assert.ok(c.features.some((f) => f.key === "einvoicing"));
  assert.ok(c.currencies.some((x) => x.code === "AED") && c.currencies.some((x) => x.code === "SAR"));
  assert.ok(!c.currencies.some((x) => x.code === "KWD"));
  assert.ok(c.unsupportedCurrencies.includes("KWD"));
  assert.ok(c.timezones.includes("Asia/Dubai"));
});

test("a new organisation arrives complete: its own books in the chosen currency, a head office, and a working first administrator", { skip }, async () => {
  const d = (await plat("GET", `/organisations/${S.org}`)).body;
  assert.equal(d.organisation.baseCurrency, "AED");
  assert.equal(d.organisation.provisioning.complete, true, JSON.stringify(d.organisation.provisioning));
  assert.equal(d.usage.users, 1);
  assert.equal(d.usage.branches, 1, "the head office");
  assert.equal(d.state.state, "active");
  assert.equal(d.features.einvoicing, false, "not in the standard plan");
  assert.equal(d.features.banking, true, "in the standard plan");
  assert.equal(d.limits.users, 10);
  assert.equal(d.room.users.remaining, 9);
  const owner = await raw(() => M.Admin.findOne({ email: "owner@gulffresh.test" }).lean());
  assert.equal(owner.companyId, S.org);
  assert.equal(owner.type, "super_admin", "the first administrator can manage their own people");
  assert.equal((await call("GET", "/currencies", { token: S.erpToken })).status, 200);
});

test("a bad organisation is refused with the reason, and nothing is half made", { skip }, async () => {
  const before = (await plat("GET", "/organisations")).body.total;
  const kwd = await plat("POST", "/organisations", newOrg({ legalName: "Kuwait Foods", baseCurrency: "KWD", firstAdmin: undefined }));
  assert.equal(kwd.status, 400);
  assert.equal(kwd.code, "CURRENCY_NOT_SUPPORTED");
  assert.match(kwd.data.message, /three decimal/);
  assert.equal((await plat("POST", "/organisations", newOrg({ legalName: "Dup Code", code: S.org, firstAdmin: undefined }))).status, 409);
  const clash = await plat("POST", "/organisations", newOrg({ legalName: "Email Clash Co" })); // same first-admin email as the existing owner
  assert.equal(clash.status, 409);
  assert.equal(clash.code, "EMAIL_EXISTS");
  assert.equal((await plat("POST", "/organisations", newOrg({ legalName: "No Pass Co", firstAdmin: { name: "X", email: "x@x.test" } }))).code, "FIRST_ADMIN_INCOMPLETE");
  assert.equal((await plat("GET", "/organisations")).body.total, before, "no organisation was created by any of those");
});

test("the developer edits an organisation; what cannot change is refused", { skip }, async () => {
  const up = await plat("PATCH", `/organisations/${S.org}`, { legalName: "Gulf Fresh Foods Trading LLC", notes: "Signed 8 Oct", featureOverrides: { einvoicing: true }, limitOverrides: { users: 3 } });
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.body.organisation.legalName, "Gulf Fresh Foods Trading LLC");
  assert.equal(up.body.features.einvoicing, true, "switched on over the plan");
  assert.equal(up.body.limits.users, 3);
  assert.equal((await plat("PATCH", `/organisations/${S.org}`, { baseCurrency: "USD" })).code, "BASE_CURRENCY_LOCKED");
  assert.equal((await plat("PATCH", `/organisations/${S.org}`, { country: "SA" })).code, "COUNTRY_LOCKED");
  assert.equal((await plat("PATCH", `/organisations/${S.org}`, { planCode: "gold" })).code, "PLAN_INVALID");
  const reset = await plat("PATCH", `/organisations/${S.org}`, { resetFeatures: ["einvoicing"], resetLimits: ["users"] });
  assert.equal(reset.body.features.einvoicing, false, "back to the plan's setting");
  assert.equal(reset.body.limits.users, 10);
  assert.equal((await plat("GET", "/organisations/no-such-org")).status, 404);
});

test("a subscription can be extended and the organisation suspended and reopened", { skip }, async () => {
  const set = await plat("PATCH", `/organisations/${S.org}`, { subscription: { endsAt: "2027-03-31", graceDays: 7, onExpiry: "readonly" } });
  assert.equal(set.body.organisation.subscription.endsAt.slice(0, 10), "2027-03-31");
  const ext = await plat("POST", `/organisations/${S.org}/extend`, { days: 30 });
  assert.equal(ext.body.organisation.subscription.endsAt.slice(0, 10), "2027-04-30");
  assert.equal((await plat("POST", `/organisations/${S.org}/extend`, { days: 0 })).code, "DAYS_INVALID");
  const sus = await plat("POST", `/organisations/${S.org}/status`, { status: "suspended" });
  assert.equal(sus.body.state.state, "suspended");
  assert.equal(sus.body.state.blocked, true);
  assert.equal((await plat("POST", `/organisations/${S.org}/status`, { status: "deleted" })).code, "STATUS_INVALID");
  const back = await plat("POST", `/organisations/${S.org}/status`, { status: "active" });
  assert.equal(back.body.state.state, "active");
});

test("the developer corrects a customer's company details, and the customer sees them", { skip }, async () => {
  const done = await plat("PUT", `/organisations/${S.org}/profile`, { trn: "100123456700003", addressLine1: "Al Quoz, Dubai", city: "Dubai", emirate: "Dubai", vatRegistered: true });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const seen = await call("GET", "/accounting/settings", { token: S.erpToken });
  assert.equal(seen.body.profile.trn, "100123456700003", "the customer's own settings screen shows what the developer entered");
  assert.equal(seen.body.profile.legalName, "Gulf Fresh Foods LLC");
  assert.equal((await plat("PUT", `/organisations/${S.org}/profile`, { trn: "123" })).status, 400, "an invalid TRN is refused");
});

test("the organisation's people are managed from the console, within its limits", { skip }, async () => {
  const users = (await plat("GET", `/organisations/${S.org}/users`)).body;
  assert.deepEqual(users.map((u) => u.email), ["owner@gulffresh.test"]);
  await plat("PATCH", `/organisations/${S.org}`, { limitOverrides: { users: 2 } });
  const clerk = await plat("POST", `/organisations/${S.org}/users`, { name: "Clerk One", email: "clerk@gulffresh.test", password: "clerk-password-1", type: "operator" });
  assert.equal(clerk.status, 201, JSON.stringify(clerk.data));
  S.clerk = clerk.body.id;
  const over = await plat("POST", `/organisations/${S.org}/users`, { name: "Clerk Two", email: "clerk2@gulffresh.test", password: "clerk-password-2", type: "viewer" });
  assert.equal(over.status, 403);
  assert.equal(over.code, "LIMIT_REACHED");
  assert.equal((await plat("POST", `/organisations/${S.org}/users`, { name: "Dup", email: "owner@gulffresh.test", password: "clerk-password-3" })).code, "EMAIL_EXISTS");
  assert.equal((await plat("POST", `/organisations/${S.org}/users`, { name: "Bad", email: "bad@gulffresh.test", password: "x", type: "wizard" })).code, "TYPE_INVALID");
  await plat("PATCH", `/organisations/${S.org}`, { resetLimits: ["users"] });

  assert.ok(await erpLogin("clerk@gulffresh.test", "clerk-password-1"), "the new account signs in");
  assert.equal((await plat("PATCH", `/organisations/${S.org}/users/${S.clerk}`, { password: "x" })).code, "WEAK_PASSWORD");
  assert.equal((await plat("PATCH", `/organisations/${S.org}/users/${S.clerk}`, { password: "a-reset-password-9" })).status, 200);
  assert.equal(await erpLogin("clerk@gulffresh.test", "clerk-password-1"), undefined, "the old password stopped working");
  assert.ok(await erpLogin("clerk@gulffresh.test", "a-reset-password-9"), "the reset one works");
  await plat("PATCH", `/organisations/${S.org}/users/${S.clerk}`, { status: "inactive" });
  assert.equal(await erpLogin("clerk@gulffresh.test", "a-reset-password-9"), undefined, "a switched-off account cannot sign in");
});

test("the organisation can never be left with no administrator", { skip }, async () => {
  const ownerId = (await plat("GET", `/organisations/${S.org}/users`)).body.find((u) => u.email === "owner@gulffresh.test")._id;
  for (const patch of [{ status: "inactive" }, { type: "viewer" }]) {
    const r = await plat("PATCH", `/organisations/${S.org}/users/${ownerId}`, patch);
    assert.equal(r.status, 409, JSON.stringify(patch));
    assert.equal(r.code, "LAST_ADMIN");
  }
  assert.equal((await plat("PATCH", `/organisations/${S.org}/users/${new mongoose.Types.ObjectId()}`, { name: "Ghost" })).status, 404);
});

test("a second branch needs the feature and the room, and the head office is always there", { skip }, async () => {
  const none = await plat("POST", `/organisations/${S.org}/branches`, { code: "dxb", name: "Dubai Warehouse" });
  assert.equal(none.status, 403);
  assert.equal(none.code, "FEATURE_NOT_IN_PLAN");
  await plat("PATCH", `/organisations/${S.org}`, { featureOverrides: { multiBranch: true } });
  const made = await plat("POST", `/organisations/${S.org}/branches`, { code: "dxb", name: "Dubai Warehouse", city: "Dubai" });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const list = (await plat("GET", `/organisations/${S.org}/branches`)).body;
  assert.deepEqual(list.map((b) => b.code), ["main", "dxb"], "head office first");
  assert.equal(list[0].isHeadOffice, true);
  assert.equal((await plat("PATCH", `/organisations/${S.org}/branches/main`, { isActive: false })).code, "HEAD_OFFICE_REQUIRED");
  assert.equal((await plat("PATCH", `/organisations/${S.org}/branches/dxb`, { name: "Dubai Cold Store" })).body.name, "Dubai Cold Store");
  assert.equal((await plat("GET", `/organisations/${S.org}`)).body.usage.branches, 2);
});

test("every change is recorded for the developers, and in the organisation's own trail", { skip }, async () => {
  const log = (await plat("GET", `/audit?organisation=${S.org}`)).body;
  const actions = log.rows.map((r) => r.action);
  for (const a of ["ORGANISATION_CREATED", "ORGANISATION_UPDATED", "SUBSCRIPTION_EXTENDED", "ORGANISATION_SUSPENDED", "COMPANY_PROFILE_UPDATED", "USER_CREATED", "USER_UPDATED", "BRANCH_CREATED"]) {
    assert.ok(actions.includes(a), `${a} was recorded; got ${actions.join(", ")}`);
  }
  assert.ok(log.rows.every((r) => r.by === DEV.email), "each names the developer who did it");
  const theirs = await raw(() => M.Activity.find({ companyId: S.org, action: /^PLATFORM_/ }).lean());
  assert.ok(theirs.length >= 5, "the organisation's own audit trail has them too");
  assert.ok(theirs.every((r) => /platform support/.test(r.username)), "named as the platform, not as one of their staff");
  const written = JSON.stringify(log) + JSON.stringify(theirs);
  for (const secret of [DEV.password, "owner-password-1", "clerk-password-1", "clerk-password-2", "second-long-pass-2"]) {
    assert.equal(written.includes(secret), false, "no password value is written to the log");
  }
});

test("the platform's own accounts: a developer cannot switch off themselves or the last one", { skip }, async () => {
  const me = (await plat("GET", "/me")).body._id;
  assert.equal((await plat("PATCH", `/users/${me}`, { status: "inactive" })).code, "CANNOT_DISABLE_SELF");
  assert.equal((await plat("PATCH", `/users/${S.dev2}`, { status: "inactive" })).status, 200);
  assert.equal((await call("POST", "/platform/login", { body: { email: "dev2@zarvia.test", password: "second-long-pass-2" } })).status, 401, "a switched-off developer cannot sign in");
});
