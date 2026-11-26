// The van slip over real HTTP against a spawned strict server: a sale answers with its slip (code, unit, reference, van,
// payment, containers), the trip lists its invoices and prints any of them again with the same slip, another salesman's
// trip and another trip's invoice are refused, and a reference that is not text is refused before anything is sold.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_vsl_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const PORT = 4330 + Math.floor(Math.random() * 180);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";
const CODE = "vanslip";

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

let drink, tripId, otherTripId, cust, sold;
const sales = () => as(CODE, () => M.Transaction.countDocuments({ type: "sales_order", "vanTripRef.tripId": { $exists: true } }));

test("setup: an owner, two salesmen with their own vans, an item with a barcode and a unit, a customer with an address", { skip }, async () => {
  await Org.create({ legalName: "Van Slip Foods LLC", code: CODE, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "internal", moduleOverrides: { vansales: true } });
  await person(CODE, "owner", { type: "super_admin" });
  const role = await call("owner", "POST", "/access/roles", { key: "van_salesman", name: "Van salesman", description: "Sells from a van", rank: 30, permissions: ["vansales.sell"] });
  assert.equal(role.status, 201, JSON.stringify(role.data));
  const ali = await person(CODE, "ali", { type: "viewer", roleKey: "van_salesman" });
  const omar = await person(CODE, "omar", { type: "viewer", roleKey: "van_salesman" });

  const nos = await as(CODE, () => M.UOM.create({ unitName: "Numbers", shortCode: "NOS", category: "Quantity" }));
  const cat = await call("owner", "POST", "/categories/categories", { name: "Drinks" });
  const vendor = await call("owner", "POST", "/vendors/vendors", { vendorName: "Wholesale Co", contactPerson: "x", address: "Dubai", paymentTerms: "Net 30" });
  const made = await call("owner", "POST", "/stock/stock", { categoryId: cat.body.category._id, unitOfMeasure: String(nos._id), origin: "UAE", brand: "x", sku: "C4APPLE", barcodeQrCode: "5056569902274", itemName: "C4 Apple Zero 500ml", salesPrice: 14 });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  drink = made.body.stock;
  const buy = await call("owner", "POST", "/transactions/transactions", { type: "purchase_order", partyId: vendor.body._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: drink._id, description: drink.itemName, qty: 200, price: 8, rate: 8, vatPercent: 0 }] });
  assert.equal((await call("owner", "PATCH", `/transactions/transactions/${buy.body._id}/process`, { action: "approve" })).status, 200);
  cust = await as(CODE, () => M.Customer.create({ customerId: "C1", customerName: "Gymnation LLC", contactPerson: "Noor", phone: "0501111111", billingAddress: "Unit 203, Control Tower", city: "Dubai", shippingAddress: "Dubai", paymentTerms: "Net 30", creditLimit: 99999 }));
  for (const [who, code] of [[ali, "van-1"], [omar, "van-2"]]) {
    const vanId = (await call("owner", "POST", "/van-sales/vans", { code, name: `Van Cash ${code}`, salesmanId: String(who._id) })).body.id;
    const id = (await call("owner", "POST", "/van-sales/trips", { vanId })).body.id;
    assert.equal((await call("owner", "POST", `/van-sales/trips/${id}/load`, { lines: [{ stockId: drink._id, qty: 80 }] })).status, 200);
    assert.equal((await call("owner", "POST", `/van-sales/trips/${id}/depart`)).status, 200);
    if (who === ali) tripId = id; else otherTripId = id;
  }
});

test("a sale answers with its slip: the barcode and unit, the customer's reference and address, the van, the money taken", { skip }, async () => {
  const r = await call("ali", "POST", `/van-sales/trips/${tripId}/sell`, {
    customerId: String(cust._id), reference: "  LPO   4471 ", items: [{ itemId: drink._id, qty: 48 }], payNow: { mode: "cash", amount: 100 },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  sold = r.body.invoice;
  assert.equal(sold.lpono, "LPO 4471", "the reference is kept as typed, its spacing tidied");
  const s = r.body.slip;
  assert.ok(s, "the sale answers with its slip");
  assert.equal(s.invoice.number, sold.transactionNo);
  assert.equal(s.invoice.reference, "LPO 4471");
  assert.equal(s.trip.vanName, "Van Cash van-1");
  assert.equal(s.trip.salesmanName, "ali");
  assert.equal(s.customer.address, "Unit 203, Control Tower, Dubai");
  assert.equal(s.customer.phone, "0501111111");
  assert.deepEqual(s.lines.map((l) => [l.code, l.unit, l.qty, l.price]), [["5056569902274", "NOS", 48, 14]]);
  assert.equal(s.totals.quantity, 48);
  assert.equal(s.totals.subTotal, 672);
  assert.equal(s.totals.total, sold.totalAmount);
  assert.equal(s.payment.mode, "cash");
  assert.equal(s.payment.received, 100);
  assert.equal(s.payment.balanceDue, Math.round((sold.totalAmount - 100) * 100) / 100);
  const text = JSON.stringify(s);
  for (const w of ["creditLimit", "purchasePrice", "cogsAmount", "unitCost", "allocations", "cashAccountId"]) assert.equal(text.includes(`"${w}"`), false, w);
});

test("the trip lists its invoices and prints any again: the same slip, as the money stands now", { skip }, async () => {
  const list = await call("ali", "GET", `/van-sales/trips/${tripId}/invoices`);
  assert.equal(list.status, 200, JSON.stringify(list.data));
  assert.deepEqual(list.body.map((i) => [i.number, i.customerName]), [[sold.transactionNo, "Gymnation LLC"]]);
  const again = await call("ali", "GET", `/van-sales/trips/${tripId}/invoices/${sold._id}/slip`);
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.body.invoice.number, sold.transactionNo);
  assert.equal(again.body.payment.received, 100);

  // a later collection against it shows on the next print
  const more = await call("ali", "POST", `/van-sales/trips/${tripId}/collect`, { customerId: String(cust._id), amount: 50, mode: "cash", invoiceIds: [String(sold._id)] });
  assert.equal(more.status, 201, JSON.stringify(more.data));
  const later = await call("ali", "GET", `/van-sales/trips/${tripId}/invoices/${sold._id}/slip`);
  assert.equal(later.body.payment.received, 150);
});

test("another salesman's trip is refused; an invoice of another trip, or none at all, is not found", { skip }, async () => {
  assert.equal((await call("omar", "GET", `/van-sales/trips/${tripId}/invoices`)).status, 403);
  assert.equal((await call("omar", "GET", `/van-sales/trips/${tripId}/invoices/${sold._id}/slip`)).status, 403);
  const elsewhere = await call("omar", "GET", `/van-sales/trips/${otherTripId}/invoices/${sold._id}/slip`);
  assert.equal(elsewhere.status, 404);
  assert.equal(elsewhere.code, "VAN_INVOICE_NOT_FOUND");
  assert.equal((await call("ali", "GET", `/van-sales/trips/${tripId}/invoices/not-an-id/slip`)).code, "VAN_INVOICE_NOT_FOUND");
  assert.equal((await call("owner", "GET", `/van-sales/trips/${tripId}/invoices/${sold._id}/slip`)).status, 200, "a supervisor prints any trip's slip");
});

test("a reference that is not a short line of text is refused before anything is sold", { skip }, async () => {
  const before = await sales();
  for (const reference of [{ $gt: "" }, ["LPO"], "x".repeat(41)]) {
    const r = await call("ali", "POST", `/van-sales/trips/${tripId}/sell`, { customerId: String(cust._id), reference, items: [{ itemId: drink._id, qty: 1 }] });
    assert.equal(r.status, 400, JSON.stringify(r.data));
    assert.equal(r.code, "REFERENCE_INVALID");
  }
  assert.equal(await sales(), before, "nothing sold");
  const plain = await call("ali", "POST", `/van-sales/trips/${tripId}/sell`, { customerId: String(cust._id), items: [{ itemId: drink._id, qty: 1 }] });
  assert.equal(plain.status, 201, JSON.stringify(plain.data));
  assert.equal(plain.body.slip.invoice.reference, "");
  assert.equal(plain.body.slip.payment.mode, "credit", "nothing taken: a credit sale");
});

test("the customer pick list carries the address the slip prints", { skip }, async () => {
  const list = await call("owner", "GET", "/van-sales/customers");
  assert.equal(list.status, 200);
  assert.equal(list.body.find((c) => c.code === "C1").address, "Unit 203, Control Tower, Dubai");
});
