// Returnable containers over real HTTP against a spawned strict server: who sets the types and a customer's holding, a
// salesman's sale with a deposit and his empties on his own trip only, and bodies nobody meant to send.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vch_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const PORT = 4510 + Math.floor(Math.random() * 180);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";
const CODE = "vancrate";

let child, M, Org, ctx;
let logs = "";
const T = {};

async function call(who, method, url, body) {
  const headers = { Authorization: `Bearer ${T[who]}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
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
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = { Admin: require("../../models/core/adminModel"), Customer: require("../../models/modules/customerModel"), Transaction: require("../../models/modules/transactionModel") };
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


let water, tripAli, tripOmar, cust, bottle;

test("setup: an owner, two salesmen with their own vans out, water, a customer", { skip }, async () => {
  await Org.create({ legalName: "Van Crate Foods LLC", code: CODE, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "internal", moduleOverrides: { vansales: true } });
  await person(CODE, "owner", { type: "super_admin" });
  const role = await call("owner", "POST", "/access/roles", { key: "van_salesman", name: "Van salesman", description: "Sells from a van", rank: 30, permissions: ["vansales.sell"] });
  assert.equal(role.status, 201, JSON.stringify(role.data));
  const ali = await person(CODE, "ali", { type: "viewer", roleKey: "van_salesman" });
  const omar = await person(CODE, "omar", { type: "viewer", roleKey: "van_salesman" });
  const cat = await call("owner", "POST", "/categories/categories", { name: "Drinks" });
  const vendor = await call("owner", "POST", "/vendors/vendors", { vendorName: "Wholesale Co", contactPerson: "x", address: "Dubai", paymentTerms: "Net 30" });
  const base = { categoryId: cat.body.category._id, unitOfMeasure: new mongoose.Types.ObjectId().toString(), origin: "UAE", brand: "x" };
  water = (await call("owner", "POST", "/stock/stock", { ...base, sku: "W19", itemName: "Water 19L", salesPrice: 12 })).body.stock;
  const buy = await call("owner", "POST", "/transactions/transactions", { type: "purchase_order", partyId: vendor.body._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: water._id, description: "Water", qty: 100, price: 6, rate: 6, vatPercent: 0 }] });
  assert.equal((await call("owner", "PATCH", `/transactions/transactions/${buy.body._id}/process`, { action: "approve" })).status, 200);
  cust = await as(CODE, () => M.Customer.create({ customerId: "C1", customerName: "Al Noor Grocery", contactPerson: "Noor", phone: "0501111111", shippingAddress: "Dubai", paymentTerms: "Net 30" }));
  for (const [who, code] of [[ali, "van-1"], [omar, "van-2"]]) {
    const vanId = (await call("owner", "POST", "/van-sales/vans", { code, name: code, salesmanId: String(who._id) })).body.id;
    const id = (await call("owner", "POST", "/van-sales/trips", { vanId })).body.id;
    assert.equal((await call("owner", "POST", `/van-sales/trips/${id}/load`, { lines: [{ stockId: water._id, qty: 20 }] })).status, 200);
    assert.equal((await call("owner", "POST", `/van-sales/trips/${id}/depart`)).status, 200);
    if (who === ali) tripAli = id; else tripOmar = id;
  }
});

test("the types: a manager sets them up, a salesman reads them and cannot change them", { skip }, async () => {
  assert.equal((await call("ali", "POST", "/van-sales/container-types", { code: "B19", name: "19L bottle", deposit: 10 })).status, 403);
  const made = await call("owner", "POST", "/van-sales/container-types", { code: "B19", name: "19L bottle", deposit: 10, items: [{ stockId: water._id, perUnit: 1 }] });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  bottle = made.body;
  assert.equal((await call("ali", "GET", "/van-sales/container-types")).body[0].code, "B19");
  assert.equal((await call("ali", "PUT", `/van-sales/container-types/${bottle.id}`, { deposit: 0 })).status, 403, "a salesman cannot drop the deposit");
});

test("a salesman's sale hands out bottles with a deposit; his empties on his own trip only; the customer's holding", { skip }, async () => {
  const sold = await call("ali", "POST", `/van-sales/trips/${tripAli}/sell`, { customerId: String(cust._id), items: [{ itemId: water._id, qty: 4 }] });
  assert.equal(sold.status, 201, JSON.stringify(sold.data));
  assert.equal(sold.body.deposit, 40);
  assert.ok(sold.body.depositNote);
  assert.equal((await call("ali", "POST", `/van-sales/trips/${tripOmar}/containers`, { customerId: String(cust._id), containers: [{ typeId: bottle.id, collected: 1 }] })).status, 403, "not on another salesman's van");
  const back = await call("ali", "POST", `/van-sales/trips/${tripAli}/containers`, { customerId: String(cust._id), containers: [{ typeId: bottle.id, collected: 1 }] });
  assert.equal(back.status, 201, JSON.stringify(back.data));
  assert.equal(back.body.deposit, -10);
  const held = await call("ali", "GET", `/van-sales/customers/${cust._id}/containers`);
  assert.equal(held.body.find((b) => b.code === "B19").holds, 3);
  const ActivityLog = require("../../models/modules/financial/activityLogModel");
  assert.ok(await as(CODE, () => ActivityLog.exists({ action: "VAN_SALE", summary: /container deposit/ })), "the sale's audit names its deposit note");
});

test("only a manager sets what a customer holds, with a reason", { skip }, async () => {
  const body = { customerId: String(cust._id), typeId: bottle.id, holds: 8, reason: "Held before go-live" };
  assert.equal((await call("ali", "POST", "/van-sales/container-moves/adjust", body)).status, 403);
  const set = await call("owner", "POST", "/van-sales/container-moves/adjust", body);
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.equal(set.body.balances.find((b) => b.code === "B19").holds, 8);
});

test("bodies nobody meant to send", { skip }, async () => {
  for (const body of [
    { customerId: String(cust._id), containers: "two" },
    { customerId: String(cust._id), containers: [{ typeId: { $ne: null }, collected: 1 }] },
    { customerId: String(cust._id), containers: [{ typeId: bottle.id, collected: [1] }] },
    { customerId: String(cust._id), containers: [{ typeId: bottle.id, collected: -3 }] },
    { customerId: { $ne: null }, containers: [{ typeId: bottle.id, collected: 1 }] },
  ]) {
    const r = await call("ali", "POST", `/van-sales/trips/${tripAli}/containers`, body);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)} -> ${r.status} ${JSON.stringify(r.data)}`);
  }
  for (const body of [{ code: { $ne: "" }, name: "x" }, { code: "X", name: "x", items: [{ stockId: water._id, perUnit: "lots" }] }, { code: "Y", name: "y", deposit: { $gt: 0 } }]) {
    const r = await call("owner", "POST", "/van-sales/container-types", body);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(body)} -> ${r.status}`);
  }
  const sell = await call("ali", "POST", `/van-sales/trips/${tripAli}/sell`, { customerId: String(cust._id), items: [{ itemId: water._id, qty: 1 }], containers: [{ typeId: bottle.id, given: 1.5 }] });
  assert.equal(sell.code, "CONTAINERS_INVALID");
});
