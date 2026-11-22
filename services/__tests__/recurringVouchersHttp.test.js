// Recurring vouchers over HTTP: a real server, real logins. Proves who is let in, that a run makes a PENDING voucher nobody has posted,
// that the person who approves is judged as usual, and that hostile bodies are clean refusals.
//   node --require ./utils/testSetup.js --test services/__tests__/recurringVouchersHttp.test.js
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
let M;
const S = {};
let logs = "";

async function call(method, url, { body, token = S.token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
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
  M = {
    Admin: require("../../models/core/adminModel"),
    ActivityLog: require("../../models/modules/financial/activityLogModel"),
    ...require("../../models/modules/financial/financialModels"),
  };
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

const login = async (email) => (await call("POST", "/login", { body: { email, password: "12312312" }, token: null })).body.tokens.accessToken;
const ymd = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const body = (over = {}) => ({
  name: "Prepaid release", kind: "journal", frequency: "monthly", startDay: ymd(-1), narration: "One month",
  lines: [{ accountId: S.rent, debit: 100 }, { accountId: S.cash, credit: 100 }], ...over,
});

test("setup: a boss, a viewer, and the chart", { skip }, async () => {
  await new M.Admin({ name: "Boss", email: "boss@test.uae", password: "12312312", type: "super_admin", status: "active", isActive: true }).save();
  await new M.Admin({ name: "View", email: "view@test.uae", password: "12312312", type: "viewer", status: "active", isActive: true }).save();
  S.token = await login("boss@test.uae");
  S.viewer = await login("view@test.uae");
  await call("GET", "/accounting/chart");
  S.rent = String((await M.LedgerAccount.findOne({ accountName: "Rent Expense" }))._id);
  S.cash = String((await M.LedgerAccount.findOne({ accountName: "Cash in Hand" }))._id);
  assert.ok(S.rent && S.cash);
});

test("every route needs a login, and a viewer may read but not change", { skip }, async () => {
  for (const [method, url] of [["GET", "/recurring-vouchers"], ["POST", "/recurring-vouchers"], ["GET", "/recurring-vouchers/preview-dates"], ["POST", "/recurring-vouchers/x/run"]]) {
    assert.equal((await call(method, url, { token: null })).status, 401, `${method} ${url}`);
  }
  assert.equal((await call("GET", "/recurring-vouchers", { token: S.viewer })).status, 200, "a viewer holds finance.view");
  const denied = await call("POST", "/recurring-vouchers", { token: S.viewer, body: body() });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.errorCode, "PERMISSION_DENIED");
});

test("a template is created, audited and listed; bad bodies are clean refusals", { skip }, async () => {
  const bad = await call("POST", "/recurring-vouchers", { body: body({ lines: [{ accountId: S.rent, debit: 100 }, { accountId: S.cash, credit: 90 }] }) });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.errorCode, "UNBALANCED");
  for (const b of [{}, { name: { $ne: null } }, body({ kind: ["journal"] }), body({ lines: "x" }), body({ frequency: { $ne: "x" } }), body({ lines: [null, 5] })]) {
    const r = await call("POST", "/recurring-vouchers", { body: b });
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(b).slice(0, 60)} -> ${r.status}`);
  }
  const ok = await call("POST", "/recurring-vouchers", { body: body() });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  S.id = ok.body._id;
  assert.equal(ok.body.status, "ACTIVE");
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(await M.ActivityLog.findOne({ action: "RECURRING_VOUCHER_CREATED" }));
  const list = await call("GET", "/recurring-vouchers");
  assert.equal(list.body.length, 1);
  const prev = await call("GET", "/recurring-vouchers/preview-dates?frequency=monthly&startDay=2026-01-31&n=3");
  assert.deepEqual(prev.body.upcoming, ["2026-01-31", "2026-02-28", "2026-03-31"]);
});

test("Make next now makes a PENDING voucher with nothing posted, which then appears in the approvals list and posts when approved", { skip }, async () => {
  const run = await call("POST", `/recurring-vouchers/${S.id}/run`);
  assert.equal(run.status, 201, JSON.stringify(run.data));
  assert.equal(run.body.voucher.status, "pending");
  S.voucherId = run.body.voucher._id;
  assert.equal(await M.LedgerEntry.countDocuments({ voucherId: S.voucherId }), 0);
  const queue = await call("GET", "/approvals/waiting");
  assert.ok(JSON.stringify(queue.data).includes(run.body.voucher.voucherNo), "it is in the approvals list");
  const listed = await call("GET", "/vouchers/vouchers?recurring=1");
  assert.ok(listed.body.some((v) => v._id === S.voucherId));
  const denied = await call("PATCH", `/vouchers/vouchers/${S.voucherId}/approve`, { token: S.viewer, body: { action: "approve" } });
  assert.equal(denied.status, 403);
  const approved = await call("PATCH", `/vouchers/vouchers/${S.voucherId}/approve`, { body: { action: "approve" } });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(await M.LedgerEntry.countDocuments({ voucherId: S.voucherId }), 2);
});

test("pause, resume and delete follow the voucher keys; a forged reference in an edit is ignored", { skip }, async () => {
  assert.equal((await call("POST", `/recurring-vouchers/${S.id}/pause`, { token: S.viewer })).status, 403);
  assert.equal((await call("POST", `/recurring-vouchers/${S.id}/pause`)).body.status, "PAUSED");
  assert.equal((await call("POST", `/recurring-vouchers/${S.id}/pause`)).status, 409);
  assert.equal((await call("POST", `/recurring-vouchers/${S.id}/resume`)).status, 200);
  // an approved voucher is locked whatever is sent; a PENDING one can be edited, so that is where a forged reference could land
  const again = await call("POST", `/recurring-vouchers/${S.id}/run`);
  assert.equal(again.status, 201, JSON.stringify(again.data));
  const pendingId = again.body.voucher._id;
  const edit = await call("PUT", `/vouchers/vouchers/${pendingId}`, { body: { narration: "edited", recurringRef: { id: "64b64c0e8f1a2b3c4d5e6f70", name: "forged" } } });
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  const stored = await M.Voucher.findById(pendingId).lean();
  assert.equal(stored.narration, "edited", "the edit itself went through");
  assert.equal(stored.recurringRef.name, "Prepaid release", "the reference a template wrote is not overwritten by a body");
  assert.equal(String(stored.recurringRef.id), S.id);
  assert.equal((await call("DELETE", `/recurring-vouchers/${S.id}`, { token: S.viewer })).status, 403);
  assert.equal((await call("DELETE", `/recurring-vouchers/${S.id}`)).status, 204);
  assert.equal((await call("GET", `/recurring-vouchers/${S.id}`)).status, 404);
});
