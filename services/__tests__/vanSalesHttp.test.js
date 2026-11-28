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

  // the ready-made Van salesman role holds van selling and nothing else of the ERP, and is offered only where van sales was sold
  const listed = await call("owner", "GET", "/access/roles");
  const vanRole = listed.body.roles.find((r) => r.key === "van_salesman");
  assert.ok(vanRole?.builtIn, "the organisation that bought van sales is offered the Van salesman role");
  assert.deepEqual([...vanRole.permissions].sort(), ["lookups.view", "vansales.sell", "vansales.view"]);
  const elsewhere = await call("plain", "GET", "/access/roles");
  assert.equal(elsewhere.body.roles.some((r) => r.key === "van_salesman"), false, "an organisation without van sales is not offered it");
  const handed = await call("plain", "POST", "/access/users", { name: "Nope", email: "nope@novans.test", password: "Abcd12345678", role: "van_salesman" });
  assert.equal(handed.status, 400, JSON.stringify(handed.data));
  assert.equal(handed.code, "ROLE_NOT_FOUND");
  const made = await call("owner", "POST", "/access/users", { name: "Made", email: "made@vanflow.test", password: "Abcd12345678", role: "van_salesman" });
  assert.equal(made.status, 201, JSON.stringify(made.data));
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
  // this trip has no route: the order is for the van's next visit (tomorrow), planned by van rather than by route
  const order = await call("ali", "POST", `/van-sales/trips/${tripId}/preorders`, { customerId: String(cust._id), items: [{ itemId: rice._id, qty: 3 }] });
  assert.equal(order.status, 201, JSON.stringify(order.data));
  assert.ok(order.body.source.vanId, "a van with no route keeps its orders for next time by van");
  assert.equal(order.body.source.routeId, undefined, "no route is named");
  const badDay = await call("ali", "POST", `/van-sales/trips/${tripId}/preorders`, { customerId: String(cust._id), items: [{ itemId: rice._id, qty: 3 }], expectedDate: "2020-01-01" });
  assert.equal(badDay.code, "INVALID_DATE", "an order for next time is not for a day gone by");

  // fuel from the van's cash is his to enter on his own trip; with no route he may pin a shop he sells to, once
  const fuel = await call("ali", "POST", `/van-sales/trips/${tripId}/expenses`, { kind: "fuel", amount: 20 });
  assert.equal(fuel.status, 201, JSON.stringify(fuel.data));
  assert.equal(fuel.body.trip.totals.expenses, 20);
  const pin = await call("ali", "POST", `/van-sales/trips/${tripId}/customers/${cust._id}/location`, { location: { lat: 25.2, lng: 55.3 } });
  assert.equal(pin.status, 200, JSON.stringify(pin.data));
  const again = await call("ali", "POST", `/van-sales/trips/${tripId}/customers/${cust._id}/location`, { location: { lat: 25.3, lng: 55.4 } });
  assert.equal(again.code, "LOCATION_ALREADY_SET", "moving a pin is a supervisor's call");

  // what a customer usually buys is the salesman's to read on his own trip: the invoice he just made is their last order
  const insight = await call("ali", "GET", `/van-sales/trips/${tripId}/customers/${cust._id}/insight`);
  assert.equal(insight.status, 200, JSON.stringify(insight.data));
  assert.equal(insight.body.lastOrder.lines[0].qty, 10);
  assert.equal(insight.body.lastOrder.lines[0].onVan, 30);

  const refused = await call("ali", "POST", `/van-sales/trips/${tripId}/sell`, { customerId: String(cust._id), items: [{ itemId: rice._id, qty: 31, price: 20 }] });
  assert.equal(refused.status, 409);
  assert.equal(refused.code, "VAN_STOCK_SHORT");
});

test("another salesman cannot work this trip, whatever he holds", { skip }, async () => {
  // nor read a customer's buying history through it
  const peek = await call("bob", "GET", `/van-sales/trips/${tripId}/customers/${cust._id}/insight`);
  assert.equal(peek.status, 403);
  assert.equal(peek.code, "PERMISSION_DENIED");
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
    ["POST", `/van-sales/trips/${tripId}/load-check`, { lines: [] }],
    ["GET", "/van-sales/board", undefined],
  ];
  for (const [m, u, b] of doors) {
    const r = await call("ali", m, u, b);
    assert.equal(r.status, 403, `${m} ${u}`);
    assert.equal(r.code, "PERMISSION_DENIED", `${m} ${u}`);
  }
  // he may READ the suggested load for his own trip (to start a load request from it); it changes nothing
  assert.equal((await call("ali", "GET", `/van-sales/trips/${tripId}/suggested-load`)).status, 200);
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
  // a second count is the supervisor's, never the salesman's own
  const own = await call("ali", "POST", `/van-sales/trips/${tripId}/recount`, { counts: [{ stockId: rice._id, good: 30, damaged: 0 }] });
  assert.equal(own.status, 403);
  assert.equal(own.code, "PERMISSION_DENIED");
  const wrong = await call("owner", "POST", `/van-sales/trips/${tripId}/recount`, { counts: [{ stockId: rice._id, good: 29, damaged: 0 }] });
  assert.equal(wrong.status, 200, JSON.stringify(wrong.data));
  assert.equal(wrong.body.status, "UNLOADED");
  assert.equal(wrong.body.unload.lines[0].difference, -1);
  assert.equal(wrong.body.unload.previous[0].lines[0].countedGood, 30);
  assert.equal((await call("owner", "POST", `/van-sales/trips/${tripId}/recount`, { counts: [{ stockId: rice._id, good: 30, damaged: 0 }] })).status, 200);

  // the cash is typed: nothing, an empty box, null and a list are all refused and nothing is settled
  for (const body of [{}, { cashHanded: "" }, { cashHanded: null }, { cashHanded: [] }]) {
    const none = await call("owner", "POST", `/van-sales/trips/${tripId}/settle`, body);
    assert.equal(none.status, 400, JSON.stringify(body));
    assert.equal(none.code, "CASH_REQUIRED", JSON.stringify(body));
  }
  const settled = await call("owner", "POST", `/van-sales/trips/${tripId}/settle`, { cashHanded: preview.body.cash.expected });
  assert.equal(settled.status, 200, JSON.stringify(settled.data));
  assert.equal(settled.body.trip.status, "SETTLED");
  const late = await call("owner", "POST", `/van-sales/trips/${tripId}/recount`, { counts: [] });
  assert.equal(late.status, 409);
  assert.equal(late.code, "TRIP_NOT_UNLOADED");

  const history = await call("owner", "GET", `/van-sales/trips/${tripId}/activity`);
  const words = JSON.stringify(history.body);
  assert.match(words, /counted again on [^"]*sellable 30 to 29/i);
  for (const action of ["opened", "loaded", "sold on the van", "settled"]) assert.ok(words.toLowerCase().includes(action), `the history mentions ${action}: ${words.slice(0, 300)}`);
});

test("a salesman reads his own van, trips and figures, never another salesman's; a supervisor reads them all", { skip }, async () => {
  const route = await call("owner", "POST", "/van-sales/routes", { name: "Bob's round", customers: [{ customerId: String(cust._id) }] });
  assert.equal(route.status, 201, JSON.stringify(route.data));
  const van2 = await call("owner", "POST", "/van-sales/vans", { code: "van-2", name: "Van Two", salesmanId: String(bob._id), defaultRouteId: route.body.id });
  assert.equal(van2.status, 201, JSON.stringify(van2.data));
  const opened = await call("owner", "POST", "/van-sales/trips", { vanId: van2.body.id });
  assert.equal(opened.status, 201, JSON.stringify(opened.data));
  const his = opened.body.id;
  assert.equal((await call("owner", "POST", `/van-sales/trips/${his}/load`, { lines: [{ stockId: rice._id, qty: 5 }] })).status, 200);
  assert.equal((await call("owner", "POST", `/van-sales/trips/${his}/depart`)).status, 200);

  const parts = (id) => ["", "/activity", "/preorders", `/prices?customerId=${cust._id}`, "/visits", "/expenses"].map((p) => `/van-sales/trips/${id}${p}`);
  for (const url of parts(his)) {
    const peek = await call("ali", "GET", url);
    assert.equal(peek.status, 404, `ali ${url} ${JSON.stringify(peek.data)}`);
    assert.equal(peek.code, "TRIP_NOT_FOUND", url);
    assert.equal((await call("bob", "GET", url)).status, 200, `bob ${url}`);
    assert.equal((await call("owner", "GET", url)).status, 200, `owner ${url}`);
  }
  for (const url of parts(tripId)) assert.equal((await call("ali", "GET", url)).status, 200, `ali's own ${url}`);
  const orders = await call("ali", "GET", `/van-sales/routes/${route.body.id}/preorders`);
  assert.equal(orders.status, 404, JSON.stringify(orders.data));
  assert.equal((await call("bob", "GET", `/van-sales/routes/${route.body.id}/preorders`)).status, 200);
  assert.equal((await call("owner", "GET", `/van-sales/routes/${route.body.id}/preorders`)).status, 200);

  // lists: his own only, whatever the address asks for
  for (const url of ["/van-sales/trips", `/van-sales/trips?salesmanId=${bob._id}`]) {
    const r = await call("ali", "GET", url);
    assert.deepEqual(r.body.map((t) => t.id), [tripId], url);
  }
  assert.equal((await call("owner", "GET", "/van-sales/trips")).body.length, 2);
  assert.deepEqual((await call("ali", "GET", "/van-sales/vans")).body.map((v) => v.code), ["VAN-1"]);
  assert.deepEqual((await call("owner", "GET", "/van-sales/vans")).body.map((v) => v.code), ["VAN-1", "VAN-2"]);
  assert.equal((await call("ali", "GET", `/van-sales/vans/${van2.body.id}`)).status, 404);
  assert.equal((await call("ali", "GET", `/van-sales/vans/${vanId}`)).status, 200);

  // figures: settle bob's day too, then each salesman's reports hold only his trip
  assert.equal((await call("owner", "POST", `/van-sales/trips/${his}/unload`, { counts: [{ stockId: rice._id, good: 5, damaged: 0 }] })).status, 200);
  assert.equal((await call("owner", "POST", `/van-sales/trips/${his}/settle`, { cashHanded: 0 })).status, 200);
  const summary = await call("ali", "GET", `/van-sales/reports/summary?onlySalesman=${bob._id}`);
  assert.equal(summary.status, 200, JSON.stringify(summary.data));
  assert.deepEqual(summary.body.bySalesman.map((s) => s.name), ["ali"]);
  assert.deepEqual((await call("owner", "GET", "/van-sales/reports/summary")).body.bySalesman.map((s) => s.name).sort(), ["ali", "bob"]);
  const profit = await call("ali", "GET", "/van-sales/reports/route-profit?by=salesman");
  assert.equal(profit.body.trips, 1);
  assert.equal((await call("owner", "GET", "/van-sales/reports/route-profit?by=salesman")).body.trips, 2);
});
