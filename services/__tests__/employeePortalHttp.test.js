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

// The current password is a secret being guessed at, so the change-password door counts attempts exactly as
// the sign-in door does. Without this a stolen session could try passwords here for ever and then replace
// the real one - the same hole that was once open on the admin side. A fresh employee, so locking the
// account cannot disturb anything above.
test("a wrong current password is counted, and enough of them lock the account even for the right one", { skip }, async () => {
  const meera = await admin("POST", "/hr/employees", { name: "Meera Portal", designation: "Clerk", contactNo: "0503333333", idNo: "784EPORT0003", joiningDate: "2026-01-01" });
  assert.equal(meera.status, 201, JSON.stringify(meera.data));
  const phone = "+971509990003";
  await admin("POST", `/hr/employees/${meera.body._id}/portal`, { phone, password: "meerapass1" });

  const signedIn = await call("POST", "/employee/login", { body: { phone, password: "meerapass1" } });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.data));
  const token = signedIn.body.accessToken;

  for (let i = 0; i < 5; i++) {
    const wrong = await call("PUT", "/employee/change-password", { token, body: { currentPassword: `guess-${i}`, newPassword: "whatever1" } });
    assert.equal(wrong.status, 400, "a wrong guess is a 400, never a 401 - a 401 would read to the browser as 'your session ended'");
    assert.equal(wrong.code, "PASSWORD_INCORRECT");
  }

  const locked = await call("PUT", "/employee/change-password", { token, body: { currentPassword: "meerapass1", newPassword: "meerapass2" } });
  assert.equal(locked.status, 423, "locked even with the RIGHT current password - the attempt was counted before it was weighed");
  assert.equal(locked.code, "ACCOUNT_LOCKED");

  // The lock lives on the ACCOUNT, not on the door it was earned at: the sign-in door honours it too, so
  // somebody guessing at the change-password door cannot then go and try the same guesses at sign-in.
  // (That the refused call changed nothing is already proved above - the 423 is thrown before the new
  // password is ever assigned.)
  const atTheOtherDoor = await call("POST", "/employee/login", { body: { phone, password: "meerapass1" } });
  assert.equal(atTheOtherDoor.status, 423, "one lock, both doors - the right password waits too");
});

test("a non-string current password is a clean refusal, not a 500 out of bcrypt", { skip }, async () => {
  const sam = await admin("POST", "/hr/employees", { name: "Sam Portal", designation: "Clerk", contactNo: "0504444444", idNo: "784EPORT0004", joiningDate: "2026-01-01" });
  assert.equal(sam.status, 201, JSON.stringify(sam.data));
  const phone = "+971509990004";
  await admin("POST", `/hr/employees/${sam.body._id}/portal`, { phone, password: "sampass11" });
  const signedIn = await call("POST", "/employee/login", { body: { phone, password: "sampass11" } });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.data));

  for (const currentPassword of [{ $ne: null }, ["sampass11"], 12312312, null]) {
    const hostile = await call("PUT", "/employee/change-password", { token: signedIn.body.accessToken, body: { currentPassword, newPassword: "whatever1" } });
    assert.equal(hostile.status, 400, `a ${JSON.stringify(currentPassword)} current password must refuse, not throw`);
    assert.equal(hostile.code, "PASSWORD_INCORRECT");
  }

  // Untouched by any of it.
  const still = await call("POST", "/employee/login", { body: { phone, password: "sampass11" } });
  assert.equal(still.status, 200);
});

// The per-ACCOUNT lock above only ever protects one phone number at a time, so without a per-address limit
// one address could walk through every phone number in the country, each with its own fresh five-try
// budget. Its own server on its own port: the throttle is in memory per process, so a tiny limit here
// cannot disturb the buckets the tests above are using (they produce failed sign-ins of their own).
test("one address cannot walk through phone numbers for ever, and succeeding never counts against it", { skip, timeout: 90000 }, async () => {
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  const port = PORT + 500;
  const base = `http://127.0.0.1:${port}/api/v1`;
  let out = "";
  const tiny = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, MONGO_URI: uri, PORT: String(port), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0", EMPLOYEE_LOGIN_LIMIT: "3" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  tiny.stdout.on("data", (d) => (out += d));
  tiny.stderr.on("data", (d) => (out += d));
  const post = (url, body) => fetch(`${base}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }));

  try {
    const deadline = Date.now() + 60000;
    for (;;) {
      try { const h = await fetch(`${base}/health`); if (h.ok && (await h.json()).ready !== false) break; } catch (_) { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`second server did not start:\n${out.slice(-1500)}`);
      await new Promise((r) => setTimeout(r, 400));
    }

    // Sam's account still works and is not locked. Four SUCCESSFUL sign-ins, one more than the limit:
    // a portal is signed into from a shared tablet at the factory gate, so counting successes would refuse
    // the fourth worker of the morning. This is the property that makes failures-only the right tool.
    for (let i = 0; i < 4; i++) {
      const ok = await post("/employee/login", { phone: "+971509990004", password: "sampass11" });
      assert.equal(ok.status, 200, `successful sign-in ${i + 1} must never count against the address`);
    }

    // Now failures, at unknown numbers so no single account is being locked - this is the walk the
    // per-account lock cannot see.
    for (let i = 0; i < 3; i++) {
      const miss = await post("/employee/login", { phone: `+9715000001${i}`, password: "whatever1" });
      assert.equal(miss.status, 401, "an unknown phone is a plain refusal, and is counted");
    }

    const refused = await post("/employee/login", { phone: "+971500000199", password: "whatever1" });
    assert.equal(refused.status, 429, "the address is held off after its allowance of FAILED attempts");
    assert.equal(refused.data?.errorCode, "TOO_MANY_ATTEMPTS");

    // And it is the ADDRESS that is held off, not the account: a perfectly good credential is refused too.
    const goodOne = await post("/employee/login", { phone: "+971509990004", password: "sampass11" });
    assert.equal(goodOne.status, 429, "held off by address, so even a valid sign-in waits");
  } finally {
    tiny.kill();
  }
});
