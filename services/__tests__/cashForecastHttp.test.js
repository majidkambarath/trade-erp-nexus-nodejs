// The cash forecast over HTTP: a real server, real logins. Who may read it (the cash book's key, reports.financial), and clean refusals.
//   node --require ./utils/testSetup.js --test services/__tests__/cashForecastHttp.test.js
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

let child;
let Admin;
const S = {};
let logs = "";

async function call(method, url, { token = S.token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${url}`, { method, headers });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data };
}

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

const login = async (email) => (await call("POST", "/login", { token: null }).catch(() => null), (await fetch(`${BASE}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "12312312" }) }).then((r) => r.json())).data.tokens.accessToken);

test("setup: a boss, an operator, a viewer", { skip }, async () => {
  for (const [name, email, type] of [["Boss", "boss@test.uae", "super_admin"], ["Op", "op@test.uae", "operator"], ["View", "view@test.uae", "viewer"]]) {
    await new Admin({ name, email, password: "12312312", type, status: "active", isActive: true }).save();
  }
  S.token = await login("boss@test.uae");
  S.op = await login("op@test.uae");
  S.viewer = await login("view@test.uae");
  await call("GET", "/accounting/chart");
});

test("a login is needed, and a role without reports.financial is refused", { skip }, async () => {
  assert.equal((await call("GET", "/accounting/reports/cash-forecast", { token: null })).status, 401);
  const denied = await call("GET", "/accounting/reports/cash-forecast", { token: S.op });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.errorCode, "PERMISSION_DENIED");
});

test("a role that may read the cash book reads the forecast: 13 weeks, today's cash, no secrets of anyone", { skip }, async () => {
  for (const token of [S.token, S.viewer]) {
    const r = await call("GET", "/accounting/reports/cash-forecast", { token });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.body.weeks.length, 13);
    assert.equal(typeof r.body.opening, "number");
    assert.ok(Array.isArray(r.body.notes));
    assert.equal(JSON.stringify(r.data).includes("bankAccounts"), false);
  }
  assert.equal((await call("GET", "/accounting/reports/cash-forecast?weeks=4")).body.weeks.length, 4);
});

test("bad weeks are a clean 400, never a 500", { skip }, async () => {
  for (const q of ["weeks=0", "weeks=27", "weeks=abc", "weeks=2.5", "weeks=3&weeks=4", "weeks=-1"]) {
    const r = await call("GET", `/accounting/reports/cash-forecast?${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(r.data.errorCode, "INVALID_WEEKS", q);
  }
});
