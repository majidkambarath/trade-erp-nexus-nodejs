// The organisation's own branches, managed by its own people (/api/v1/branches), against a strict server with real
// sign-ins. What matters: only someone who may change settings changes them; the plan's feature and branch limit hold;
// a branch with people in it is not switched off under them; one organisation cannot touch another's branch.
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

async function call(method, url, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode, details: data?.details, message: data?.message };
}
const as = (code, fn) => ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const api = (who, method, url, body) => call(method, url, { token: T[who], body: method === "GET" ? undefined : body });
const login = async (email) => (await call("POST", "/login", { body: { email, password: PASSWORD } })).body?.tokens?.accessToken;
const setOrg = (code, $set) => M.Organisation.updateOne({ code }, { $set });

async function person(org, who, type, extra = {}) {
  await as(org, () => new M.Admin({ name: who, email: `${who}@${org}.test`, password: PASSWORD, status: "active", isActive: true, type, ...extra }).save());
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
  M = { Admin: require("../../models/core/adminModel"), Organisation: require("../../models/core/organisationModel"), Activity: require("../../models/modules/financial/activityLogModel") };
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

test("a premium organisation and a standard one, each with an owner; the premium one also has a manager and a viewer", { skip }, async () => {
  for (const [code, plan] of [["prem", "premium"], ["stdo", "standard"]]) {
    assert.equal((await Org.create({ legalName: `${code} Trading`, code, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: plan })).provisioning.complete, true);
  }
  await person("prem", "powner", "super_admin");
  await person("prem", "pmanager", "manager");
  await person("prem", "pviewer", "viewer");
  await person("stdo", "sowner", "super_admin");
});

test("the head office is listed, with how many people work from it; a viewer cannot even look", { skip }, async () => {
  const r = await api("powner", "GET", "/branches");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].code, "main");
  assert.equal(r.body[0].isHeadOffice, true);
  assert.equal(r.body[0].people, 3, "the three people of this organisation work from the head office");
  const v = await api("pviewer", "GET", "/branches");
  assert.equal(v.status, 403);
  assert.equal(v.code, "PERMISSION_DENIED");
});

test("only someone who may change settings adds a branch", { skip }, async () => {
  const body = { code: "shj", name: "Sharjah Warehouse", addressLine1: "Industrial Area 3", city: "Sharjah", phone: "06 555 0000", email: "shj@prem.test" };
  for (const who of ["pviewer", "pmanager"]) {
    const r = await api(who, "POST", "/branches", body);
    assert.equal(r.status, 403, `${who}: ${JSON.stringify(r.data)}`);
    assert.equal(r.code, "PERMISSION_DENIED");
    assert.deepEqual(r.details.required, ["settings.manage"]);
  }
  const made = await api("powner", "POST", "/branches", body);
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.body.code, "shj");
  assert.equal(made.body.isHeadOffice, false);
  assert.equal(made.body.address.city, "Sharjah");
  assert.equal(made.body.address.line1, "Industrial Area 3");
  const list = await api("powner", "GET", "/branches");
  assert.deepEqual(list.body.map((b) => b.code), ["main", "shj"], "the head office first");
  const row = await as("prem", () => M.Activity.findOne({ action: "BRANCH_CREATED" }).lean());
  assert.ok(row && /Sharjah Warehouse/.test(row.summary) && row.username === "powner@prem.test", "who added it is on the record");
});

test("a code and a name are required, a code is neither reused nor changed, and the head office stays", { skip }, async () => {
  const bad = async (body, code) => { const r = await api("powner", "POST", "/branches", body); assert.equal(r.code, code, JSON.stringify(r.data)); assert.ok(r.status >= 400 && r.status < 500); };
  await bad({ code: "A B", name: "x" }, "BRANCH_CODE_INVALID");
  await bad({ code: "x", name: "x" }, "BRANCH_CODE_INVALID");
  await bad({ code: "dxb2", name: "  " }, "BRANCH_NAME_REQUIRED");
  await bad({ code: "shj", name: "Another Sharjah" }, "BRANCH_CODE_TAKEN");
  await bad({ code: "main", name: "Another head office" }, "BRANCH_CODE_TAKEN");

  const rename = await api("powner", "PATCH", "/branches/shj", { name: "Sharjah Depot", city: "Sharjah City" });
  assert.equal(rename.status, 200, JSON.stringify(rename.data));
  assert.equal(rename.body.name, "Sharjah Depot");
  assert.equal(rename.body.address.city, "Sharjah City");
  assert.equal((await api("powner", "PATCH", "/branches/shj", { code: "other" })).code, "BRANCH_CODE_LOCKED");
  assert.equal((await api("powner", "PATCH", "/branches/main", { isActive: false })).code, "HEAD_OFFICE_REQUIRED");
  assert.equal((await api("powner", "PATCH", "/branches/main", { isHeadOffice: false })).code, "HEAD_OFFICE_LOCKED");
  assert.equal((await api("powner", "PATCH", "/branches/nowhere", { name: "x" })).code, "BRANCH_NOT_FOUND");
  assert.equal((await api("pmanager", "PATCH", "/branches/shj", { name: "Hijack" })).code, "PERMISSION_DENIED");
});

test("the plan's branch limit holds when adding, and a standard plan without the feature is refused with a plain reason", { skip }, async () => {
  await setOrg("prem", { "limitOverrides.branches": 2 }); // head office and Sharjah are two already
  const full = await api("powner", "POST", "/branches", { code: "dxb2", name: "Dubai Showroom" });
  assert.equal(full.status, 403, JSON.stringify(full.data));
  assert.equal(full.code, "LIMIT_REACHED");
  assert.equal(full.details.resource, "branches");
  assert.equal(full.details.limit, 2);
  assert.match(full.message, /limited to 2 branches/);
  await setOrg("prem", { "limitOverrides.branches": null });
  assert.equal((await api("powner", "POST", "/branches", { code: "dxb2", name: "Dubai Showroom" })).status, 201, "unlimited for this organisation");

  const std = await api("sowner", "POST", "/branches", { code: "shj", name: "Sharjah" });
  assert.equal(std.status, 403);
  assert.equal(std.code, "FEATURE_NOT_IN_PLAN");
  assert.equal(std.details.feature, "multiBranch");
  assert.equal((await api("sowner", "GET", "/branches")).body.length, 1, "it still sees its head office");
});

test("a branch with people in it is not switched off under them; moved out, it can be, and switching it back on needs room", { skip }, async () => {
  const added = await api("powner", "POST", "/access/users", { name: "Sana Sharjah", email: "sana@prem.test", password: PASSWORD, role: "viewer", branchId: "shj" });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  const listed = await api("powner", "GET", "/branches");
  assert.equal(listed.body.find((b) => b.code === "shj").people, 1);

  const blocked = await api("powner", "PATCH", "/branches/shj", { isActive: false });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.data));
  assert.equal(blocked.code, "BRANCH_HAS_PEOPLE");
  assert.equal(blocked.details.people, 1);
  assert.match(blocked.message, /1 person works in this branch/);
  assert.equal((await as("prem", () => M.Admin.findOne({ email: "sana@prem.test" }).lean())).branchId, "shj", "she is still where she was");

  const moved = await api("powner", "PATCH", `/access/users/${added.body.id}`, { branchId: "main" });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  const off = await api("powner", "PATCH", "/branches/shj", { isActive: false });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.body.isActive, false);

  // switching it back on is a place under the limit again
  await setOrg("prem", { "limitOverrides.branches": 2 }); // head office and Dubai Showroom
  const full = await api("powner", "PATCH", "/branches/shj", { isActive: true });
  assert.equal(full.code, "LIMIT_REACHED", JSON.stringify(full.data));
  await setOrg("prem", { "limitOverrides.branches": 3 });
  assert.equal((await api("powner", "PATCH", "/branches/shj", { isActive: true })).status, 200, "room again");
  await setOrg("prem", { "limitOverrides.branches": null });
});

test("one organisation cannot see or change another's branches", { skip }, async () => {
  const other = await api("sowner", "PATCH", "/branches/shj", { name: "Hijack" });
  assert.equal(other.code, "BRANCH_NOT_FOUND", "stdo has no such branch: it is invisible, not forbidden");
  assert.equal((await api("sowner", "GET", "/branches")).body.map((b) => b.code).join(), "main");
  assert.equal((await as("prem", () => M.Organisation.findOne({ code: "prem" }).lean())).code, "prem");
});
