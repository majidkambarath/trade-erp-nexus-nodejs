// Branches over HTTP against a strict server: each branch numbers its own documents, a person in a branch sees only
// that branch's documents, a head office sees every branch (or the one it chooses with X-Branch), what an approval posts
// carries the document's own branch, and the status route tells a screen where the person is and what they can switch to.
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

let child, M, Org, Branches, ctx;
let logs = "";
const T = {}; // per person: token
const ID = {}; // ids made along the way

async function call(method, url, { body, token, headers: extra } = {}) {
  const headers = { ...(extra || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode };
}
const as = (code, fn) => ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const raw = (fn) => ctx.runUnscoped("a test inspecting what is really stored, across branches", fn);
const api = (who, method, url, body, branch) => call(method, url, { token: T[who], body, headers: branch ? { "X-Branch": branch } : undefined });
const list = (r) => (Array.isArray(r.body) ? r.body : r.body?.transactions || r.body?.rows || r.body?.data || []);
const order = (who, type, party, partyType, qty, price, branch) =>
  api(who, "POST", "/transactions/transactions", {
    type, partyId: party, partyType, partyTypeRef: partyType, createdBy: "tester",
    items: [{ itemId: ID.stock, description: "Rice 5kg", qty, price, rate: price, vatPercent: 5, taxCodeId: ID.tax }],
  }, branch);
const nos = (r) => list(r).map((d) => d.transactionNo).sort();

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = {
    Admin: require("../../models/core/adminModel"),
    Branch: require("../../models/core/branchModel"),
    Organisation: require("../../models/core/organisationModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Stock: require("../../models/modules/stockModel"),
    Transaction: require("../../models/modules/transactionModel"),
    InventoryMovement: require("../../models/modules/inventoryMovementModel"),
    LedgerEntry: require("../../models/modules/financial/financialModels").LedgerEntry,
  };
  Org = require("../core/organisationService");
  Branches = require("../core/branchService");
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

test("an organisation with a head office and two branches, a person in each, and something to trade", { skip }, async () => {
  const made = await Org.create({ legalName: "Multi Branch Trading", code: "multi", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" });
  assert.equal(made.provisioning.complete, true);
  await as("multi", () => Branches.create({ code: "shj", name: "Sharjah Warehouse", city: "Sharjah" }, {}, { by: "test" }));
  await as("multi", () => Branches.create({ code: "dxb", name: "Dubai Showroom", city: "Dubai" }, {}, { by: "test" }));
  const people = [["ho", "super_admin", "main"], ["shj", "admin", "shj"], ["dxb", "operator", "dxb"]];
  for (const [who, type, branchId] of people) {
    await as("multi", () => new M.Admin({ name: `${who} person`, email: `${who}@multi.test`, password: PASSWORD, type, branchId, status: "active", isActive: true }).save());
    const r = await call("POST", "/login", { body: { email: `${who}@multi.test`, password: PASSWORD } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    T[who] = r.body.tokens.accessToken;
  }
  ID.tax = (await api("ho", "GET", "/accounting/tax-codes")).body.find((c) => c.kind === "standard")._id;
  await as("multi", async () => {
    ID.customer = String((await new M.Customer({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", paymentTerms: "Net 30", creditLimit: 100000, trnNumber: "100999888700003", billingAddress: "Deira" }).save())._id);
    ID.vendor = String((await new M.Vendor({ vendorId: "V1", vendorName: "Mill", contactPerson: "x", address: "y", trnNO: "100555444300003", paymentTerms: "Net 30" }).save())._id);
    ID.stock = String((await new M.Stock({ itemId: "RICE5", sku: "RICE5", itemName: "Rice 5kg", category: new mongoose.Types.ObjectId() }).save())._id);
  });
});

test("each branch numbers its own documents, and the organisation never repeats a number", { skip }, async () => {
  const po = await order("ho", "purchase_order", ID.vendor, "Vendor", 100, 10);
  assert.equal(po.status, 201, JSON.stringify(po.data));
  assert.match(po.body.transactionNo, /^PO-\d{4}-0001$/, "the head office keeps the plain format");
  ID.po = po.body._id;

  const a = await order("shj", "sales_order", ID.customer, "Customer", 5, 20);
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.match(a.body.transactionNo, /^SHJ-SO-\d{4}-0001$/, "a branch carries its code");
  const b = await order("shj", "sales_order", ID.customer, "Customer", 6, 20);
  assert.match(b.body.transactionNo, /^SHJ-SO-\d{4}-0002$/);
  const c = await order("dxb", "sales_order", ID.customer, "Customer", 2, 20);
  assert.match(c.body.transactionNo, /^DXB-SO-\d{4}-0001$/, "another branch counts from one again, under its own code");
  const d = await order("ho", "sales_order", ID.customer, "Customer", 1, 20);
  assert.match(d.body.transactionNo, /^SO-\d{4}-0001$/);
  Object.assign(ID, { shj1: a.body._id, shj2: b.body._id, dxb1: c.body._id, ho1: d.body._id });

  const all = await raw(() => M.Transaction.find({ companyId: "multi" }).select("transactionNo branchId").lean());
  assert.equal(new Set(all.map((x) => x.transactionNo)).size, all.length, "no number is used twice in the organisation");
  assert.deepEqual(Object.fromEntries(all.map((x) => [x.transactionNo.replace(/\d{4}-/g, "Y-"), x.branchId])), { "PO-Y-0001": "main", "SHJ-SO-Y-0001": "shj", "SHJ-SO-Y-0002": "shj", "DXB-SO-Y-0001": "dxb", "SO-Y-0001": "main" });
});

test("a person in a branch sees only that branch's documents, by list, by number and by id", { skip }, async () => {
  const mine = nos(await api("shj", "GET", "/transactions/transactions?limit=100"));
  assert.deepEqual(mine.map((n) => n.replace(/\d{4}-/, "Y-")), ["SHJ-SO-Y-0001", "SHJ-SO-Y-0002"]);
  assert.equal((await api("shj", "GET", `/transactions/transactions/${ID.ho1}`)).status, 404, "head office's document, by its exact id");
  assert.equal((await api("shj", "GET", `/transactions/transactions/${ID.dxb1}`)).status, 404, "another branch's document");
  assert.equal((await api("shj", "GET", `/transactions/transactions/${ID.shj1}`)).status, 200);
  assert.equal((await api("dxb", "GET", `/transactions/transactions/${ID.shj1}`)).status, 404);
  const attempt = await api("shj", "PATCH", `/transactions/transactions/${ID.dxb1}/process`, { action: "cancel" });
  assert.equal(attempt.status, 404, "and cannot be acted on");
  const stored = await raw(() => M.Transaction.findById(ID.dxb1).select("status").lean());
  assert.equal(stored.status, "DRAFT", "untouched");
});

test("a head office sees every branch, or the one it chooses", { skip }, async () => {
  assert.equal(nos(await api("ho", "GET", "/transactions/transactions?limit=100")).length, 5, "every branch, no header");
  assert.equal(nos(await api("ho", "GET", "/transactions/transactions?limit=100", null, "all")).length, 5, "'all' says the same");
  assert.deepEqual(nos(await api("ho", "GET", "/transactions/transactions?limit=100", null, "dxb")).map((n) => n.replace(/\d{4}-/, "Y-")), ["DXB-SO-Y-0001"]);
  assert.equal(nos(await api("ho", "GET", "/transactions/transactions?limit=100", null, "shj")).length, 2);
  assert.equal(nos(await api("ho", "GET", "/transactions/transactions?limit=100", null, "main")).length, 2, "head office's own documents: the purchase order and its sale");
});

test("who may ask for which branch is decided by the server, every time", { skip }, async () => {
  const sneaky = await api("shj", "GET", "/transactions/transactions", null, "main");
  assert.equal(sneaky.status, 403);
  assert.equal(sneaky.code, "BRANCH_NOT_ALLOWED");
  assert.equal((await api("shj", "GET", "/transactions/transactions", null, "dxb")).code, "BRANCH_NOT_ALLOWED");
  assert.equal((await api("shj", "GET", "/transactions/transactions", null, "shj")).status, 200, "repeating their own is fine");
  const missing = await api("ho", "GET", "/transactions/transactions", null, "nowhere");
  assert.equal(missing.status, 403);
  assert.equal(missing.code, "BRANCH_NOT_FOUND");
  assert.equal((await api("ho", "GET", "/transactions/transactions", null, "../etc")).code, "BRANCH_NOT_FOUND");
});

test("a head office working in a branch makes documents for that branch", { skip }, async () => {
  const made = await order("ho", "sales_order", ID.customer, "Customer", 3, 20, "dxb");
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.match(made.body.transactionNo, /^DXB-SO-\d{4}-0002$/, "numbered by the branch it was made for");
  const stored = await raw(() => M.Transaction.findById(made.body._id).select("branchId").lean());
  assert.equal(stored.branchId, "dxb");
  assert.equal(nos(await api("dxb", "GET", "/transactions/transactions?limit=100")).length, 2, "and the branch's own person sees it");
});

test("approving another branch's document from the head office posts it to that document's own branch", { skip }, async () => {
  assert.equal((await api("ho", "PATCH", `/transactions/transactions/${ID.po}/process`, { action: "approve" })).status, 200);
  const approved = await api("ho", "PATCH", `/transactions/transactions/${ID.shj1}/process`, { action: "approve" });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const entries = await raw(() => M.LedgerEntry.find({ companyId: "multi", voucherId: ID.shj1 }).select("branchId").lean());
  assert.ok(entries.length > 0, "the sale posted to the ledger");
  assert.deepEqual([...new Set(entries.map((e) => e.branchId))], ["shj"], "every ledger line carries Sharjah, not head office");
  const moves = await raw(() => M.InventoryMovement.find({ companyId: "multi", referenceId: ID.shj1 }).select("branchId").lean());
  assert.ok(moves.length > 0);
  assert.deepEqual([...new Set(moves.map((m) => m.branchId))], ["shj"], "and so does the stock movement");
  const headOffice = await raw(() => M.LedgerEntry.find({ companyId: "multi", voucherId: ID.po }).select("branchId").lean());
  assert.deepEqual([...new Set(headOffice.map((e) => e.branchId))], ["main"], "head office's own purchase stays head office's");
});

test("the ledger reports follow the branch being worked in", { skip }, async () => {
  const day = (r) => (r.body?.rows || r.body?.entries || r.body?.items || []).map((x) => x.voucherNo).sort();
  const q = "/accounting/reports/day-book?from=2000-01-01&to=2100-01-01&limit=200";
  const everything = day(await api("ho", "GET", q));
  assert.ok(everything.some((n) => /^SHJ-SO-/.test(n)) && everything.some((n) => /^PO-/.test(n)), `head office sees both: ${everything.join(", ")}`);
  const sharjah = day(await api("ho", "GET", q, null, "shj"));
  assert.ok(sharjah.length > 0 && sharjah.every((n) => /^SHJ-/.test(n)), `Sharjah alone: ${sharjah.join(", ")}`);
  const theirs = day(await api("shj", "GET", q));
  assert.deepEqual(theirs, sharjah, "a Sharjah person sees exactly what the head office sees when it chooses Sharjah");
  assert.deepEqual(day(await api("dxb", "GET", q)), [], "Dubai has posted nothing yet");
});

test("the status route says where the person is, whether they can switch, and what they could switch to", { skip }, async () => {
  const ho = (await api("ho", "GET", "/organisation/status")).body;
  assert.equal(ho.branch.code, "main");
  assert.equal(ho.branch.canSwitch, true);
  assert.equal(ho.branch.view, null, "looking at every branch");
  assert.deepEqual(ho.branches.map((b) => b.code), ["main", "dxb", "shj"], "head office first, then by name");
  assert.equal(ho.support.contact, process.env.SUPPORT_CONTACT || process.env.SUPPORT_EMAIL || null);

  const chosen = (await api("ho", "GET", "/organisation/status", null, "shj")).body;
  assert.equal(chosen.branch.code, "shj");
  assert.equal(chosen.branch.view, "shj");
  assert.equal(chosen.branch.name, "Sharjah Warehouse");

  const person = (await api("shj", "GET", "/organisation/status")).body;
  assert.equal(person.branch.code, "shj");
  assert.equal(person.branch.canSwitch, false, "a branch person cannot switch");
  assert.equal(person.branch.isHeadOffice, false);

  await Org.create({ legalName: "Solo Trading", code: "solo", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "standard" });
  await as("solo", () => new M.Admin({ name: "Solo", email: "solo@solo.test", password: PASSWORD, type: "super_admin", status: "active", isActive: true }).save());
  const solo = await call("POST", "/login", { body: { email: "solo@solo.test", password: PASSWORD } });
  const soloStatus = (await call("GET", "/organisation/status", { token: solo.body.tokens.accessToken })).body;
  assert.equal(soloStatus.branches.length, 1);
  assert.equal(soloStatus.branch.name, "Head Office");
  assert.equal(soloStatus.branch.canSwitch, false, "nothing to switch to");
});

test("a switched-off branch cannot be worked in, by its people or by the head office", { skip }, async () => {
  await as("multi", () => M.Branch.updateOne({ code: "dxb" }, { $set: { isActive: false } }));
  const person = await api("dxb", "GET", "/transactions/transactions");
  assert.equal(person.status, 403);
  assert.equal(person.code, "BRANCH_INACTIVE");
  assert.equal((await api("ho", "GET", "/transactions/transactions", null, "dxb")).code, "BRANCH_NOT_FOUND");
  assert.equal(nos(await api("ho", "GET", "/transactions/transactions?limit=100")).length, 6, "its documents are still the organisation's, seen with no branch chosen");
  assert.deepEqual((await api("ho", "GET", "/organisation/status")).body.branches.map((b) => b.code), ["main", "shj"]);
  await as("multi", () => M.Branch.updateOne({ code: "dxb" }, { $set: { isActive: true } }));
  assert.equal((await api("dxb", "GET", "/transactions/transactions")).status, 200);
});

test("a new person's branch has to be a real one", { skip }, async () => {
  const add = (branchId) => api("ho", "POST", "/", { name: "New", email: `new-${branchId}@multi.test`, password: PASSWORD, type: "viewer", branchId });
  const bad = await add("nowhere");
  assert.equal(bad.status, 400);
  assert.equal(bad.code, "BRANCH_NOT_FOUND");
  assert.equal((await add("shj")).status, 201);
  assert.equal((await raw(() => M.Admin.findOne({ email: "new-shj@multi.test" }).lean())).branchId, "shj");
});

test("cheques and cards are left out of the payment options when the plan has no banking", { skip }, async () => {
  const modes = async () => (await api("ho", "GET", "/banking/payment-options")).body.modes;
  assert.deepEqual(await modes(), ["cash", "bank", "transfer", "cheque", "card"]);
  await M.Organisation.updateOne({ code: "multi" }, { $set: { "featureOverrides.banking": false } });
  const off = await api("ho", "GET", "/banking/payment-options");
  assert.equal(off.status, 200, "the voucher forms still load their options");
  assert.deepEqual(off.body.modes, ["cash", "bank", "transfer"]);
  assert.deepEqual(off.body.cards, []);
  assert.equal((await api("ho", "GET", "/banking/banks")).code, "FEATURE_NOT_IN_PLAN", "the banking screens themselves stay behind the feature");
  await M.Organisation.updateOne({ code: "multi" }, { $set: { "featureOverrides.banking": true } });
});
