// Quotations and delivery notes over HTTP: a real server process against a throwaway database, real
// login. The service tests call the code directly; this proves what only a request can - that the
// routes are reachable (mounted before adminRouter's bare GET /:id), authenticated, answer in the
// { success, data } envelope, report errors with a status and errorCode, and leave an audit trail.
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

const day = (n) => {
  const d = new Date(Date.now() + 4 * 3600000 + n * 86400000); // Dubai
  return d.toISOString().slice(0, 10);
};

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

test("every route needs a login, and the fixed paths are not mistaken for an id", { skip }, async () => {
  for (const url of ["/quotations", "/quotations/summary", "/delivery-notes", "/delivery-notes/summary", "/delivery-notes/uninvoiced"]) {
    assert.equal((await call("GET", url, { token: null })).status, 401, url);
  }
  // adminRouter's bare GET /:id would swallow these if they were mounted after it
  const summary = await call("GET", "/quotations/summary");
  assert.equal(summary.status, 200);
  assert.deepEqual(Object.keys(summary.body).sort(), ["byStatus", "expiringSoon", "total", "winRate"]);
  const list = await call("GET", "/quotations");
  assert.equal(list.status, 200);
  assert.equal(list.data.success, true);
  assert.ok(Array.isArray(list.body));
  assert.ok(list.data.pagination);
  assert.equal((await call("GET", "/delivery-notes/uninvoiced")).status, 200);
  assert.equal((await call("GET", "/delivery-notes/availability?itemIds=" + S.rice._id)).body[0].onHand, 100);
});

test("errors carry a status and a code the client can act on", { skip }, async () => {
  const empty = await call("POST", "/quotations", { body: { partyId: String(S.customer._id), items: [] } });
  assert.equal(empty.status, 400);
  assert.equal(empty.data.success, false);
  assert.equal(empty.data.errorCode, "ITEMS_REQUIRED");

  assert.equal((await call("GET", "/quotations/not-an-id")).status, 400);
  assert.equal((await call("GET", `/quotations/${new mongoose.Types.ObjectId()}`)).data.errorCode, "QUOTATION_NOT_FOUND");
  assert.equal((await call("GET", `/delivery-notes/${new mongoose.Types.ObjectId()}`)).status, 404);

  const q = await call("POST", "/quotations", { body: { partyId: String(S.customer._id), items: [{ itemId: String(S.rice._id), qty: 2, price: 20, vatPercent: 5 }] } });
  assert.equal(q.status, 201);
  const early = await call("POST", `/quotations/${q.body._id}/accept`, { body: {} });
  assert.equal(early.status, 409);
  assert.equal(early.data.errorCode, "QUOTATION_STATE");
});

test("quotation over HTTP: save, send, accept, convert; the order and the offer both leave an audit trail", { skip }, async () => {
  const created = await call("POST", "/quotations", {
    body: { partyId: String(S.customer._id), validUntil: day(14), reference: "RFQ-1", items: [{ itemId: String(S.rice._id), qty: 10, price: 20, vatPercent: 5, discountPercent: 10 }] },
  });
  assert.equal(created.status, 201);
  S.q = created.body;
  assert.match(S.q.quotationNo, /^QT-\d{4}-\d{4}$/);
  assert.equal(S.q.totalAmount, 189); // 200 - 10% = 180, + 5%
  assert.equal(S.q.actions.send, true);
  assert.equal(S.q.actions.convert, false);

  const fetched = await call("GET", `/quotations/${S.q._id}`);
  assert.equal(fetched.body.party.customerName, "Cust");
  assert.equal(fetched.body.items[0].stockDetails.itemName, "Rice");

  const upd = await call("PUT", `/quotations/${S.q._id}`, { body: { terms: "Payment on delivery" } });
  assert.equal(upd.body.terms, "Payment on delivery");

  assert.equal((await call("POST", `/quotations/${S.q._id}/send`, { body: {} })).body.status, "SENT");
  assert.equal((await call("PUT", `/quotations/${S.q._id}`, { body: { notes: "x" } })).data.errorCode, "QUOTATION_NOT_EDITABLE");
  assert.equal((await call("POST", `/quotations/${S.q._id}/accept`, { body: { acceptedBy: "Ali" } })).body.status, "ACCEPTED");

  const conv = await call("POST", `/quotations/${S.q._id}/convert`, { body: {} });
  assert.equal(conv.status, 201, JSON.stringify(conv.data));
  assert.equal(conv.body.quotation.status, "CONVERTED");
  assert.equal(conv.body.salesOrder.status, "DRAFT");
  assert.equal(conv.body.salesOrder.quoteRef, S.q.quotationNo);
  assert.equal(conv.body.salesOrder.totalAmount, 189);
  S.order = conv.body.salesOrder;

  // the new order is a normal draft sales order to the rest of the app
  const asOrder = await call("GET", `/transactions/transactions?type=sales_order&status=DRAFT`);
  assert.ok(asOrder.body.some((t) => t._id === S.order._id));
  const trail = await call("GET", `/transactions/transactions/${S.order._id}/audit`);
  assert.equal(trail.status, 200);
  assert.ok(JSON.stringify(trail.data).includes(S.q.quotationNo), "the order's own trail says where it came from");

  const activity = await call("GET", `/quotations/${S.q._id}/activity`);
  const actions = activity.body.rows.map((r) => r.action);
  for (const a of ["QUOTATION_CREATED", "QUOTATION_UPDATED", "QUOTATION_SENT", "QUOTATION_ACCEPTED", "QUOTATION_CONVERTED"]) {
    assert.ok(actions.includes(a), `${a} is logged (got ${actions})`);
  }
  assert.ok(activity.body.rows.every((r) => r.username === "boss@test.uae"), "who did it is recorded");
});

test("delivery note over HTTP: against the order, dispatch, deliver short, then invoice it on its own", { skip }, async () => {
  const pre = await call("GET", `/delivery-notes/from-order/${S.order._id}`);
  assert.equal(pre.status, 200);
  assert.equal(pre.body.lines[0].remaining, 10);

  const made = await call("POST", "/delivery-notes", { body: { sourceTransactionId: S.order._id, items: [{ sourceLineId: pre.body.lines[0].sourceLineId, qty: 10 }] } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const dn = made.body;
  assert.match(dn.deliveryNoteNo, /^DLN-\d{4}-\d{4}$/);
  assert.equal(dn.invoiceStatus, "DRAFT");

  const over = await call("POST", "/delivery-notes", { body: { sourceTransactionId: S.order._id, items: [{ sourceLineId: pre.body.lines[0].sourceLineId, qty: 1 }] } });
  assert.equal(over.status, 409);
  assert.equal(over.data.errorCode, "OVER_DELIVERY");

  const pick = await call("GET", `/delivery-notes/${dn._id}/pick-list`);
  assert.equal(pick.status, 200);
  assert.equal(pick.body.lines[0].qty, 10);

  assert.equal((await call("POST", `/delivery-notes/${dn._id}/dispatch`, { body: { vehicleNo: "DXB A 1", driverName: "Raju" } })).body.status, "DISPATCHED");
  const noName = await call("POST", `/delivery-notes/${dn._id}/deliver`, { body: {} });
  assert.equal(noName.status, 400);
  assert.equal(noName.data.errorCode, "RECEIVED_BY_REQUIRED");
  const done = await call("POST", `/delivery-notes/${dn._id}/deliver`, {
    body: { receivedBy: "Store keeper", lines: [{ lineId: dn.items[0]._id, deliveredQty: 8, shortReason: "2 cartons damaged" }] },
  });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.body.status, "DELIVERED");
  assert.equal(done.body.clock.clock, "within");

  // approving the order invoices these goods: the note is closed and the clock stops
  assert.equal((await call("PATCH", `/transactions/transactions/${S.order._id}/process`, { body: { action: "approve" } })).status, 200);
  const after = await call("GET", `/delivery-notes/${dn._id}`);
  assert.equal(after.body.invoiceStatus, "INVOICED");
  assert.equal(after.body.clock, null);
  assert.equal(after.body.sourceOrder.status, "APPROVED");
  assert.equal((await call("GET", "/stock/stock")).status, 200);

  const rows = (await call("GET", `/delivery-notes?sourceId=${S.order._id}`)).body;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].party.customerName, "Cust");

  const log = await call("GET", `/delivery-notes/${dn._id}/activity`);
  const actions = log.body.rows.map((r) => r.action);
  for (const a of ["DELIVERY_NOTE_CREATED", "DELIVERY_NOTE_DISPATCHED", "DELIVERY_NOTE_DELIVERED"]) assert.ok(actions.includes(a), `${a} logged`);
});

test("a delivery note on its own is invoiced over HTTP, and a delete answers 204", { skip }, async () => {
  const made = await call("POST", "/delivery-notes", { body: { partyId: String(S.customer._id), items: [{ itemId: String(S.rice._id), qty: 4, price: 20, vatPercent: 5 }] } });
  assert.equal(made.status, 201);
  const id = made.body._id;
  assert.equal((await call("POST", `/delivery-notes/${id}/deliver`, { body: { receivedBy: "Ali", proofNote: "signed" } })).body.status, "DELIVERED");

  assert.ok((await call("GET", "/delivery-notes/uninvoiced")).body.rows.some((r) => r._id === id));
  const inv = await call("POST", "/delivery-notes/invoice", { body: { deliveryNoteIds: [id] } });
  assert.equal(inv.status, 201, JSON.stringify(inv.data));
  assert.equal(inv.body.salesOrder.status, "DRAFT");
  assert.equal(inv.body.salesOrder.totalAmount, 84); // 4 x 20 + 5%
  assert.equal(inv.body.deliveryNotes[0].invoiceStatus, "DRAFT");
  assert.equal((await call("POST", "/delivery-notes/invoice", { body: { deliveryNoteIds: [id] } })).data.errorCode, "ALREADY_INVOICED");

  // the draft invoice is deleted through the ordinary route: the note is free again
  assert.equal((await call("DELETE", `/transactions/transactions/${inv.body.salesOrder._id}`)).status, 204);
  assert.equal((await call("GET", `/delivery-notes/${id}`)).body.invoiceStatus, "NONE");

  // a draft quotation and a draft note delete with 204
  const q = await call("POST", "/quotations", { body: { partyId: String(S.customer._id), items: [{ itemId: String(S.rice._id), qty: 1, price: 1 }] } });
  assert.equal((await call("DELETE", `/quotations/${q.body._id}`)).status, 204);
  const d = await call("POST", "/delivery-notes", { body: { partyId: String(S.customer._id), items: [{ itemId: String(S.rice._id), qty: 1, price: 1 }] } });
  assert.equal((await call("DELETE", `/delivery-notes/${d.body._id}`)).status, 204);
  assert.equal((await call("GET", `/delivery-notes/${d.body._id}`)).status, 404);
});

test("a customer's documents come back as deals over HTTP, behind a login", { skip }, async () => {
  const url = `/document-flow/customer/${S.customer._id}`;
  assert.equal((await call("GET", url, { token: null })).status, 401);

  const r = await call("GET", url);
  assert.equal(r.status, 200);
  assert.equal(r.data.success, true);
  assert.deepEqual(Object.keys(r.body).sort(), ["chains", "customer", "summary", "truncated"]);
  assert.equal(r.body.customer.customerName, "Cust");

  // the offer written in the first test became this order, which was then delivered against and approved
  const deal = r.body.chains.find((c) => c.order?._id === S.order._id);
  assert.ok(deal, "the order's deal is there");
  assert.equal(deal.stage, "invoiced");
  assert.equal(deal.quotation.quotationNo, S.q.quotationNo);
  assert.equal(deal.notes.length, 1);
  assert.equal(deal.mode, "order_first");

  assert.equal((await call("GET", "/document-flow/customer/not-an-id")).data.errorCode, "CUSTOMER_REQUIRED");
  assert.equal((await call("GET", `/document-flow/customer/${new mongoose.Types.ObjectId()}`)).status, 404);
});
