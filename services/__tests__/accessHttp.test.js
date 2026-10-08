// The people and roles of an organisation, managed by its own administrators, against a strict server. What matters is
// who may NOT: nobody builds or hands out more power than they hold, nobody changes their own role, a role in use is not
// pulled from under its people, and one organisation's people and roles are invisible to another.
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
const login = async (email, password = PASSWORD) => (await call("POST", "/login", { body: { email, password } })).body?.tokens?.accessToken;
const me = async (who) => (await api(who, "GET", "/organisation/status")).body.me;
const emailOf = (who) => `${who}@acc.test`;
const newPerson = (over = {}) => ({ name: "New Person", email: "new@acc.test", password: PASSWORD, role: "viewer", ...over });

async function person(org, who, fields) {
  await as(org, () => new M.Admin({ name: who, email: `${who}@${org}.test`, password: PASSWORD, status: "active", isActive: true, ...fields }).save());
  T[who] = await login(`${who}@${org}.test`);
  assert.ok(T[who], `${who} signs in`);
}

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = { Admin: require("../../models/core/adminModel"), Role: require("../../models/core/roleModel"), Organisation: require("../../models/core/organisationModel"), Activity: require("../../models/modules/financial/activityLogModel") };
  Org = require("../core/organisationService");
  ctx = require("../../utils/tenantContext");
  perms = require("../../utils/permissions");
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

test("two organisations, and an owner, an administrator, a manager and a viewer in the first", { skip }, async () => {
  for (const code of ["acc", "other"]) assert.equal((await Org.create({ legalName: `${code} Trading`, code, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" })).provisioning.complete, true);
  await person("acc", "owner", { type: "super_admin" });
  await person("acc", "admin", { type: "admin" });
  await person("acc", "manager", { type: "manager" });
  await person("acc", "viewer", { type: "viewer" });
  await person("other", "stranger", { type: "super_admin" });
});

test("the roles are listed with the catalogue the editor draws, and how many people hold each", { skip }, async () => {
  const r = await api("owner", "GET", "/access/roles");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.body.roles.filter((x) => x.builtIn).map((x) => x.key), perms.BUILT_IN_KEYS);
  assert.deepEqual(r.body.catalogue.map((m) => m.key), perms.MODULE_KEYS);
  assert.equal(r.body.roles.find((x) => x.key === "super_admin").people, 1);
  assert.equal(r.body.roles.find((x) => x.key === "viewer").people, 1);
  assert.ok(r.body.roles.every((x) => x.permissions.every((k) => perms.isKey(k))));
});

test("only people who may see people can: a manager and a viewer cannot even list them", { skip }, async () => {
  for (const who of ["manager", "viewer"]) {
    for (const [m, u] of [["GET", "/access/users"], ["GET", "/access/roles"], ["POST", "/access/users"], ["POST", "/access/roles"]]) {
      const r = await api(who, m, u, {});
      assert.equal(r.status, 403, `${who} ${m} ${u}`);
      assert.equal(r.code, "PERMISSION_DENIED");
    }
  }
  const list = await api("admin", "GET", "/access/users");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((u) => u.email).sort(), ["admin@acc.test", "manager@acc.test", "owner@acc.test", "viewer@acc.test"]);
  assert.ok(list.body.every((u) => u.role.name && u.role.rank > 0 && !("password" in u)), "each with their role, and never a password");
});

test("an administrator adds a person with a built-in role, and that person signs in holding exactly it", { skip }, async () => {
  const r = await api("admin", "POST", "/access/users", newPerson({ name: "Aisha Accountant", email: "aisha@acc.test", role: "accountant" }));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.body.role.key, "accountant");
  const row = await as("acc", () => M.Admin.findOne({ email: "aisha@acc.test" }).lean());
  assert.equal(row.type, "viewer", "stored over the safest type");
  assert.equal(row.roleKey, "accountant");
  assert.equal(row.createdBy && String(row.createdBy), String((await me("admin")).id));
  T.aisha = await login("aisha@acc.test");
  const who = await me("aisha");
  assert.equal(who.role.key, "accountant");
  assert.deepEqual(who.grants, perms.BUILT_IN.accountant.permissions);
  // and the lock really is that role's: she keeps the books and cannot approve a sale
  assert.notEqual((await api("aisha", "POST", "/vouchers/vouchers", {})).code, "PERMISSION_DENIED");
  assert.equal((await api("aisha", "PATCH", `/transactions/transactions/64b64b64b64b64b64b64b64b/process`, { action: "approve" })).code, "PERMISSION_DENIED");
});

test("an account of one of the original five types keeps being stored as that type", { skip }, async () => {
  const r = await api("owner", "POST", "/access/users", newPerson({ email: "mgr2@acc.test", role: "manager" }));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const row = await as("acc", () => M.Admin.findOne({ email: "mgr2@acc.test" }).lean());
  assert.equal(row.type, "manager");
  assert.equal(row.roleKey ?? null, null);
});

test("nobody hands out a role at or above their own", { skip }, async () => {
  const sly = await api("admin", "POST", "/access/users", newPerson({ email: "rival@acc.test", role: "admin" }));
  assert.equal(sly.status, 403);
  assert.equal(sly.code, "SUPER_ADMIN_REQUIRED");
  assert.equal((await api("admin", "POST", "/access/users", newPerson({ email: "boss2@acc.test", role: "super_admin" }))).code, "SUPER_ADMIN_REQUIRED");
  assert.equal((await api("owner", "POST", "/access/users", newPerson({ email: "second-owner@acc.test", role: "super_admin" }))).status, 201, "an owner may make another owner");
  assert.equal((await api("owner", "POST", "/access/users", newPerson({ email: "adm2@acc.test", role: "admin" }))).status, 201, "and an administrator");
});

test("what is refused is refused for a reason that is said", { skip }, async () => {
  const bad = async (over, code) => {
    const r = await api("owner", "POST", "/access/users", newPerson(over));
    assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(r.data));
    assert.equal(r.code, code, JSON.stringify(r.data));
  };
  await bad({ email: "not an email" }, "EMAIL_INVALID");
  await bad({ email: "short@acc.test", password: "abc" }, "WEAK_PASSWORD");
  await bad({ email: "nameless@acc.test", name: "" }, "NAME_REQUIRED");
  await bad({ email: "aisha@acc.test" }, "EMAIL_EXISTS");
  await bad({ email: "stranger@other.test" }, "EMAIL_EXISTS"); // an email is one person's, in any organisation
  await bad({ email: "norole@acc.test", role: "no_such_role" }, "ROLE_NOT_FOUND");
  await bad({ email: "nobranch@acc.test", branchId: "nowhere" }, "BRANCH_NOT_FOUND");
});

test("a custom role: made, held, and the people holding it follow its edits at once", { skip }, async () => {
  const made = await api("admin", "POST", "/access/roles", { key: "supervisor", name: "Sales supervisor", description: "Approves sales", rank: 55, permissions: ["sales.create", "sales.approve", "reports.financial"] });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.body.rank, 55);
  assert.ok(made.body.permissions.includes("sales.view") && made.body.permissions.includes("lookups.view"), "the implied ones are drawn in");
  assert.deepEqual(made.body.named, ["sales.create", "sales.approve", "reports.financial"], "and what was ticked is kept apart from them");

  const hire = await api("admin", "POST", "/access/users", newPerson({ name: "Sam Supervisor", email: "sam@acc.test", role: "supervisor" }));
  assert.equal(hire.status, 201, JSON.stringify(hire.data));
  assert.equal(hire.body.role.builtIn, false);
  T.sam = await login("sam@acc.test");
  assert.equal((await me("sam")).role.key, "supervisor");
  assert.notEqual((await api("sam", "PATCH", `/transactions/transactions/64b64b64b64b64b64b64b64b/process`, { action: "approve" })).code, "PERMISSION_DENIED");

  const roles = (await api("admin", "GET", "/access/roles")).body.roles;
  assert.equal(roles.find((r) => r.key === "supervisor").people, 1);

  const narrowed = await api("admin", "PATCH", "/access/roles/supervisor", { permissions: ["sales.view"] });
  assert.equal(narrowed.status, 200, JSON.stringify(narrowed.data));
  assert.deepEqual((await me("sam")).grants, ["sales.view"], "with the token he already holds");
  assert.equal((await api("sam", "PATCH", `/transactions/transactions/64b64b64b64b64b64b64b64b/process`, { action: "approve" })).code, "PERMISSION_DENIED");
});

test("a role in use is not pulled from under its people", { skip }, async () => {
  const off = await api("admin", "PATCH", "/access/roles/supervisor", { isActive: false });
  assert.equal(off.status, 409);
  assert.equal(off.code, "ROLE_IN_USE");
  const del = await api("admin", "DELETE", "/access/roles/supervisor");
  assert.equal(del.status, 409);
  assert.equal(del.code, "ROLE_IN_USE");
  assert.equal(del.details.people, 1);
  const samId = (await api("admin", "GET", "/access/users")).body.find((u) => u.email === "sam@acc.test").id;
  ID.sam = samId;
  assert.equal((await api("admin", "PATCH", `/access/users/${samId}`, { role: "viewer" })).status, 200);
  assert.equal((await me("sam")).role.key, "viewer", "re-roled, at once");
  assert.equal((await api("admin", "DELETE", "/access/roles/supervisor")).status, 200);
  assert.equal((await api("admin", "GET", "/access/roles")).body.roles.some((r) => r.key === "supervisor"), false);
});

test("a built-in role cannot be changed or removed", { skip }, async () => {
  for (const [m, u] of [["PATCH", "/access/roles/manager"], ["DELETE", "/access/roles/manager"], ["PATCH", "/access/roles/viewer"], ["DELETE", "/access/roles/super_admin"]]) {
    const r = await api("owner", m, u, { permissions: ["users.manage"] });
    assert.equal(r.status, 409, `${m} ${u}`);
    assert.equal(r.code, "BUILT_IN_ROLE");
  }
  const clash = await api("owner", "POST", "/access/roles", { key: "manager", name: "Fake manager", rank: 30, permissions: [] });
  assert.equal(clash.status, 400);
  assert.equal(clash.code, "ROLE_INVALID");
});

test("nobody builds a role more powerful than themselves", { skip }, async () => {
  const bad = async (body, field) => {
    const r = await api("admin", "POST", "/access/roles", { key: "tmp_role", name: "Tmp", rank: 40, permissions: [], ...body });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.equal(r.code, "ROLE_INVALID");
    assert.ok(r.details.errors[field], `names ${field}: ${JSON.stringify(r.details.errors)}`);
  };
  await bad({ rank: 80 }, "rank"); // an administrator is 80: not at their own rank
  await bad({ rank: 95 }, "rank");
  await bad({ permissions: ["sales.fly"] }, "permissions");
  await bad({ key: "Bad Key" }, "key");
  await bad({ key: "viewer" }, "key");

  // a person who may manage people, but holds little else, cannot grant what they do not hold
  await as("acc", () => M.Role.create({ key: "hr", name: "HR", rank: 55, permissions: ["users.manage", "users.view"] }));
  const hr = await api("admin", "POST", "/access/users", newPerson({ name: "Hana HR", email: "hana@acc.test", role: "hr" }));
  assert.equal(hr.status, 201, JSON.stringify(hr.data));
  T.hana = await login("hana@acc.test");
  const grabs = await api("hana", "POST", "/access/roles", { key: "grabby", name: "Grabby", rank: 30, permissions: ["finance.approve"] });
  assert.equal(grabs.status, 400);
  assert.match(grabs.details.errors.permissions, /finance\.approve/, "names what was beyond her");
  const high = await api("hana", "POST", "/access/roles", { key: "higher", name: "Higher", rank: 60, permissions: ["users.view"] });
  assert.equal(high.status, 400);
  assert.ok(high.details.errors.rank);
  const fine = await api("hana", "POST", "/access/roles", { key: "clerk", name: "Clerk", rank: 30, permissions: ["users.view"] });
  assert.equal(fine.status, 201, JSON.stringify(fine.data));
});

test("and nobody hands out, or touches, a role above their own", { skip }, async () => {
  const adminId = (await api("owner", "GET", "/access/users")).body.find((u) => u.email === "admin@acc.test").id;
  const mgr = await api("hana", "POST", "/access/users", newPerson({ email: "up@acc.test", role: "manager" }));
  assert.equal(mgr.status, 403);
  assert.equal(mgr.code, "RANK_TOO_LOW", "a manager outranks her");
  assert.equal((await api("hana", "PATCH", `/access/users/${adminId}`, { name: "Hacked" })).code, "SUPER_ADMIN_REQUIRED", "an administrator is above her");
  const ok = await api("hana", "POST", "/access/users", newPerson({ email: "clerk1@acc.test", role: "clerk" }));
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal((await api("hana", "PATCH", `/access/roles/supervisor`, { name: "x" })).status, 404, "the role she cannot edit is gone");
  // a role at her own rank is not hers to change
  await as("acc", () => M.Role.create({ key: "peer", name: "Peer", rank: 55, permissions: ["users.view"] }));
  assert.equal((await api("hana", "PATCH", "/access/roles/peer", { name: "Mine now" })).code, "RANK_TOO_LOW");
  assert.equal((await api("hana", "DELETE", "/access/roles/peer")).code, "RANK_TOO_LOW");
});

test("nobody changes their own role, switches themselves off, or resets their own password here", { skip }, async () => {
  const mine = (await api("owner", "GET", "/access/users")).body;
  const ownerId = mine.find((u) => u.email === "owner@acc.test").id;
  const adminId = mine.find((u) => u.email === "admin@acc.test").id;
  for (const patch of [{ role: "viewer" }, { status: "inactive" }, { branchId: "main" }, { password: "new-password-1" }]) {
    const r = await api("owner", "PATCH", `/access/users/${ownerId}`, patch);
    assert.equal(r.status, 403, JSON.stringify(patch));
    assert.equal(r.code, "CANNOT_CHANGE_SELF");
  }
  assert.equal((await api("admin", "PATCH", `/access/users/${adminId}`, { role: "owner" })).code, "CANNOT_CHANGE_SELF", "an administrator cannot promote themselves");
  assert.equal((await api("admin", "PATCH", `/access/users/${adminId}`, { name: "Admin Renamed" })).status, 200, "but may change their own name");
});

test("switching a person off locks them out on their next request, and on again lets them back", { skip }, async () => {
  const id = (await api("admin", "GET", "/access/users")).body.find((u) => u.email === "aisha@acc.test").id;
  const off = await api("admin", "PATCH", `/access/users/${id}`, { status: "inactive" });
  assert.equal(off.status, 200);
  assert.equal(off.body.isActive, false);
  assert.equal((await api("aisha", "GET", "/organisation/status")).status, 401, "the token she holds stops working");
  assert.equal(await login("aisha@acc.test"), undefined, "and she cannot sign in");
  assert.equal((await api("admin", "PATCH", `/access/users/${id}`, { status: "active" })).status, 200);
  assert.ok(await login("aisha@acc.test"), "back in");
});

test("an administrator resets a password, and the old one stops working", { skip }, async () => {
  const id = (await api("admin", "GET", "/access/users")).body.find((u) => u.email === "aisha@acc.test").id;
  assert.equal((await api("admin", "PATCH", `/access/users/${id}`, { password: "short" })).code, "WEAK_PASSWORD");
  assert.equal((await api("admin", "PATCH", `/access/users/${id}`, { password: "a-better-password-1" })).status, 200);
  assert.equal(await login("aisha@acc.test"), undefined, "the old password");
  assert.ok(await login("aisha@acc.test", "a-better-password-1"), "the new one");
});

test("the plan's limit on people applies here too, and switching someone back on counts", { skip }, async () => {
  const used = (await api("owner", "GET", "/access/users")).body.filter((u) => u.isActive).length;
  await M.Organisation.updateOne({ code: "acc" }, { $set: { "limitOverrides.users": used } });
  const full = await api("admin", "POST", "/access/users", newPerson({ email: "toomany@acc.test" }));
  assert.equal(full.status, 403);
  assert.equal(full.code, "LIMIT_REACHED");
  const id = (await api("admin", "GET", "/access/users")).body.find((u) => u.email === "clerk1@acc.test").id;
  assert.equal((await api("admin", "PATCH", `/access/users/${id}`, { status: "inactive" })).status, 200, "switching off is always allowed");
  assert.equal((await api("admin", "POST", "/access/users", newPerson({ email: "fits@acc.test" }))).status, 201, "and it freed a place");
  assert.equal((await api("admin", "PATCH", `/access/users/${id}`, { status: "active" })).code, "LIMIT_REACHED", "so switching back on needs room");
  await M.Organisation.updateOne({ code: "acc" }, { $set: { limitOverrides: {} } });
});

test("one organisation's people and roles are invisible to another", { skip }, async () => {
  const theirs = await api("stranger", "GET", "/access/users");
  assert.deepEqual(theirs.body.map((u) => u.email), ["stranger@other.test"]);
  const roles = (await api("stranger", "GET", "/access/roles")).body.roles;
  assert.equal(roles.filter((r) => !r.builtIn).length, 0, "acc's custom roles are not theirs");
  const hanaId = (await api("owner", "GET", "/access/users")).body.find((u) => u.email === "hana@acc.test").id;
  assert.equal((await api("stranger", "PATCH", `/access/users/${hanaId}`, { name: "Gotcha" })).status, 404, "a person of another organisation, by id");
  const adopt = await api("stranger", "POST", "/access/users", newPerson({ email: "x@other.test", role: "hr" }));
  assert.equal(adopt.code, "ROLE_NOT_FOUND", "acc's role key means nothing in other");
});

test("who did what is written to the organisation's own trail", { skip }, async () => {
  const rows = await as("acc", () => M.Activity.find({ action: { $in: ["USER_CREATED", "USER_UPDATED", "ROLE_CREATED", "ROLE_UPDATED", "ROLE_REMOVED"] } }).lean());
  const actions = new Set(rows.map((r) => r.action));
  for (const a of ["USER_CREATED", "USER_UPDATED", "ROLE_CREATED", "ROLE_UPDATED", "ROLE_REMOVED"]) assert.ok(actions.has(a), a);
  assert.ok(rows.some((r) => r.action === "USER_CREATED" && /aisha@acc\.test added as Accountant/.test(r.summary) && r.username === "admin@acc.test"));
  assert.ok(rows.every((r) => !/password/i.test(JSON.stringify(r.after || {}))), "and never a password");
});
