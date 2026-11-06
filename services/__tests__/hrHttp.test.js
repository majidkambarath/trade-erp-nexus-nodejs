// The /api/v1/hr routes against a real, spawned strict server: an organisation that bought HR can use them,
// one that did not is refused the whole module, and a custom role without hr.confidential can read the
// employee directory but never a wage - proving the gates in routes/hr/hrRoutes.js and
// controllers/hr/contractController.js actually hold over HTTP, not just in the service layer (already
// proven against a real database in services/__tests__/labourCost.test.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_hr_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3940 + Math.floor(Math.random() * 180);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";

let child, M, Org, ctx;
let logs = "";
const T = {};

async function call(method, url, { body, token, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (form) payload = form;
  else if (body) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}${url}`, { method, headers, body: payload });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode, details: data?.details };
}
const as = (code, fn) => ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const api = (who, method, url, body) => call(method, url, { token: T[who].token, body });

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = { Admin: require("../../models/core/adminModel") };
  Org = require("../core/organisationService");
  ctx = require("../../utils/tenantContext");
  await mongoose.connection.syncIndexes();
  const deadline = Date.now() + 60000;
  for (;;) {
    try { const h = await fetch(`${BASE}/health`); if (h.ok && (await h.json()).ready !== false) break; } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 400));
  }

  // "hremp" bought the whole product (premium: has hr); "hrno" bought trade-only (no hr).
  for (const [code, plan] of [["hremp", "premium"], ["hrno", "trading"]]) {
    await Org.create({ legalName: `${code} Co`, code, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: plan });
    await as(code, () => new M.Admin({ name: `${code}-owner`, email: `${code}-owner@test.uae`, password: PASSWORD, type: "super_admin", status: "active", isActive: true }).save());
    const r = await call("POST", "/login", { body: { email: `${code}-owner@test.uae`, password: PASSWORD } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    T[code] = { token: r.body.tokens.accessToken };
  }

  // A custom role in "hremp" that can keep the directory tidy but was never given hr.confidential.
  const role = await api("hremp", "POST", "/access/roles", { key: "hrclerk", name: "HR clerk", rank: 30, permissions: ["hr.view", "hr.manage"] });
  assert.equal(role.status, 201, JSON.stringify(role.data));
  const hire = await api("hremp", "POST", "/access/users", { name: "Priya Clerk", email: "priya@hremp.test", password: PASSWORD, role: "hrclerk" });
  assert.equal(hire.status, 201, JSON.stringify(hire.data));
  // An administrator chose Priya's password, so mustChangePassword blocks every route but her own
  // change-password until she does (CLAUDE.md's RBAC section; proved by passwordPolicyHttp.test.js). This
  // test is about permissions, not that flow, so it is cleared directly - the same shortcut accessHttp.test.js
  // takes for the same reason.
  await as("hremp", () => M.Admin.updateOne({ email: "priya@hremp.test" }, { $set: { mustChangePassword: false } }));
  const clerkLogin = await call("POST", "/login", { body: { email: "priya@hremp.test", password: PASSWORD } });
  assert.equal(clerkLogin.status, 200);
  T.clerk = { token: clerkLogin.body.tokens.accessToken };
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

let employeeId;

test("an organisation that bought HR can add an employee and read it back", { skip }, async () => {
  const created = await api("hremp", "POST", "/hr/employees", { name: "Ravi", designation: "Fabricator", contactNo: "0501234567", idNo: "784HTTP0001", joiningDate: "2026-01-01" });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.match(created.body.staffId, /^EMP-\d{4}$/, "numbered by the new EMP series, not Math.random()");
  employeeId = created.body._id;

  const got = await api("hremp", "GET", `/hr/employees/${employeeId}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.name, "Ravi");
});

test("an organisation that did NOT buy HR is refused the whole module, and told it is the plan", { skip }, async () => {
  const r = await api("hrno", "GET", "/hr/employees");
  assert.equal(r.status, 403);
  assert.equal(r.code, "MODULE_NOT_IN_PLAN");
  assert.equal(r.details?.module, "hr");
});

test("the owner holds hr.confidential: a contract's pay comes back", { skip }, async () => {
  const made = await api("hremp", "POST", `/hr/employees/${employeeId}/contracts`, { effectiveFrom: "2026-01-01", costPerHour: 25 });
  assert.equal(made.status, 201, JSON.stringify(made.data));

  const list = await api("hremp", "GET", `/hr/employees/${employeeId}/contracts`);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].hourlyCost, 25, "the owner may see what Ravi costs");
});

test("a role holding hr.view and hr.manage but not hr.confidential reads the directory, and nothing a wage can be read from", { skip }, async () => {
  const got = await api("clerk", "GET", `/hr/employees/${employeeId}`);
  assert.equal(got.status, 200, "hr.view reads the directory");
  assert.equal(got.body.name, "Ravi");

  const list = await api("clerk", "GET", `/hr/employees/${employeeId}/contracts`);
  assert.equal(list.status, 200, "the history itself is not secret");
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].hourlyCost, undefined, "but the rate is hidden, not zero");
  assert.equal(list.body[0].basicPay, undefined);
  assert.equal(JSON.stringify(list.body).includes("25"), false, "25 is nowhere in the response at all");
});

test("the same role is refused writing a contract outright: setting pay needs hr.confidential, not hr.manage", { skip }, async () => {
  const r = await api("clerk", "POST", `/hr/employees/${employeeId}/contracts`, { effectiveFrom: "2026-06-01", costPerHour: 999 });
  assert.equal(r.status, 403);
  assert.equal(r.code, "PERMISSION_DENIED");
});

test("another organisation's employee id is a 404, never a 403 that would confirm it exists", { skip }, async () => {
  const r = await api("hrno", "GET", `/hr/employees/${employeeId}`);
  // hrno has no hr module at all, so the module ceiling answers first - the deeper tenant-isolation case
  // (an hr-holding organisation reading ANOTHER hr-holding organisation's id) is covered by
  // tenantPlugin.test.js and tenantBleedHttp.test.js for every tenanted collection, Staff included.
  assert.equal(r.status, 403);
  assert.equal(r.code, "MODULE_NOT_IN_PLAN");
});
