// Two organisations that actually TRADE, over HTTP against a strict server. Each is given the same customer
// code, the same item code and SKU, the same supplier tax number, and posts its own first purchase and sale, so
// their documents carry the same numbers. Neither may see, count, post to or reach the other, and each one's books
// must balance on their own. This is what the whole tenancy project is for.
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
const PASSWORD = "12312312";

let child, M, Org, ctx;
let logs = "";
const T = {}; // per organisation: token, ids
const ORGS = ["alpha", "bravo"];

async function call(method, url, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode };
}
const as = (code, fn) => ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const raw = (fn) => ctx.runUnscoped("a test inspecting what is really stored, across organisations", fn);
const api = (org, method, url, body) => call(method, url, { token: T[org].token, body });
const list = (r) => (Array.isArray(r.body) ? r.body : r.body?.stocks || r.body?.customers || r.body?.transactions || r.body?.rows || r.body?.data || []);

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
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
  };
  Org = require("../core/organisationService");
  ctx = require("../../utils/tenantContext");
  await mongoose.connection.syncIndexes();
  const deadline = Date.now() + 60000;
  for (;;) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) { /* not up yet */ }
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

test("two organisations are created, each with its own chart of accounts, and neither disturbs the other", { skip }, async () => {
  for (const code of ORGS) {
    const made = await Org.create({ legalName: `${code} Trading`, code, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" });
    assert.equal(made.provisioning.steps.chart.state, "done", `${code}: the chart of accounts is provisioned now that the ledger is separated by organisation\n${JSON.stringify(made.provisioning.steps.chart)}`);
    assert.equal(made.provisioning.complete, true, `${code}: everything provisioned`);
  }
  const counts = {};
  for (const code of ORGS) counts[code] = await as(code, async () => ({ accounts: await mongoose.models.LedgerAccount.countDocuments(), groups: await mongoose.models.AccountGroup.countDocuments() }));
  assert.ok(counts.alpha.accounts > 10 && counts.alpha.groups > 5, "a real chart");
  assert.deepEqual(counts.alpha, counts.bravo, "each got the same starter chart, of its own");
  const all = await raw(() => mongoose.models.LedgerAccount.countDocuments());
  assert.equal(all, counts.alpha.accounts + counts.bravo.accounts, "two charts, no account shared or reassigned");
});

test("each organisation has a person who signs in and their own tax codes", { skip }, async () => {
  for (const code of ORGS) {
    await as(code, () => new M.Admin({ name: `${code}-boss`, email: `${code}-boss@test.uae`, password: PASSWORD, type: "super_admin", status: "active", isActive: true }).save());
    const r = await call("POST", "/login", { body: { email: `${code}-boss@test.uae`, password: PASSWORD } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    T[code] = { token: r.body.tokens.accessToken };
    const codes = await api(code, "GET", "/accounting/tax-codes");
    T[code].std = codes.body.find((c) => c.kind === "standard");
    assert.ok(T[code].std, `${code} has a standard-rated tax code`);
  }
  assert.notEqual(T.alpha.std._id, T.bravo.std._id, "the tax codes are each organisation's own rows");
});

test("both organisations can hold the SAME customer code, supplier tax number, item code and SKU", { skip }, async () => {
  for (const code of ORGS) {
    await as(code, async () => {
      T[code].vendor = String((await new M.Vendor({ vendorId: "V1", vendorName: "Mill", contactPerson: "x", address: "y", trnNO: "100555444300003", paymentTerms: "Net 30" }).save())._id);
      T[code].customer = String((await new M.Customer({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", paymentTerms: "Net 30", creditLimit: 100000, trnNumber: "100999888700003", billingAddress: "Deira" }).save())._id);
      T[code].stock = String((await new M.Stock({ itemId: "RICE5", sku: "RICE5", itemName: "Rice 5kg", category: new mongoose.Types.ObjectId() }).save())._id);
    });
  }
  assert.equal(await raw(() => M.Customer.countDocuments({ customerId: "C1" })), 2, "one each, same code");
  assert.equal(await raw(() => M.Stock.countDocuments({ sku: "RICE5" })), 2);
  assert.equal(await raw(() => M.Vendor.countDocuments({ trnNO: "100555444300003" })), 2);
  // ...and one organisation still cannot repeat its own
  await assert.rejects(() => as("alpha", () => new M.Stock({ itemId: "RICE5", sku: "OTHER", itemName: "Dup", category: new mongoose.Types.ObjectId() }).save()), (e) => e.code === 11000);
});

const order = (org, type, party, partyType, qty, price) =>
  api(org, "POST", "/transactions/transactions", {
    type, partyId: party, partyType, partyTypeRef: partyType, createdBy: "tester",
    items: [{ itemId: T[org].stock, description: "Rice 5kg", qty, price, rate: price, vatPercent: 5, taxCodeId: T[org].std._id }],
  });
const approve = (org, id) => api(org, "PATCH", `/transactions/transactions/${id}/process`, { action: "approve" });

test("each organisation posts its own first purchase and sale, and they carry the same document numbers", { skip }, async () => {
  const plan = { alpha: { buy: [100, 10], sell: [10, 20] }, bravo: { buy: [40, 5], sell: [4, 8] } };
  for (const code of ORGS) {
    const [bq, bp] = plan[code].buy;
    const po = await order(code, "purchase_order", T[code].vendor, "Vendor", bq, bp);
    assert.equal(po.status, 201, `${code} PO: ${JSON.stringify(po.data)}`);
    T[code].poNo = po.body.transactionNo;
    assert.equal((await approve(code, po.body._id)).status, 200, `${code} PO approval`);
    T[code].po = po.body._id;

    const [sq, sp] = plan[code].sell;
    const so = await order(code, "sales_order", T[code].customer, "Customer", sq, sp);
    assert.equal(so.status, 201, `${code} SO: ${JSON.stringify(so.data)}`);
    T[code].soNo = so.body.transactionNo;
    assert.equal((await approve(code, so.body._id)).status, 200, `${code} SO approval: `);
    T[code].so = so.body._id;
  }
  assert.match(T.alpha.poNo, /^PO-\d{4}-0001$/);
  assert.equal(T.alpha.poNo, T.bravo.poNo, "both organisations issue purchase order number 1");
  assert.equal(T.alpha.soNo, T.bravo.soNo, "and sales order number 1");
  assert.equal(await raw(() => M.Transaction.countDocuments({ transactionNo: T.alpha.poNo })), 2, "two rows share that number, one per organisation");
});

test("each organisation's books are its own and balance by themselves", { skip }, async () => {
  const inventory = {};
  for (const code of ORGS) {
    const tb = await api(code, "GET", "/vouchers/reports/financial?reportType=trial_balance");
    assert.equal(tb.status, 200, JSON.stringify(tb.data));
    assert.equal(tb.body.report.summary.isBalanced, true, `${code}'s ledger balances`);
    const rows = tb.body.report.trialBalance;
    inventory[code] = rows.find((r) => r.accountName === "Inventory Stock")?.balance;
    assert.ok(rows.find((r) => r.accountName === "Vendor - Mill"), `${code} has its own supplier account`);
  }
  // alpha bought 100 at 10 and sold 10; bravo bought 40 at 5 and sold 4: different stock value, never a sum
  assert.ok(inventory.alpha > 0 && inventory.bravo > 0);
  assert.notEqual(inventory.alpha, inventory.bravo, "different books, not a shared total");
  assert.equal(inventory.alpha, 900, "alpha: 90 units left at cost 10");
  assert.equal(inventory.bravo, 180, "bravo: 36 units left at cost 5");
});

test("stock, customers and documents are each organisation's own", { skip }, async () => {
  const stock = { alpha: 90, bravo: 36 };
  for (const code of ORGS) {
    const rows = list(await api(code, "GET", "/stock/stock"));
    assert.equal(rows.length, 1, `${code} sees one item`);
    assert.equal(rows[0].quantity ?? rows[0].qty ?? rows[0].currentStock, stock[code], `${code}'s own quantity`);
    const docs = list(await api(code, "GET", "/transactions/transactions?limit=100"));
    assert.equal(docs.length, 2, `${code} sees only its own two documents`);
    assert.ok(docs.every((d) => [T[code].po, T[code].so].includes(d._id)), `${code} sees nobody else's`);
    assert.equal(list(await api(code, "GET", "/customers/customers")).length, 1);
  }
});

test("neither organisation can reach, or build on, the other's documents or items", { skip }, async () => {
  // by exact id
  assert.equal((await api("alpha", "GET", `/transactions/transactions/${T.bravo.so}`)).status, 404);
  assert.equal((await api("bravo", "GET", `/transactions/transactions/${T.alpha.po}`)).status, 404);
  // posting against the other's document is refused and changes nothing
  const before = await raw(() => M.Transaction.findById(T.bravo.so).lean());
  const attempt = await api("alpha", "PATCH", `/transactions/transactions/${T.bravo.so}/process`, { action: "cancel" });
  assert.ok(attempt.status >= 400 && attempt.status < 500, `refused, got ${attempt.status}`);
  assert.equal((await raw(() => M.Transaction.findById(T.bravo.so).lean())).status, before.status, "bravo's invoice is untouched");
  // building an order out of the other's item or customer is refused and nothing is created
  const stray = await api("bravo", "POST", "/transactions/transactions", {
    body: { type: "sales_order", partyId: T.alpha.customer, partyType: "Customer", partyTypeRef: "Customer", createdBy: "x", items: [{ itemId: T.alpha.stock, description: "x", qty: 1, price: 1, rate: 1 }] },
  });
  assert.ok(stray.status >= 400 && stray.status < 500, `an order made of alpha's customer and item was refused, got ${stray.status}`);
  assert.equal(await raw(() => M.Transaction.countDocuments({ companyId: "bravo" })), 2, "bravo still has only its two");
  // and the other's tax code cannot be borrowed
  const borrowed = await api("bravo", "POST", "/transactions/transactions", {
    body: { type: "purchase_order", partyId: T.bravo.vendor, partyType: "Vendor", partyTypeRef: "Vendor", createdBy: "x", items: [{ itemId: T.bravo.stock, description: "x", qty: 1, price: 1, rate: 1, vatPercent: 5, taxCodeId: T.alpha.std._id }] },
  });
  assert.ok(borrowed.status >= 400 || !borrowed.body?.items?.[0]?.taxCodeId, "alpha's tax code is not accepted as bravo's");
});
