// The customer's own van page over real HTTP (GET /share/:token/van, POST /share/:token/van-request): a public door,
// reached only through the secret link minted when a van invoice is handed to the customer on WhatsApp.
//
// The rules themselves are proved at the service in vanSalesPhase6.test.js with a stand-in link. What this adds is the
// door: no sign-in, never cached, the link minted the real way, a request that becomes a draft order, the refusals,
// and - the one that matters - a link to an ORDINARY invoice opens the invoice and nothing of the van page.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vanshare_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
const PORT = 4130 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";
const CODE = "vanshare";

let child, M, Org, ctx;
let logs = "";
let token;
let visitor = 0;

async function call(method, url, body) {
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode };
}
// the customer: no sign-in at all, each call from an address of its own so the per-address courtesy limit stays out of it
async function pub(method, url, body) {
  visitor += 1;
  const headers = { "X-Forwarded-For": `203.0.113.${visitor}` };
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = (res.headers.get("content-type") || "").includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode, headers: res.headers };
}
const tokenOf = (r) => String(r.body?.share?.url || "").split("/d/")[1];

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0", TRUST_PROXY_HOPS: "1", TRUST_CF_CONNECTING_IP: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = { Admin: require("../../models/core/adminModel"), Customer: require("../../models/modules/customerModel") };
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

let rice, oil, cust, vanLink, plainLink;

test("setup: a van on a route, a sale at the door handed over on WhatsApp, and an ordinary invoice handed over too", { skip }, async () => {
  await Org.create({ legalName: "Van Share Foods LLC", code: CODE, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "internal", moduleOverrides: { vansales: true } });
  await ctx.runWithTenant({ companyId: CODE, branchId: "main" }, () =>
    new M.Admin({ name: "owner", email: `owner@${CODE}.test`, password: PASSWORD, status: "active", isActive: true, type: "super_admin" }).save()
  );
  const login = await fetch(`${BASE}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `owner@${CODE}.test`, password: PASSWORD }) });
  const json = await login.json();
  assert.equal(login.status, 200, JSON.stringify(json));
  token = json.data.tokens.accessToken;
  const owner = json.data.admin || json.data.user;

  const cat = await call("POST", "/categories/categories", { name: "Food" });
  const vendor = await call("POST", "/vendors/vendors", { vendorName: "Wholesale Co", contactPerson: "x", address: "Dubai", paymentTerms: "Net 30" });
  const base = { categoryId: cat.body.category._id, unitOfMeasure: new mongoose.Types.ObjectId().toString(), origin: "UAE", brand: "x" };
  rice = (await call("POST", "/stock/stock", { ...base, sku: "RICE", itemName: "Rice 5kg", salesPrice: 20 })).body.stock;
  oil = (await call("POST", "/stock/stock", { ...base, sku: "OIL", itemName: "Oil 1L", salesPrice: 9 })).body.stock;
  const buy = await call("POST", "/transactions/transactions", {
    type: "purchase_order", partyId: vendor.body._id, partyType: "Vendor", partyTypeRef: "Vendor",
    items: [{ itemId: rice._id, description: "Rice 5kg", qty: 100, price: 10, rate: 10, vatPercent: 0 }, { itemId: oil._id, description: "Oil 1L", qty: 100, price: 5, rate: 5, vatPercent: 0 }],
  });
  assert.equal(buy.status, 201, JSON.stringify(buy.data));
  assert.equal((await call("PATCH", `/transactions/transactions/${buy.body._id}/process`, { action: "approve" })).status, 200);
  cust = await ctx.runWithTenant({ companyId: CODE, branchId: "main" }, () =>
    M.Customer.create({ customerId: "C1", customerName: "Al Noor Grocery", contactPerson: "Noor", phone: "0501111111", shippingAddress: "Dubai", paymentTerms: "Cash" })
  );

  const route = await call("POST", "/van-sales/routes", { name: "Deira loop", days: [0, 1, 2, 3, 4, 5, 6], customers: [{ customerId: String(cust._id) }] });
  assert.equal(route.status, 201, JSON.stringify(route.data));
  const van = await call("POST", "/van-sales/vans", { code: "van-1", name: "Van One", salesmanId: String(owner?._id || owner?.id || ""), defaultRouteId: route.body.id });
  assert.equal(van.status, 201, JSON.stringify(van.data));
  const trip = await call("POST", "/van-sales/trips", { vanId: van.body.id });
  assert.equal(trip.status, 201, JSON.stringify(trip.data));
  const tripId = trip.body.id;
  assert.equal((await call("POST", `/van-sales/trips/${tripId}/load`, { lines: [{ stockId: rice._id, qty: 40 }] })).status, 200);
  assert.equal((await call("POST", `/van-sales/trips/${tripId}/depart`)).status, 200);
  const sale = await call("POST", `/van-sales/trips/${tripId}/sell`, { customerId: String(cust._id), items: [{ itemId: rice._id, qty: 5, price: 20 }] });
  assert.equal(sale.status, 201, JSON.stringify(sale.data));

  const handed = await call("POST", `/van-sales/trips/${tripId}/invoices/${sale.body.invoice._id}/whatsapp`, {});
  assert.equal(handed.status, 200, JSON.stringify(handed.data));
  vanLink = tokenOf(handed);
  assert.ok(vanLink, "the van door minted a link");

  // an ordinary invoice, not raised on a van, handed over through the ordinary door
  const plain = await call("POST", "/transactions/transactions", {
    type: "sales_order", partyId: String(cust._id), partyType: "Customer", partyTypeRef: "Customer",
    items: [{ itemId: oil._id, description: "Oil 1L", qty: 2, price: 9, rate: 9, vatPercent: 0 }],
  });
  assert.equal(plain.status, 201, JSON.stringify(plain.data));
  assert.equal((await call("PATCH", `/transactions/transactions/${plain.body._id}/process`, { action: "approve" })).status, 200);
  const given = await call("POST", "/messaging/handoff", { docType: "tax_invoice", sourceId: plain.body._id });
  assert.equal(given.status, 201, JSON.stringify(given.data));
  plainLink = tokenOf(given);
  assert.ok(plainLink);
});

test("the customer opens the van page with no sign-in: what they owe, the next visit, and what they may ask for", { skip }, async () => {
  const r = await pub("GET", `/share/${vanLink}/van`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.headers.get("cache-control") || "", /no-store/, "never cached");
  assert.equal(r.body.canRequest, true, "the trip is on a route, so there is a next visit to ask for");
  assert.ok(r.body.statement, "what they owe");
  const names = r.body.items.map((i) => i.name);
  assert.ok(names.includes("Rice 5kg"), "the item on this invoice is offered");
  assert.ok(!names.includes("Oil 1L"), "an item on no price list of theirs and not on this invoice is not");
  const wire = JSON.stringify(r.data);
  for (const secret of ["purchasePrice", "costValue", "creditLimit"]) assert.ok(!wire.includes(secret), `the page carries no ${secret}`);
});

test("a request becomes a draft order for the next visit; the refusals say why; a fourth waiting one is refused", { skip }, async () => {
  const ok = await pub("POST", `/share/${vanLink}/van-request`, { lines: [{ stockId: rice._id, qty: 3 }] });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.ok(ok.body.orderNo, "numbered like any order");

  assert.equal((await pub("POST", `/share/${vanLink}/van-request`, { lines: [{ stockId: oil._id, qty: 1 }] })).code, "ITEM_NOT_OFFERED");
  assert.equal((await pub("POST", `/share/${vanLink}/van-request`, { lines: [] })).code, "ITEMS_REQUIRED");

  assert.equal((await pub("POST", `/share/${vanLink}/van-request`, { lines: [{ stockId: rice._id, qty: 1 }] })).status, 201);
  assert.equal((await pub("POST", `/share/${vanLink}/van-request`, { lines: [{ stockId: rice._id, qty: 1 }] })).status, 201);
  const fourth = await pub("POST", `/share/${vanLink}/van-request`, { lines: [{ stockId: rice._id, qty: 1 }] });
  assert.equal(fourth.status, 409, JSON.stringify(fourth.data));
  assert.equal(fourth.code, "REQUEST_LIMIT");

  const page = await pub("GET", `/share/${vanLink}/van`);
  assert.ok(page.body.orders.filter((o) => o.requested).length >= 3, "their requests are listed for the next visit");
});

test("a link to an ordinary invoice opens the invoice and nothing of the van page", { skip }, async () => {
  assert.equal((await pub("GET", `/share/${plainLink}`)).status, 200, "the invoice itself opens");
  const page = await pub("GET", `/share/${plainLink}/van`);
  assert.equal(page.status, 404);
  assert.equal(page.code, "SHARE_NOT_FOUND");
  const ask = await pub("POST", `/share/${plainLink}/van-request`, { lines: [{ stockId: rice._id, qty: 1 }] });
  assert.equal(ask.status, 404);
  assert.equal(ask.code, "SHARE_NOT_FOUND");
  for (const bad of ["nonsense", `${vanLink.split(".")[0]}.wrongsecret`]) {
    assert.equal((await pub("GET", `/share/${bad}/van`)).status, 404, bad);
  }
});
