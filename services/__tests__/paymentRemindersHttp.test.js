// Payment reminders over HTTP: a real server against a throwaway database and real logins. The service test proves the rules; this proves
// what only a request can: who is let in, that a reminder is checked again at the server, that a forged field cannot write the invoice's
// reminder summary, and that bad bodies are clean refusals.
//   node --require ./utils/testSetup.js --test services/__tests__/paymentRemindersHttp.test.js
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
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Stock: require("../../models/modules/stockModel"),
    Transaction: require("../../models/modules/transactionModel"),
    ActivityLog: require("../../models/modules/financial/activityLogModel"),
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

test("setup: a boss, a viewer, sending switched on, and an invoice seven days overdue", { skip }, async () => {
  await new M.Admin({ name: "Boss", email: "boss@test.uae", password: "12312312", type: "super_admin", status: "active", isActive: true, companyInfo: { companyName: "Harbour Trading LLC" } }).save();
  await new M.Admin({ name: "View", email: "view@test.uae", password: "12312312", type: "viewer", status: "active", isActive: true }).save();
  S.token = await login("boss@test.uae");
  S.viewer = await login("view@test.uae");
  await call("GET", "/accounting/chart");
  assert.equal((await call("PUT", "/messaging/settings", { body: { provider: "console", fromName: "Harbour", fromEmail: "accounts@harbour.ae", enabled: true } })).status, 200);

  S.customer = await M.Customer.create({ customerId: "C1", customerName: "Al Noor Trading", contactPerson: "Ali", email: "ali@alnoor.ae", phone: "050 111 2222", billingAddress: "Al Quoz" });
  const vendor = await M.Vendor.create({ vendorId: "V1", vendorName: "Vend", contactPerson: "x", address: "y" });
  const rice = await M.Stock.create({ itemId: "ITM1", sku: "SKU1", itemName: "Basmati Rice 5kg", category: new mongoose.Types.ObjectId() });
  const line = (qty, price) => ({ itemId: rice._id, description: "Basmati Rice 5kg", qty, price, rate: price, vatPercent: 5 });
  const buy = await call("POST", "/transactions/transactions", { body: { type: "purchase_order", partyId: vendor._id, partyType: "Vendor", items: [line(100, 10)] } });
  assert.equal((await call("PATCH", `/transactions/transactions/${buy.body._id}/process`, { body: { action: "approve" } })).status, 200);
  const so = await call("POST", "/transactions/transactions", { body: { type: "sales_order", partyId: S.customer._id, partyType: "Customer", items: [line(10, 20)], lastReminder: { step: "late999", at: new Date() } } });
  assert.equal(so.status, 201, JSON.stringify(so.data));
  assert.equal((await call("PATCH", `/transactions/transactions/${so.body._id}/process`, { body: { action: "approve" } })).status, 200);
  S.id = so.body._id;
  await M.Transaction.updateOne({ _id: S.id }, { $set: { date: new Date(`${ymd(-40)}T00:00:00.000Z`), dueDate: new Date(`${ymd(-7)}T00:00:00.000Z`) } });
});

test("a forged reminder summary in a body is never written to the invoice", { skip }, async () => {
  const doc = await M.Transaction.findById(S.id).lean();
  assert.equal(doc.lastReminder, undefined);
  const edit = await call("PUT", `/transactions/transactions/${S.id}`, { body: { notes: "x", lastReminder: { step: "late999" } } });
  assert.ok([200, 400, 409, 422].includes(edit.status), String(edit.status)); // an approved document refuses an edit; what matters is the next line
  assert.equal((await M.Transaction.findById(S.id).lean()).lastReminder, undefined);
});

test("every reminder route needs a login", { skip }, async () => {
  for (const [method, url] of [["GET", "/messaging/reminders/settings"], ["PUT", "/messaging/reminders/settings"], ["GET", "/messaging/reminders/due"], ["POST", "/messaging/reminders/send"]]) {
    assert.equal((await call(method, url, { token: null })).status, 401, `${method} ${url}`);
  }
});

test("a viewer can neither read the list, send, nor change the rules", { skip }, async () => {
  for (const [method, url, body] of [["GET", "/messaging/reminders/settings"], ["GET", "/messaging/reminders/due"], ["POST", "/messaging/reminders/send", { items: [] }], ["PUT", "/messaging/reminders/settings", { mode: "review" }]]) {
    const r = await call(method, url, { token: S.viewer, body });
    assert.equal(r.status, 403, `${method} ${url}`);
    assert.equal(r.data.errorCode, "PERMISSION_DENIED");
  }
});

test("off by default; the rules are validated and every change is audited", { skip }, async () => {
  const first = await call("GET", "/messaging/reminders/settings");
  assert.equal(first.body.mode, "off");
  assert.deepEqual(first.body.steps, [-3, 0, 7, 14, 30]);
  const bad = await call("PUT", "/messaging/reminders/settings", { body: { steps: [1.5] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.errorCode, "INVALID_REMINDER_SETTINGS");
  const put = await call("PUT", "/messaging/reminders/settings", { body: { mode: "review", steps: [7, 0], sendHour: 9, catchUpDays: 7 } });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.deepEqual(put.body.steps, [0, 7]);
  await new Promise((r) => setTimeout(r, 300));
  const audit = await M.ActivityLog.findOne({ action: "PAYMENT_REMINDER_SETTINGS_CHANGED" }).lean();
  assert.match(audit.summary, /off -> review/);
  // the Sending form's own save does not disturb them
  await call("PUT", "/messaging/settings", { body: { signature: "Thanks" } });
  assert.equal((await call("GET", "/messaging/reminders/settings")).body.mode, "review");
});

test("the list names the overdue invoice, with no secret of the customer's in it", { skip }, async () => {
  const r = await call("GET", "/messaging/reminders/due");
  assert.equal(r.status, 200);
  const row = r.body.rows.find((x) => x.invoiceId === S.id);
  assert.ok(row);
  assert.equal(row.step, 7);
  assert.equal(row.to, "ali@alnoor.ae");
  assert.ok(r.body.allowance.room > 0);
  assert.equal(JSON.stringify(r.data).includes("bankAccounts"), false);
});

test("a send is checked again at the server, goes once, and says it was recorded only", { skip }, async () => {
  const wrong = await call("POST", "/messaging/reminders/send", { body: { items: [{ invoiceId: S.id, step: 30 }] } });
  assert.equal(wrong.status, 200);
  assert.equal(wrong.body.sent.length, 0);
  assert.equal(wrong.body.skipped[0].reason, "NOT_DUE");
  const ok = await call("POST", "/messaging/reminders/send", { body: { items: [{ invoiceId: S.id, step: 7 }] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.body.sent.length, 1);
  assert.equal(ok.body.sent[0].recordedOnly, true);
  const again = await call("POST", "/messaging/reminders/send", { body: { items: [{ invoiceId: S.id, step: 7 }] } });
  assert.equal(again.body.sent.length, 0);
  const doc = await M.Transaction.findById(S.id).lean();
  assert.equal(doc.lastReminder.step, "late7");
  assert.equal(doc.lastSend, undefined);
  const history = await call("GET", `/messaging/sends?purpose=reminder&sourceId=${S.id}`);
  assert.equal(history.body.rows.length, 1);
  assert.equal(history.body.rows[0].purpose, "reminder");
});

test("hostile or oversized bodies are refused or ignored cleanly, never a 500", { skip }, async () => {
  for (const body of [{}, { items: "x" }, { items: [{ invoiceId: { $ne: null }, step: 7 }] }, { items: [null, 5, "a"] }, { items: Array.from({ length: 500 }, () => ({ invoiceId: S.id, step: 7 })) }]) {
    const r = await call("POST", "/messaging/reminders/send", { body });
    assert.ok(r.status < 500, `${JSON.stringify(body).slice(0, 60)} -> ${r.status}`);
  }
  for (const body of [{ mode: { $ne: "off" } }, { steps: "7" }, { sendHour: "x" }, { catchUpDays: [] }]) {
    const r = await call("PUT", "/messaging/reminders/settings", { body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});
