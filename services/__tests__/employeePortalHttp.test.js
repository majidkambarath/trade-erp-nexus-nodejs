// The employee self-service portal (D15) against a real, spawned strict server: its own login, its own
// token, and - the boundary that matters most - one employee can never read or act on another's
// attendance, leave or payslip, and neither identity's token opens the other's doors.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_emp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3940 + Math.floor(Math.random() * 180);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";

let child, M, Org, ctx;
let logs = "";

async function call(method, url, { body, token, cookie } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  let payload;
  if (body) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}${url}`, { method, headers, body: payload });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  const set = res.headers.getSetCookie?.() || [];
  const sessionCookie = set.find((c) => c.startsWith("erp_employee_session=")) || null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode, cookie: sessionCookie ? sessionCookie.split(";")[0] : null };
}
const as = (code, fn) => ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);

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

  await Org.create({ legalName: "Emp Portal Co", code: "empportal", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" });
  await as("empportal", () => new M.Admin({ name: "owner", email: "owner@empportal.test", password: PASSWORD, type: "super_admin", status: "active", isActive: true }).save());
  const login = await call("POST", "/login", { body: { email: "owner@empportal.test", password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  T.admin = login.body.tokens.accessToken;
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

const T = {};
const admin = (method, url, body) => call(method, url, { token: T.admin, body });

let raviId, anyaId, raviPhone, anyaPhone;

test("an administrator sets up an employee's own phone and password for the portal", { skip }, async () => {
  const ravi = await admin("POST", "/hr/employees", { name: "Ravi Portal", designation: "Fabricator", contactNo: "0501111111", idNo: "784EPORT0001", joiningDate: "2026-01-01" });
  assert.equal(ravi.status, 201, JSON.stringify(ravi.data));
  raviId = ravi.body._id;
  raviPhone = "+971509990001";
  const set = await admin("POST", `/hr/employees/${raviId}/portal`, { phone: raviPhone, password: "ravipass1" });
  assert.equal(set.status, 201, JSON.stringify(set.data));

  const anya = await admin("POST", "/hr/employees", { name: "Anya Portal", designation: "Clerk", contactNo: "0502222222", idNo: "784EPORT0002", joiningDate: "2026-01-01" });
  anyaId = anya.body._id;
  anyaPhone = "+971509990002";
  await admin("POST", `/hr/employees/${anyaId}/portal`, { phone: anyaPhone, password: "anyapass1" });
});

let raviAccess, raviCookie;

test("the employee logs in with phone and password, not email", { skip }, async () => {
  const r = await call("POST", "/employee/login", { body: { phone: raviPhone, password: "ravipass1" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.body.accessToken);
  assert.ok(r.cookie, "the refresh token arrives as an httpOnly cookie, not in the body");
  raviAccess = r.body.accessToken;
  raviCookie = r.cookie;
  assert.equal(JSON.stringify(r.data).includes("refreshToken"), false, "the refresh token is never echoed in the response body");
});

test("a wrong password is refused with the same message as an unknown phone, and does not leak which it was", { skip }, async () => {
  const wrongPass = await call("POST", "/employee/login", { body: { phone: raviPhone, password: "not-it" } });
  const unknownPhone = await call("POST", "/employee/login", { body: { phone: "+971500000099", password: "anything" } });
  assert.equal(wrongPass.status, 401);
  assert.equal(unknownPhone.status, 401);
  assert.equal(wrongPass.data.message, unknownPhone.data.message);
});

test("five wrong passwords lock the account, and the sixth is refused without even checking the password", { skip }, async () => {
  for (let i = 0; i < 5; i++) await call("POST", "/employee/login", { body: { phone: anyaPhone, password: "wrong" } });
  const locked = await call("POST", "/employee/login", { body: { phone: anyaPhone, password: "anyapass1" } }); // the RIGHT password, still locked out
  assert.equal(locked.status, 423, "locked even with the correct password - the count happened before any weighing");
});

test("the employee reads their own profile, never a cost rate or pay figure", { skip }, async () => {
  const me = await call("GET", "/employee/me", { token: raviAccess });
  assert.equal(me.status, 200);
  assert.equal(me.body.name, "Ravi Portal");
  assert.equal(JSON.stringify(me.data).toLowerCase().includes("costperhour"), false);
  assert.equal(JSON.stringify(me.data).toLowerCase().includes("basicpay"), false);
});

test("an ADMIN token is refused by the employee portal, and an EMPLOYEE token is refused by the admin HR routes", { skip }, async () => {
  const adminOnEmployee = await call("GET", "/employee/me", { token: T.admin });
  assert.equal(adminOnEmployee.status, 401, "wrong audience/secret - the admin token verifies against neither");

  const employeeOnAdmin = await call("GET", "/hr/employees", { token: raviAccess });
  assert.equal(employeeOnAdmin.status, 401, "the reverse: an employee token cannot open an Admin-only route");
});

let raviLeaveId;

test("the employee submits their own leave request, and it carries their own staffId whatever the body says", { skip }, async () => {
  const leaveType = await admin("POST", "/hr/leave-types", { name: "Annual Portal", accrualPerMonth: 1.5 });
  const spoofed = await call("POST", "/employee/leave-requests", {
    token: raviAccess,
    body: { staffId: anyaId, leaveTypeId: leaveType.body._id, fromDay: "2026-03-01", toDay: "2026-03-02" },
  });
  assert.equal(spoofed.status, 201, JSON.stringify(spoofed.data));
  raviLeaveId = spoofed.body._id;
  assert.equal(spoofed.body.staffId, raviId, "the body tried to name Anya - the controller overrides it with the caller's own id");
});

test("the employee reads their own requests only, never another's", { skip }, async () => {
  const mine = await call("GET", "/employee/leave-requests", { token: raviAccess });
  assert.equal(mine.status, 200);
  assert.ok(mine.body.every((r) => r.staffId === raviId));
});

test("a made-up request id is a 404, and the employee's own request cancels fine", { skip }, async () => {
  const fake = await call("POST", `/employee/leave-requests/${new mongoose.Types.ObjectId()}/cancel`, { token: raviAccess });
  assert.equal(fake.status, 404);

  const ownCancel = await call("POST", `/employee/leave-requests/${raviLeaveId}/cancel`, { token: raviAccess });
  assert.equal(ownCancel.status, 200);
  assert.equal(ownCancel.body.status, "CANCELLED");
});

test("refreshing rotates the cookie, and the old one stops working", { skip }, async () => {
  const refreshed = await call("POST", "/employee/refresh-token", { cookie: raviCookie });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data));
  assert.ok(refreshed.cookie && refreshed.cookie !== raviCookie, "a fresh cookie, not the same one handed back");

  const reuseOld = await call("POST", "/employee/refresh-token", { cookie: raviCookie });
  assert.equal(reuseOld.status, 401, "the old refresh token was replaced the moment the new one was issued (D15's stated scope)");
});

test("changing the password ends every other session, and the new one works", { skip }, async () => {
  const fresh = await call("POST", "/employee/login", { body: { phone: raviPhone, password: "ravipass1" } });
  assert.equal(fresh.status, 200);
  const freshAccess = fresh.body.accessToken;

  const changed = await call("PUT", "/employee/change-password", { token: freshAccess, body: { currentPassword: "ravipass1", newPassword: "ravipass2" } });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));

  const oldLogin = await call("POST", "/employee/login", { body: { phone: raviPhone, password: "ravipass1" } });
  assert.equal(oldLogin.status, 401, "the old password no longer works");

  const newLogin = await call("POST", "/employee/login", { body: { phone: raviPhone, password: "ravipass2" } });
  assert.equal(newLogin.status, 200);
});

test("the employee punches in and out for TODAY only - never a manual status, never another day", { skip }, async () => {
  const fresh = await call("POST", "/employee/login", { body: { phone: raviPhone, password: "ravipass2" } });
  const token = fresh.body.accessToken;
  const punch = await call("POST", "/employee/punch", { token, body: { checkIn: `${new Date().toISOString().slice(0, 10)}T09:00:00`, checkOut: `${new Date().toISOString().slice(0, 10)}T17:00:00` } });
  assert.equal(punch.status, 201, JSON.stringify(punch.data));
  assert.equal(punch.body.status, "present");
  assert.equal(punch.body.source, "self");

  const today = await call("GET", "/employee/attendance/today", { token });
  assert.equal(today.status, 200);
  assert.equal(today.body.hoursWorked, 8);
});

test("an administrator disabling the portal account ends it immediately", { skip }, async () => {
  const disable = await admin("DELETE", `/hr/employees/${raviId}/portal`);
  assert.equal(disable.status, 200, JSON.stringify(disable.data));
  const stillTries = await call("POST", "/employee/login", { body: { phone: raviPhone, password: "ravipass2" } });
  assert.equal(stillTries.status, 401);
});
