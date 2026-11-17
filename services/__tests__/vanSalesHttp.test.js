// Van sales over real HTTP against a spawned strict server (the shape every *Http.test.js file uses): who may do what.
//
// The money and stock arithmetic is proved in vanSales.test.js against the services. What this adds is the door:
// the module is sold per organisation (an organisation without it is refused with MODULE_NOT_IN_PLAN), a salesman
// holding only vansales.sell can sell and collect on HIS OWN trip and nothing else (not another salesman's, not
// opening or loading a trip, not settling, not the setup), a supervisor can, the request body cannot choose the trip
// link on an ordinary document, and the stock list shows what is on the vans.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vanhttp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3940 + Math.floor(Math.random() * 180);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";
const CODE = "vanflow";

let child, M, Org, ctx;
let logs = "";
const T = {};

async function call(who, method, url, body) {
  const headers = { Authorization: `Bearer ${T[who]}` };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode };
}
const as = (org, fn) => ctx.runWithTenant({ companyId: org, branchId: "main" }, fn);
async function person(org, who, fields) {
  const doc = await as(org, () => new M.Admin({ name: who, email: `${who}@${org}.test`, password: PASSWORD, status: "active", isActive: true, ...fields }).save());
  const login = await fetch(`${BASE}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `${who}@${org}.test`, password: PASSWORD }) });
  const json = await login.json();
  assert.equal(login.status, 200, JSON.stringify(json));
  T[who] = json.data.tokens.accessToken;
  return doc;
}

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0", SUPPORT_CONTACT: "help@zarvia.example" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = {
    Admin: require("../../models/core/adminModel"),
    Customer: require("../../models/modules/customerModel"),
  };
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

let rice, vanId, tripId, cust, ali, bob;

test("setup: an organisation that bought van sales, one that did not, and the people", { skip }, async () => {
  await Org.create({ legalName: "Van Flow Foods LLC", code: CODE, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "internal", moduleOverrides: { vansales: true } });
  await Org.create({ legalName: "No Vans Trading LLC", code: "novans", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "internal" });
  await person(CODE, "owner", { type: "super_admin" });
  await person("novans", "plain", { type: "super_admin" });

  // the salesman's role holds van selling and nothing else of the ERP
  const role = await call("owner", "POST", "/access/roles", { key: "van_salesman", name: "Van salesman", description: "Sells from a van", rank: 30, permissions: ["vansales.sell"] });
  assert.equal(role.status, 201, JSON.stringify(role.data));
  ali = await person(CODE, "ali", { type: "viewer", roleKey: "van_salesman" });
  bob = await person(CODE, "bob", { type: "viewer", roleKey: "van_salesman" });
});

test("an organisation that did not buy van sales is refused at every door, and the plan is named", { skip }, async () => {
  for (const [m, u] of [["GET", "/van-sales/vans"], ["GET", "/van-sales/trips/mine"], ["POST", "/van-sales/trips"]]) {
    const r = await call("plain", m, u, m === "GET" ? undefined : {});
    assert.equal(r.status, 403, `${m} ${u}`);
    assert.equal(r.code, "MODULE_NOT_IN_PLAN", `${m} ${u}`);
  }
});

test("stock, a customer, a van and a loaded trip, built by the supervisor", { skip }, async () => {
  const cat = await call("owner", "POST", "/categories/categories", { name: "Food" });
  const vendor = await call("owner", "POST", "/vendors/vendors", { vendorName: "Wholesale Co", contactPerson: "x", address: "Dubai", paymentTerms: "Net 30" });
  const base = { categoryId: cat.body.category._id, unitOfMeasure: new mongoose.Types.ObjectId().toString(), origin: "UAE", brand: "x" };
  rice = (await call("owner", "POST", "/stock/stock", { ...base, sku: "RICE", itemName: "Rice 5kg", salesPrice: 20 })).body.stock;
  const buy = await call("owner", "POST", "/transactions/transactions", { type: "purchase_order", partyId: vendor.body._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: rice._id, description: "Rice 5kg", qty: 100, price: 10, rate: 10, vatPercent: 0 }] });
  assert.equal(buy.status, 201, JSON.stringify(buy.data));
  const approved = await call("owner", "PATCH", `/transactions/transactions/${buy.body._id}/process`, { action: "approve" });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  cust = await as(CODE, () => M.Customer.create({ customerId: "C1", customerName: "Al Noor Grocery", contactPerson: "Noor", phone: "0501111111", shippingAddress: "Dubai", paymentTerms: "Cash" }));

  const van = await call("owner", "POST", "/van-sales/vans", { code: "van-1", name: "Van One", salesmanId: String(ali._id) });
  assert.equal(van.status, 201, JSON.stringify(van.data));
  vanId = van.body.id;
  const trip = await call("owner", "POST", "/van-sales/trips", { vanId });
  assert.equal(trip.status, 201, JSON.stringify(trip.data));
  tripId = trip.body.id;
  const loaded = await call("owner", "POST", `/van-sales/trips/${tripId}/load`, { lines: [{ stockId: rice._id, qty: 40 }] });
  assert.equal(loaded.status, 200, JSON.stringify(loaded.data));
  const sent = await call("owner", "POST", `/van-sales/trips/${tripId}/depart`);
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
});

test("a salesman may sell, collect and count in on his own trip, and sees only what his role shows", { skip }, async () => {
  const mine = await call("ali", "GET", "/van-sales/trips/mine");
  assert.equal(mine.status, 200, JSON.stringify(mine.data));
  assert.equal(mine.body.length, 1);
  assert.equal(mine.body[0].sellable[0].qty, 40);

  const sale = await call("ali", "POST", `/van-sales/trips/${tripId}/sell`, { customerId: String(cust._id), items: [{ itemId: rice._id, qty: 10, price: 20 }], payNow: { mode: "cash", full: true } });
  assert.equal(sale.status, 201, JSON.stringify(sale.data));
  assert.equal(sale.body.invoice.status, "APPROVED");
  assert.equal(sale.body.receipt.status, "approved");
  assert.equal(sale.body.trip.sellable[0].qty, 30);
  assert.equal(sale.body.trip.totals.cash, sale.body.invoice.totalAmount, "the cash the van took is the invoice, in full");

  // the offers are read by the salesman (the phone shows them); an order for next time is his to take
  const offers = await call("ali", "GET", "/van-sales/promotions");
  assert.equal(offers.status, 200, JSON.stringify(offers.data));
  const order = await call("ali", "POST", `/van-sales/trips/${tripId}/preorders`, { customerId: String(cust._id), items: [{ itemId: rice._id, qty: 3 }] });
  assert.equal(order.status, 400, JSON.stringify(order.data));
  assert.equal(order.code, "ROUTE_REQUIRED", "this trip has no route, so there is no next visit to order for (past the permission check)");

  // fuel from the van's cash is his to enter on his own trip; a pin needs the customer on the trip's route
  const fuel = await call("ali", "POST", `/van-sales/trips/${tripId}/expenses`, { kind: "fuel", amount: 20 });
  assert.equal(fuel.status, 201, JSON.stringify(fuel.data));
  assert.equal(fuel.body.trip.totals.expenses, 20);
  const pin = await call("ali", "POST", `/van-sales/trips/${tripId}/customers/${cust._id}/location`, { location: { lat: 25.2, lng: 55.3 } });
  assert.equal(pin.status, 403);
  assert.equal(pin.code, "CUSTOMER_NOT_ON_ROUTE");

  const refused = await call("ali", "POST", `/van-sales/trips/${tripId}/sell`, { customerId: String(cust._id), items: [{ itemId: rice._id, qty: 31, price: 20 }] });
  assert.equal(refused.status, 409);
  assert.equal(refused.code, "VAN_STOCK_SHORT");
});

test("another salesman cannot work this trip, whatever he holds", { skip }, async () => {
  for (const [u, body] of [[`/van-sales/trips/${tripId}/sell`, { customerId: String(cust._id), items: [{ itemId: rice._id, qty: 1 }] }], [`/van-sales/trips/${tripId}/collect`, { customerId: String(cust._id), amount: 5 }], [`/van-sales/trips/${tripId}/unload`, { counts: [] }]]) {
    const r = await call("bob", "POST", u, body);
    assert.equal(r.status, 403, u);
    assert.equal(r.code, "PERMISSION_DENIED", u);
  }
});

test("a salesman cannot open or load a trip, settle one, or change the vans and routes", { skip }, async () => {
  const doors = [
    ["POST", "/van-sales/trips", { vanId }],
    ["POST", `/van-sales/trips/${tripId}/load`, { lines: [{ stockId: rice._id, qty: 1 }] }],
    ["POST", `/van-sales/trips/${tripId}/depart`, {}],
    ["POST", `/van-sales/trips/${tripId}/cancel`, {}],
    ["GET", `/van-sales/trips/${tripId}/settlement`, undefined],
    ["POST", `/van-sales/trips/${tripId}/settle`, {}],
    ["POST", "/van-sales/vans", { code: "X", name: "x" }],
    ["PUT", `/van-sales/vans/${vanId}`, { name: "renamed" }],
    ["POST", "/van-sales/routes", { name: "R" }],
    ["POST", "/van-sales/promotions", { name: "P", kind: "slab", minQty: 1, percent: 5 }],
    ["GET", `/van-sales/trips/${tripId}/suggested-load`, undefined],
    ["POST", `/van-sales/trips/${tripId}/load-check`, { lines: [] }],
    ["GET", "/van-sales/board", undefined],
  ];
  for (const [m, u, b] of doors) {
    const r = await call("ali", m, u, b);
    assert.equal(r.status, 403, `${m} ${u}`);
    assert.equal(r.code, "PERMISSION_DENIED", `${m} ${u}`);
  }
});

test("the stock list shows what is sitting in vans, and a request body cannot choose the trip link", { skip }, async () => {
  const list = await call("owner", "GET", "/stock/stock");
  const item = list.body.stocks.find((s) => s._id === rice._id);
  assert.equal(item.onVan, 30, "30 are still on the van");
  assert.equal(item.currentStock, 90, "the books hold 90: only the 10 sold have left");

  const forged = await call("owner", "POST", "/transactions/transactions", {
    type: "sales_order", partyId: String(cust._id), partyType: "Customer", partyTypeRef: "Customer", status: "DRAFT",
    items: [{ itemId: rice._id, description: "Rice 5kg", qty: 1, price: 20, vatPercent: 0 }],
    vanTripRef: { tripId, tripNo: "VTR-FAKE", vanCode: "VAN-1" },
  });
  assert.equal(forged.status, 201, JSON.stringify(forged.data));
  const back = await call("owner", "GET", `/transactions/transactions/${forged.body._id}`);
  assert.equal(back.body.vanTripRef?.tripId, undefined, "the trip link is written only by the van trip service");
});

test("count in, then only a person who may settle can; the history says so", { skip }, async () => {
  const unload = await call("ali", "POST", `/van-sales/trips/${tripId}/unload`, { counts: [{ stockId: rice._id, good: 30, damaged: 0 }] });
  assert.equal(unload.status, 200, JSON.stringify(unload.data));
  assert.equal(unload.body.status, "UNLOADED");
  assert.equal((await call("ali", "POST", `/van-sales/trips/${tripId}/settle`, {})).status, 403);

  const preview = await call("owner", "GET", `/van-sales/trips/${tripId}/settlement`);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(preview.body.warnings, [], "the count matches and the cash is all there: nothing to tick");
  const settled = await call("owner", "POST", `/van-sales/trips/${tripId}/settle`, {});
  assert.equal(settled.status, 200, JSON.stringify(settled.data));
  assert.equal(settled.body.trip.status, "SETTLED");

  const history = await call("owner", "GET", `/van-sales/trips/${tripId}/activity`);
  const words = JSON.stringify(history.body);
  for (const action of ["opened", "loaded", "sold on the van", "settled"]) assert.ok(words.toLowerCase().includes(action), `the history mentions ${action}: ${words.slice(0, 300)}`);
});
