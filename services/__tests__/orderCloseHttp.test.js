// Closing a sales order short over HTTP: a real server process against a throwaway database, real login.
// The service tests call the code directly; this proves what only a request can - that the routes are
// reachable and authenticated, answer in the { success, data } envelope, report a refusal with a status
// and errorCode, hide the copy kept for reopening, and leave the audit trail and the deal view saying so.
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
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
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
  M = {
    Admin: require("../../models/core/adminModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Stock: require("../../models/modules/stockModel"),
  };
  await mongoose.connection.syncIndexes();
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      { const h = await fetch(`${BASE}/health`); if (h.ok && (await h.json()).ready !== false) break; }
    } catch (_) { /* not up yet */ }
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


test("setup: an admin, a customer, stock on hand", { skip }, async () => {
  await new M.Admin({ name: "Boss", email: "boss@test.uae", password: "12312312", type: "super_admin", status: "active", isActive: true }).save();
  const login = await call("POST", "/login", { body: { email: "boss@test.uae", password: "12312312" }, token: null });
  assert.equal(login.status, 200);
  S.token = login.body.tokens.accessToken;
  await call("GET", "/accounting/chart"); // opens the chart: posting on, accounts mapped

  S.customer = await M.Customer.create({ customerId: "C1", customerName: "Cust", contactPerson: "Ali", shippingAddress: "Al Quoz" });
  S.vendor = await M.Vendor.create({ vendorId: "V1", vendorName: "Vend", contactPerson: "x", address: "y" });
  S.rice = await M.Stock.create({ itemId: "ITM1", sku: "SKU1", itemName: "Rice", category: new mongoose.Types.ObjectId() });
  const buy = await call("POST", "/transactions/transactions", {
    body: { type: "purchase_order", partyId: S.vendor._id, partyType: "Vendor", items: [{ itemId: S.rice._id, description: "Rice", qty: 100, price: 10, rate: 10, vatPercent: 5 }] },
  });
  assert.equal(buy.status, 201, JSON.stringify(buy.data));
  assert.equal((await call("PATCH", `/transactions/transactions/${buy.body._id}/process`, { body: { action: "approve" } })).status, 200);
});

const line = (qty) => ({ itemId: S.rice._id, description: "Rice", qty, price: 20, rate: 20, vatPercent: 5 });

test("every route needs a login", { skip }, async () => {
  const id = "64b000000000000000000001";
  assert.equal((await call("GET", `/transactions/transactions/${id}/close-short`, { token: null })).status, 401);
  assert.equal((await call("POST", `/transactions/transactions/${id}/close-short`, { token: null, body: { reason: "x" } })).status, 401);
  assert.equal((await call("POST", `/transactions/transactions/${id}/reopen-short`, { token: null })).status, 401);
});

test("a part-delivered draft order: preview, refuse without a reason, close, and the trail says so", { skip }, async () => {
  const made = await call("POST", "/transactions/transactions", { body: { type: "sales_order", partyId: S.customer._id, partyType: "Customer", items: [line(10)] } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  S.order = made.body;
  const lineId = S.order.items[0]._id;
  const note = await call("POST", "/delivery-notes", { body: { sourceTransactionId: S.order._id, items: [{ sourceLineId: lineId, qty: 6 }] } });
  assert.equal(note.status, 201, JSON.stringify(note.data));
  await call("POST", `/delivery-notes/${note.body._id}/dispatch`, { body: {} });
  assert.equal((await call("POST", `/delivery-notes/${note.body._id}/deliver`, { body: { receivedBy: "Store" } })).status, 200);

  const preview = await call("GET", `/transactions/transactions/${S.order._id}/close-short`);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.success, true);
  assert.equal(preview.body.mode, "trim");
  assert.equal(preview.body.lines[0].short, 4);
  assert.equal(preview.body.order.totalAmount, 210);
  assert.equal(preview.body.newTotal, 126);
  assert.equal(preview.body.valueShort, 84);

  const noReason = await call("POST", `/transactions/transactions/${S.order._id}/close-short`, { body: {} });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.data.success, false);
  assert.equal(noReason.data.errorCode, "REASON_REQUIRED");

  const closed = await call("POST", `/transactions/transactions/${S.order._id}/close-short`, { body: { reason: "Customer bought elsewhere" } });
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal(closed.data.success, true);
  assert.equal(closed.body.totalAmount, 126);
  assert.equal(closed.body.closedShort.reason, "Customer bought elsewhere");
  assert.equal(closed.body.closedShort.trimmed, true);
  assert.equal(closed.body.closedShort.original, undefined, "the copy kept for reopening is not sent back");
  assert.equal(JSON.stringify(closed.data).includes("original"), false);

  const again = await call("POST", `/transactions/transactions/${S.order._id}/close-short`, { body: { reason: "Again" } });
  assert.equal(again.status, 409);
  assert.equal(again.data.errorCode, "ALREADY_CLOSED_SHORT");
  const more = await call("POST", "/delivery-notes", { body: { sourceTransactionId: S.order._id, items: [{ sourceLineId: lineId, qty: 1 }] } });
  assert.equal(more.status, 409);
  assert.equal(more.data.errorCode, "ORDER_CLOSED_SHORT");

  const one = await call("GET", `/transactions/transactions/${S.order._id}`);
  assert.equal(one.body.transaction.closedShort.original, undefined, "ordinary reads leave it out too");
  const listed = await call("GET", "/transactions/transactions?type=sales_order&limit=50");
  const listedRow = listed.body.find((t) => t._id === S.order._id);
  assert.equal(listedRow.closedShort.reason, "Customer bought elsewhere", "the list says the order was closed short");
  assert.equal(listedRow.closedShort.original, undefined, "but does not carry the copy kept for reopening");

  // the audit trail names who, what fell short and why
  const trail = await call("GET", `/transactions/transactions/${S.order._id}/audit`);
  const row = trail.body.activity.find((r) => r.action === "TRANSACTION_CLOSED_SHORT");
  assert.ok(row, "the closing is in the activity log");
  assert.match(row.summary, /4 x Rice not delivered/);
  assert.match(row.summary, /Customer bought elsewhere/);
  assert.equal(row.username, "boss@test.uae");

  // the deal on the customer profile reads it
  const flow = await call("GET", `/document-flow/customer/${S.customer._id}`);
  assert.equal(flow.status, 200, JSON.stringify(flow.data));
  const deal = flow.body.chains.find((c) => c.order && c.order._id === S.order._id);
  assert.equal(deal.stage, "delivered");
  assert.equal(deal.delivery.complete, true);
  assert.equal(deal.closeShort.reason, "Customer bought elsewhere");
});

test("reopening over HTTP puts the order back and is logged", { skip }, async () => {
  const back = await call("POST", `/transactions/transactions/${S.order._id}/reopen-short`);
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(back.body.totalAmount, 210);
  assert.equal(back.body.closedShort, undefined);
  const twice = await call("POST", `/transactions/transactions/${S.order._id}/reopen-short`);
  assert.equal(twice.status, 409);
  assert.equal(twice.data.errorCode, "NOT_CLOSED_SHORT");
  const trail = await call("GET", `/transactions/transactions/${S.order._id}/audit`);
  assert.ok(trail.body.activity.some((r) => r.action === "TRANSACTION_REOPENED"));
  assert.equal((await call("GET", `/transactions/transactions/${new mongoose.Types.ObjectId()}/close-short`)).status, 404);
});
