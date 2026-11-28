// The van analysis over real HTTP against a spawned strict server: the owner reads every figure; a storekeeper reads the
// trips but no costs; a salesman reads only his own trips, with no office expenses and no costs, whatever he asks for; a
// role with no van permission is refused; hostile queries are refused cleanly; and the sales analysis narrows to a van.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vah_${Date.now() % 1e9}_${Math.floor(Math.random() * 1e4)}`;
const PORT = 4520 + Math.floor(Math.random() * 180);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";
const CODE = "vanana";

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
  M = {
    Admin: require("../../models/core/adminModel"), Customer: require("../../models/modules/customerModel"),
    Transaction: require("../../models/modules/transactionModel"), UOM: require("../../models/modules/uomModel"),
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

let ali, omar, vanA, vanB;

test("setup: two vans, each with a settled day; one has a road expense, the other an office bill", { skip }, async () => {
  await Org.create({ legalName: "Van Analysis Foods LLC", code: CODE, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "internal", moduleOverrides: { vansales: true } });
  await person(CODE, "owner", { type: "super_admin" });
  ali = await person(CODE, "ali", { type: "viewer", roleKey: "van_salesman" });
  omar = await person(CODE, "omar", { type: "viewer", roleKey: "van_salesman" });
  await person(CODE, "keeper", { type: "viewer", roleKey: "storekeeper" });
  await person(CODE, "seller", { type: "viewer", roleKey: "sales" });

  const nos = await as(CODE, () => M.UOM.create({ unitName: "Numbers", shortCode: "NOS", category: "Quantity" }));
  const cat = await call("owner", "POST", "/categories/categories", { name: "Drinks" });
  const vendor = await call("owner", "POST", "/vendors/vendors", { vendorName: "Wholesale Co", contactPerson: "x", address: "Dubai", paymentTerms: "Net 30" });
  const made = await call("owner", "POST", "/stock/stock", { categoryId: cat.body.category._id, unitOfMeasure: String(nos._id), origin: "UAE", brand: "x", sku: "WATER", itemName: "Water 500ml", salesPrice: 2 });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const water = made.body.stock;
  const buy = await call("owner", "POST", "/transactions/transactions", { type: "purchase_order", partyId: vendor.body._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: water._id, description: water.itemName, qty: 200, price: 1, rate: 1, vatPercent: 0 }] });
  assert.equal((await call("owner", "PATCH", `/transactions/transactions/${buy.body._id}/process`, { action: "approve" })).status, 200);
  const cust = await as(CODE, () => M.Customer.create({ customerId: "C1", customerName: "Corner Shop", contactPerson: "x", phone: "0501111111", billingAddress: "x", shippingAddress: "Dubai", paymentTerms: "Net 30", creditLimit: 99999 }));

  for (const [who, salesman, code, qty] of [["ali", ali, "van-a", 40], ["omar", omar, "van-b", 10]]) {
    const vanId = (await call("owner", "POST", "/van-sales/vans", { code, name: code.toUpperCase(), salesmanId: String(salesman._id) })).body.id;
    if (who === "ali") vanA = vanId; else vanB = vanId;
    const tripId = (await call("owner", "POST", "/van-sales/trips", { vanId })).body.id;
    assert.equal((await call("owner", "POST", `/van-sales/trips/${tripId}/load`, { lines: [{ stockId: water._id, qty: 50 }] })).status, 200);
    assert.equal((await call("owner", "POST", `/van-sales/trips/${tripId}/depart`, { odometer: 100 })).status, 200);
    // Ali is paid in cash, so the fuel comes out of money the van holds
    const sold = await call(who, "POST", `/van-sales/trips/${tripId}/sell`, { customerId: String(cust._id), items: [{ itemId: water._id, qty }], ...(who === "ali" ? { payNow: { mode: "cash", full: true } } : {}) });
    assert.equal(sold.status, 201, JSON.stringify(sold.data));
    if (who === "ali") assert.equal((await call(who, "POST", `/van-sales/trips/${tripId}/expenses`, { kind: "fuel", amount: 25 })).status, 201);
    assert.equal((await call("owner", "POST", `/van-sales/trips/${tripId}/unload`, { odometer: 160, counts: [{ stockId: water._id, good: 50 - qty, damaged: 0 }] })).status, 200);
    const preview = await call("owner", "GET", `/van-sales/trips/${tripId}/settlement`);
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    const settled = await call("owner", "POST", `/van-sales/trips/${tripId}/settle`, { cashHanded: preview.body.cash.expected, acknowledge: preview.body.warnings.map((w) => w.code) });
    assert.equal(settled.status, 200, JSON.stringify(settled.data));
  }
  const accounts = await call("owner", "GET", "/accounting/accounts/postable");
  const account = accounts.body.find((a) => String(a.category).toUpperCase() === "EXPENSE");
  const bill = await call("owner", "POST", "/vouchers/vouchers", { voucherType: "expense", ledgerBased: true, expenseAccountId: account._id, description: "Tyres", amount: 400, paymentMode: "cash", vanId: vanB, vanExpenseKind: "mechanical" });
  assert.equal(bill.status, 201, JSON.stringify(bill.data));
});

test("the owner reads every figure, costs and office bills included", { skip }, async () => {
  const r = await call("owner", "GET", "/van-sales/analysis/vans");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.body.costHidden, r.body.officeExpenses, r.body.rows.length], [false, "included", 2]);
  const b = r.body.rows.find((x) => x.vanCode === "VAN-B");
  assert.deepEqual([b.netSales, b.office, b.grossMargin, b.km], [20, 400, 10, 60]);
  for (const report of ["expenses", "returns", "trend", "items", "load", "collections", "coverage", "choices"]) {
    const x = await call("owner", "GET", `/van-sales/analysis/${report}`);
    assert.equal(x.status, 200, `${report}: ${JSON.stringify(x.data)}`);
  }
});

test("a storekeeper reads the vans without any figure made from cost", { skip }, async () => {
  const r = await call("keeper", "GET", "/van-sales/analysis/vans");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.body.costHidden, r.body.rows.length], [true, 2]);
  const text = JSON.stringify(r.body);
  for (const f of ["contribution", "grossMargin", "damagedValue"]) assert.equal(text.includes(`"${f}"`), false, f);
});

test("a salesman reads only his own trips, whatever he asks for, with no office bills and no costs", { skip }, async () => {
  const r = await call("ali", "GET", `/van-sales/analysis/vans?salesmanId=${omar._id}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.body.rows.map((x) => x.vanCode), r.body.officeExpenses, r.body.costHidden], [["VAN-A"], "hidden_seller", true]);
  const money = await call("ali", "GET", `/van-sales/analysis/expenses?vanId=${vanB}`);
  assert.deepEqual([money.body.total.net, money.body.rows.length], [0, 0]);
  const choices = await call("ali", "GET", "/van-sales/analysis/choices");
  assert.deepEqual([choices.body.vans.map((v) => v.code), choices.body.salesmen.map((s) => s.name)], [["VAN-A"], ["ali"]]);
});

test("no van permission, no reports; a hostile query is refused cleanly", { skip }, async () => {
  const no = await call("seller", "GET", "/van-sales/analysis/vans");
  assert.deepEqual([no.status, no.code], [403, "PERMISSION_DENIED"]);
  for (const [query, code] of [
    ["vanId=abc", "INVALID_FILTER"], ["salesmanId=%7B%7D", "INVALID_FILTER"], ["from=2026-02-30", "INVALID_DATE"],
    ["from=2020-01-01&to=2026-01-01", "RANGE_TOO_LONG"], ["from=2026-01-02&to=2026-01-01", "INVALID_RANGE"], ["months=13", "INVALID_FILTER"], ["from=2026-01-01&from=2026-01-02", "INVALID_FILTER"],
  ]) {
    const r = await call("owner", "GET", `/van-sales/analysis/trend?${query}`);
    assert.deepEqual([r.status, r.code], [400, code], query);
  }
  const odd = await call("owner", "GET", "/van-sales/analysis/items?by=__proto__");
  assert.deepEqual([odd.status, odd.body.by], [200, "item"]);
});

test("the sales analysis narrows to one van", { skip }, async () => {
  const all = await call("owner", "GET", "/trade-reports/summary?direction=sales&groupBy=party&from=2020-01-01&to=2099-01-01");
  const one = await call("owner", "GET", `/trade-reports/summary?direction=sales&groupBy=party&from=2020-01-01&to=2099-01-01&vanId=${vanB}`);
  assert.equal(one.status, 200, JSON.stringify(one.data));
  assert.deepEqual([all.body.totals.net, one.body.totals.net], [100, 20]);
  const lines = await call("owner", "GET", `/trade-reports/register?direction=sales&from=2020-01-01&to=2099-01-01&vanId=${vanA}`);
  assert.deepEqual([lines.body.totals.lines, lines.body.totals.net], [1, 80]);
  assert.equal((await call("owner", "GET", "/trade-reports/summary?direction=sales&vanId=x")).status, 400);
});
