// Closing a month over HTTP: a real server process against a throwaway database, real login and tokens. The service-level
// behaviour is in periodClose.test.js; this is routing, permissions (accounts.close for everything but the list), the
// response envelope, the refusal a posting gets inside a closed month, the audit rows and the stock-versus-ledger route.
//
// The year is 2096, far enough ahead that none of its months has "ended" whichever day this runs.
//
//   npm test           (runs with the rest)
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
let logs = "";
const S = {};

async function call(method, url, { body, token = S.boss } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data };
}

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  assert.ok(uri.includes(DB), "could not point the server at the throwaway database");
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));

  await mongoose.connect(uri);
  const Admin = require("../../models/core/adminModel");
  await mongoose.connection.syncIndexes();

  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      const h = await fetch(`${BASE}/health`);
      if (h.ok && (await h.json()).ready !== false) break;
    } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  for (const [name, type] of [["Boss", "super_admin"], ["Viewer", "viewer"], ["Operator", "operator"]]) {
    await new Admin({ name, email: `${name.toLowerCase()}@test.uae`, password: "12312312", type, status: "active", isActive: true }).save();
    const r = await call("POST", "/login", { body: { email: `${name.toLowerCase()}@test.uae`, password: "12312312" }, token: null });
    S[name.toLowerCase()] = r.body.tokens.accessToken;
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

const journal = (date, amount = 100) =>
  call("POST", "/vouchers/vouchers", { body: { voucherType: "journal", date, narration: "test", lines: [{ accountId: S.cash, debit: amount }, { accountId: S.capital, credit: amount }] } });
const months = (token) => call("GET", `/accounting/fiscal-years/${S.fy}/months`, { token });

test("set-up: the chart opens, a year is added, and January and February have postings", { skip }, async () => {
  assert.equal((await call("GET", "/accounting/chart")).status, 200);
  const fy = await call("POST", "/accounting/fiscal-years", { body: { code: "2096", startDate: "2096-01-01", endDate: "2096-12-31" } });
  assert.equal(fy.status, 201);
  S.fy = fy.body._id;
  const postable = (await call("GET", "/accounting/accounts/postable")).body;
  S.cash = postable.find((a) => a.accountName === "Cash in Hand")._id;
  S.capital = postable.find((a) => a.accountName === "Owner's Capital")._id;
  assert.equal((await journal("2096-01-10")).status, 201);
  assert.equal((await journal("2096-02-05")).status, 201);
});

test("the months of a year are listed to anyone who can see the years, and to nobody else", { skip }, async () => {
  assert.equal((await months(null)).status, 401);
  const r = await months();
  assert.equal(r.status, 200);
  assert.equal(r.body.months.length, 12);
  assert.deepEqual(r.body.months.filter((m) => m.canClose).map((m) => m.key), ["2096-01"]);
  assert.deepEqual([r.body.year.startDay, r.body.year.endDay], ["2096-01-01", "2096-12-31"]);
  assert.equal((await months(S.viewer)).status, 200, "looking is open to a viewer");

  const list = await call("GET", "/accounting/fiscal-years");
  assert.equal(list.body[0].months.length, 12, "the year list carries them too");
  assert.equal((await call("GET", `/accounting/fiscal-years/${S.fy}/months/2097-01`)).data.errorCode, "MONTH_NOT_FOUND");
  assert.equal((await call("GET", "/accounting/fiscal-years/not-an-id/months")).status, 404);
});

test("reading what closing would do, closing and reopening all need accounts.close", { skip }, async () => {
  for (const token of [S.viewer, S.operator]) {
    assert.equal((await call("GET", `/accounting/fiscal-years/${S.fy}/months/2096-01`, { token })).status, 403);
    assert.equal((await call("POST", `/accounting/fiscal-years/${S.fy}/months/2096-01/close`, { token, body: { acknowledge: ["MONTH_NOT_ENDED"] } })).status, 403);
    assert.equal((await call("POST", `/accounting/fiscal-years/${S.fy}/months/2096-01/reopen`, { token })).status, 403);
  }
  assert.equal((await call("GET", `/accounting/fiscal-years/${S.fy}/months/2096-01`, { token: null })).status, 401);
  assert.equal((await months()).body.year.lockedThrough, null, "the refusals changed nothing");
});

test("a month that has not ended is closed only by someone who says so; months go in order", { skip }, async () => {
  const pre = await call("GET", `/accounting/fiscal-years/${S.fy}/months/2096-01`);
  assert.equal(pre.status, 200);
  assert.equal(pre.body.canClose, true, JSON.stringify(pre.body.blockers));
  assert.deepEqual(pre.body.warnings.map((w) => w.code), ["MONTH_NOT_ENDED"]);
  assert.equal(pre.body.month.label, "January 2096");
  assert.equal(pre.body.reopen.canReopen, false);

  const unsaid = await call("POST", `/accounting/fiscal-years/${S.fy}/months/2096-01/close`);
  assert.equal(unsaid.status, 409);
  assert.equal(unsaid.data.errorCode, "MONTH_CLOSE_WARNINGS");
  const order = await call("POST", `/accounting/fiscal-years/${S.fy}/months/2096-03/close`, { body: { acknowledge: ["MONTH_NOT_ENDED"] } });
  assert.equal(order.status, 409);
  assert.equal(order.data.errorCode, "MONTH_CLOSE_BLOCKED");
  assert.match(order.data.message, /Close January 2096 first/);
  assert.equal((await months()).body.year.lockedThrough, null);
});

test("closing January locks it for postings, and the refusal names the day", { skip }, async () => {
  const closed = await call("POST", `/accounting/fiscal-years/${S.fy}/months/2096-01/close`, { body: { acknowledge: ["MONTH_NOT_ENDED"] } });
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal(closed.body.closedNow, true);
  assert.equal(closed.body.year.lockedThrough, "2096-01-31");
  assert.equal(closed.body.months[0].status, "closed");
  assert.deepEqual(closed.body.months.filter((m) => m.canClose || m.canReopen).map((m) => [m.key, m.canClose, m.canReopen]), [["2096-01", false, true], ["2096-02", true, false]]);

  const refused = await journal("2096-01-20");
  assert.equal(refused.status, 422);
  assert.equal(refused.data.errorCode, "PERIOD_CLOSED");
  assert.equal(refused.data.message, "Posting is closed up to 31 Jan 2096");
  assert.equal((await journal("2096-02-10")).status, 201, "February is open");

  const again = await call("POST", `/accounting/fiscal-years/${S.fy}/months/2096-01/close`, { body: { acknowledge: ["MONTH_NOT_ENDED"] } });
  assert.equal(again.data.errorCode, "ALREADY_CLOSED");
});

test("the audit log has a row for the month, and the list shows how far the year is closed", { skip }, async () => {
  const log = await call("GET", "/accounting/audit-log?action=PERIOD_MONTH_CLOSED");
  assert.equal(log.status, 200);
  const rows = log.body.rows || log.body;
  assert.equal(rows.length, 1);
  assert.match(rows[0].summary, /January 2096 closed \(2096\); posting is closed up to 31 Jan 2096/);
  assert.equal((await call("GET", "/accounting/fiscal-years")).body[0].lockedThrough, "2096-01-31");
});

test("reopening needs the right order and puts the day back", { skip }, async () => {
  await call("POST", `/accounting/fiscal-years/${S.fy}/months/2096-02/close`, { body: { acknowledge: ["MONTH_NOT_ENDED"] } });
  const blocked = await call("POST", `/accounting/fiscal-years/${S.fy}/months/2096-01/reopen`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.errorCode, "MONTH_REOPEN_BLOCKED");
  assert.match(blocked.data.message, /Reopen February 2096 first/);

  const feb = await call("POST", `/accounting/fiscal-years/${S.fy}/months/2096-02/reopen`);
  assert.equal(feb.status, 200, JSON.stringify(feb.data));
  assert.equal(feb.body.year.lockedThrough, "2096-01-31");
  const jan = await call("POST", `/accounting/fiscal-years/${S.fy}/months/2096-01/reopen`);
  assert.equal(jan.body.year.lockedThrough, null);
  assert.equal((await journal("2096-01-20")).status, 201, "January takes postings again");
  assert.equal((await call("POST", `/accounting/fiscal-years/${S.fy}/months/2096-01/reopen`)).data.errorCode, "NOT_CLOSED");
  assert.ok((await call("GET", "/accounting/audit-log?action=PERIOD_MONTH_REOPENED")).body.rows.length >= 2);
});

test("stock against the ledger as at a day is a report anyone with reports.view may read", { skip }, async () => {
  const r = await call("GET", "/stock-reports/ledger-check?asOn=2096-01-31", { token: S.viewer });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.body.asOn, "2096-01-31");
  assert.equal(r.body.reconciles, true, "no stock and nothing on the Inventory account");
  assert.ok(["today", "history"].includes(r.body.basis));
  assert.equal(typeof r.body.note, "string");
  assert.equal((await call("GET", "/stock-reports/ledger-check", { token: null })).status, 401);
  assert.equal((await call("GET", "/stock-reports/ledger-check?asOn=not-a-date")).status >= 400, true, "a nonsense date is refused, not guessed");
});
