// Money under real concurrency, over HTTP against a spawned server: several requests that touch the SAME customer,
// vendor or stock item, fired at the exact same moment with Promise.all (not mocked, not sequential). Every one of
// them must either land correctly or be refused and retried - none may be silently lost. This is what proves (or
// disproves) the read-then-write races described in the security plan: `updatePartyBalanceAndLog` /
// `reversePartyBalanceAndLog` (services/orderPurchase/transactionService.js) and `adjustPartyCashBalance`
// (services/financial/financialService.js) read a party's cashBalance, add to it in JS, then write the new value
// back; `processTransactionStock` / `reverseTransactionStock` (services/stock/stockService.js) do the same for
// `Stock.currentStock`. Each call runs inside a real Mongo multi-document transaction (`withTransactionSession`),
// which DOES stop one transaction from silently overwriting another's commit - but only if the losing side is
// retried; `withTransactionSession` has no retry (unlike `FinancialService.withTransactionRetry`, which vouchers
// already use), so today the losing side of a genuine conflict fails with a raw MongoServerError instead of
// quietly succeeding on the next attempt.
//
//   node --require ./utils/testSetup.js --test services/__tests__/moneyRaceHttp.test.js
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

let child, M;
let logs = "";
const S = {};

async function call(method, url, { body, token = S.token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode };
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
    CreditLog: require("../../models/modules/CreditLog"),
    DebitLog: require("../../models/modules/DebitLog"),
    InventoryMovement: require("../../models/modules/inventoryMovementModel"),
    Transaction: require("../../models/modules/transactionModel"),
  };
  await mongoose.connection.syncIndexes();
  const deadline = Date.now() + 60000;
  for (;;) {
    try { const h = await fetch(`${BASE}/health`); if (h.ok && (await h.json()).ready !== false) break; } catch (_) { /* not yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 400));
  }

  await new M.Admin({ name: "Boss", email: "boss@race.test", password: "12312312", type: "super_admin", status: "active", isActive: true }).save();
  const login = await call("POST", "/login", { body: { email: "boss@race.test", password: "12312312" }, token: null });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  S.token = login.body.tokens.accessToken;
  await call("GET", "/accounting/chart"); // opens the chart: posting on, accounts mapped, UAE starter tax codes provisioned
  S.std = (await call("GET", "/accounting/tax-codes")).body.find((c) => c.kind === "standard");
  assert.ok(S.std, "the standard tax code was provisioned");

  S.customer = String((await new M.Customer({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", paymentTerms: "Net 30", creditLimit: 1e7, trnNumber: "100999888700003", billingAddress: "Deira" }).save())._id);
  S.vendor = String((await new M.Vendor({ vendorId: "V1", vendorName: "Gulf Mills", contactPerson: "x", address: "y", trnNO: "100555444300003", paymentTerms: "Net 30" }).save())._id);
  S.stock = String((await new M.Stock({ itemId: "RICE5", sku: "RICE5", itemName: "Rice 5kg", category: new mongoose.Types.ObjectId(), currentStock: 0 }).save())._id);
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

// Fires `fn(i)` for i in [0,n) all at once, and separates the ones that succeeded (an approval answers 200, a create 201)
// from the ones a conflict refused. A refusal must be a clean, named answer a person can act on - never a raw 500.
async function fireAll(n, fn) {
  const results = await Promise.all(Array.from({ length: n }, (_, i) => fn(i).catch((e) => ({ thrown: String(e?.message || e) }))));
  const isOk = (r) => r.status === 200 || r.status === 201;
  const ok = results.filter(isOk);
  const refused = results.filter((r) => r.status && !isOk(r));
  const thrown = results.filter((r) => r.thrown);
  return { results, ok, refused, thrown };
}
const summary = ({ ok, refused }) => `${ok.length} landed, ${refused.length} refused ${JSON.stringify(refused.reduce((m, r) => ((m[`${r.status} ${r.code || ""}`.trim()] = (m[`${r.status} ${r.code || ""}`.trim()] || 0) + 1), m), {}))}`;
// what a conflict that could not get its turn must look like: said in words, retryable, and nothing written
const cleanRefusal = (r) => r.status === 409 && r.code === "WRITE_CONFLICT";

const line = (qty = 1, price = 100) => ({ itemId: S.stock, description: "Rice 5kg", qty, price, rate: price, vatPercent: 5, taxCodeId: S.std._id });
const sale = () => call("POST", "/transactions/transactions", { body: { type: "sales_order", partyId: S.customer, partyType: "Customer", partyTypeRef: "Customer", createdBy: "tester", items: [line()] } });
const purchase = (qty = 10) => call("POST", "/transactions/transactions", { body: { type: "purchase_order", partyId: S.vendor, partyType: "Vendor", partyTypeRef: "Vendor", createdBy: "tester", items: [line(qty, 10)] } });
const approve = (id) => call("PATCH", `/transactions/transactions/${id}/process`, { body: { action: "approve" } });

test("20 sales approved against the SAME customer at the exact same moment: the balance is the exact sum, not one short", { skip }, async () => {
  const N = 20;
  // create the drafts first (sequentially, so creation itself is not what we are racing), then approve them all at once:
  // approval is what calls updatePartyBalanceAndLog, the read-then-write under test.
  const drafts = [];
  for (let i = 0; i < N; i++) {
    const d = await sale();
    assert.equal(d.status, 201, JSON.stringify(d.data));
    drafts.push(d.body._id);
  }
  const before = await M.Customer.findById(S.customer).select("cashBalance").lean();

  const fired = await fireAll(N, (i) => approve(drafts[i]));
  const { ok, refused, thrown } = fired;
  assert.deepEqual(thrown, [], "a write conflict must come back as a clean HTTP answer, never an unhandled exception");
  // A writer that could not get its turn is told so in words (409 WRITE_CONFLICT, nothing written); never a bare 500.
  assert.deepEqual(refused.filter((r) => !cleanRefusal(r)).map((r) => `${r.status} ${r.code}`), [], `an unexplained failure (${summary(fired)})`);
  assert.equal(ok.length + refused.length, N, "every request was answered");

  const after = await M.Customer.findById(S.customer).select("cashBalance").lean();
  const trulyApproved = await M.Transaction.countDocuments({ _id: { $in: drafts }, status: "APPROVED" });
  assert.equal(trulyApproved, ok.length, `the database agrees with what the server said it approved (${summary(fired)})`);
  assert.ok(trulyApproved >= 1, "at least one of them got through");
  // each sale is 100 + 5% VAT = 105, and a sale takes the customer's balance 105 further below zero (they owe it)
  assert.equal(after.cashBalance - before.cashBalance, -105 * trulyApproved, `the balance moved by exactly ${trulyApproved} x -105, not drifted by a lost update (${summary(fired)})`);

  // and the CreditLog rows agree: one row per approved sale, no more, no fewer (a lost update with no error would show here as a missing row)
  const logCount = await M.CreditLog.countDocuments({ customerId: S.customer, type: "sales_order" });
  assert.equal(logCount, trulyApproved, "one CreditLog row per approved sale - none silently skipped, none duplicated");
});

test("20 purchases of the SAME item approved at once: stock lands on the exact total, every movement chains to the one before it", { skip }, async () => {
  const N = 20;
  const drafts = [];
  for (let i = 0; i < N; i++) {
    const d = await purchase(5);
    assert.equal(d.status, 201, JSON.stringify(d.data));
    drafts.push(d.body._id);
  }
  const before = (await M.Stock.findById(S.stock).select("currentStock").lean()).currentStock;

  const fired = await fireAll(N, (i) => approve(drafts[i]));
  assert.deepEqual(fired.thrown, [], "a write conflict must come back as a clean HTTP answer, never an unhandled exception");
  assert.deepEqual(fired.refused.filter((r) => !cleanRefusal(r)).map((r) => `${r.status} ${r.code}`), [], `an unexplained failure (${summary(fired)})`);

  const trulyApproved = await M.Transaction.countDocuments({ _id: { $in: drafts }, status: "APPROVED" });
  assert.equal(trulyApproved, fired.ok.length, `the database agrees with what the server said it approved (${summary(fired)})`);
  const after = (await M.Stock.findById(S.stock).select("currentStock").lean()).currentStock;
  assert.equal(after - before, trulyApproved * 5, `stock moved by exactly 5 x the number that truly ended up APPROVED - nothing lost, nothing double-counted (${summary(fired)})`);

  // no two movements for this item may claim the same previousStock (that would mean one overwrote the other's view)
  const moves = await M.InventoryMovement.find({ stockId: S.stock, eventType: "PURCHASE_RECEIVE" }).select("previousStock newStock").sort({ previousStock: 1 }).lean();
  const seen = new Set();
  for (const m of moves) {
    assert.ok(!seen.has(m.previousStock), `two movements both started from previousStock=${m.previousStock} - one was computed from stale data`);
    seen.add(m.previousStock);
    assert.equal(m.newStock - m.previousStock, 5, "each movement's own before/after is internally consistent");
  }
});

test("a sale and a receipt against the SAME customer at once (two different files' balance code, same document): the balance reflects both", { skip }, async () => {
  const d = await sale();
  assert.equal(d.status, 201);
  const before = (await M.Customer.findById(S.customer).select("cashBalance").lean()).cashBalance;

  const [approved, receipt] = await Promise.all([
    approve(d.body._id), // transactionService.updatePartyBalanceAndLog: -105
    call("POST", "/vouchers/vouchers", { body: { voucherType: "receipt", customerId: S.customer, totalAmount: 50, date: new Date().toISOString().slice(0, 10), paymentMode: "cash" } }), // financialService.adjustPartyCashBalance: +50
  ]);
  assert.ok(approved.status === 200 || cleanRefusal(approved), `the approval: ${approved.status} ${JSON.stringify(approved.data)}`);
  assert.ok(receipt.status === 201 || cleanRefusal(receipt), `the receipt: ${receipt.status} ${JSON.stringify(receipt.data)}`);

  const saleLanded = approved.status === 200;
  const receiptLanded = receipt.status === 201;
  const after = (await M.Customer.findById(S.customer).select("cashBalance").lean()).cashBalance;
  const expected = before + (saleLanded ? -105 : 0) + (receiptLanded ? 50 : 0);
  assert.equal(after, expected, "both of two concurrent writers' effects are reflected - neither silently overwrote the other's commit");
});

// No race at all: the on-account receipt used to clamp the party's signed balance at zero, so a customer who owed 315 and paid
// 50 on account showed 0 (not -265) - the debt was erased - and deleting that receipt could not bring it back.
test("an on-account receipt moves what a customer owes by exactly its amount, and deleting it puts it back", { skip }, async () => {
  const bal = async () => (await M.Customer.findById(S.customer).select("cashBalance").lean()).cashBalance;
  const owed = await bal();
  assert.ok(owed < 0, `the customer owes something by now (${owed})`);

  const r = await call("POST", "/vouchers/vouchers", { body: { voucherType: "receipt", customerId: S.customer, totalAmount: 50, date: new Date().toISOString().slice(0, 10), paymentMode: "cash" } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(await bal(), owed + 50, "paying 50 on account leaves them owing 50 less - not nothing");

  const gone = await call("DELETE", `/vouchers/vouchers/${r.body._id || r.body.voucher?._id}`);
  assert.ok(gone.status === 200 || gone.status === 204, `delete: ${gone.status} ${JSON.stringify(gone.data)}`);
  assert.equal(await bal(), owed, "and taking the receipt away restores exactly what was owed");
});
