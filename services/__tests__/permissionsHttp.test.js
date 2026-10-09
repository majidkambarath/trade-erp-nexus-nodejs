// What each role may and may not do, against a strict server with real sign-ins. The refusals are the point: a viewer
// cannot approve, a sales clerk cannot open Finance, an operator cannot change the posting map. Every refusal must be
// the server's own 403 PERMISSION_DENIED, and every allowed call must get past the gate (it may still fail on its
// payload: that is a different answer, and proves the gate let it in).
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
const FAKE = "64b64b64b64b64b64b64b64b"; // an id that matches nothing: a gate that lets it through answers 404, one that does not answers 403

let child, M, Org, ctx;
let logs = "";
const T = {};
const ID = {};

async function call(method, url, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode, details: data?.details };
}
const as = (code, fn) => ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const api = (who, method, url, body) => call(method, url, { token: T[who], body });
const list = (r) => (Array.isArray(r.body) ? r.body : r.body?.transactions || r.body?.rows || r.body?.data || []);

const denied = (r, msg) => {
  assert.equal(r.status, 403, `${msg}: expected 403, got ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
  assert.equal(r.code, "PERMISSION_DENIED", msg);
};
const allowed = (r, msg) => {
  assert.notEqual(r.code, "PERMISSION_DENIED", `${msg}: the gate refused it: ${JSON.stringify(r.data).slice(0, 160)}`);
  assert.notEqual(r.status, 401, msg);
};
const can = async (who, method, url, body) => allowed(await api(who, method, url, body), `${who} ${method} ${url}`);
const cannot = async (who, method, url, body) => denied(await api(who, method, url, body), `${who} ${method} ${url}`);

const order = (who, type, party, partyType, qty, price) =>
  api(who, "POST", "/transactions/transactions", {
    type, partyId: party, partyType, partyTypeRef: partyType, createdBy: "tester",
    items: [{ itemId: ID.stock, description: "Rice 5kg", qty, price, rate: price, vatPercent: 5, taxCodeId: ID.tax }],
  });

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = {
    Admin: require("../../models/core/adminModel"),
    Role: require("../../models/core/roleModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Stock: require("../../models/modules/stockModel"),
    Settings: require("../../models/modules/financial/companySettingsModel"),
    Activity: require("../../models/modules/financial/activityLogModel"),
  };
  Org = require("../core/organisationService");
  ctx = require("../../utils/tenantContext");
  await mongoose.connection.syncIndexes();
  const deadline = Date.now() + 60000;
  for (;;) {
    try { { const h = await fetch(`${BASE}/health`); if (h.ok && (await h.json()).ready !== false) break; } } catch (_) { /* not up yet */ }
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

const ROLES = [["owner", "super_admin"], ["admin", "admin"], ["manager", "manager"], ["accountant", "accountant"], ["operator", "operator"], ["sales", "sales"], ["purchase", "purchase"], ["storekeeper", "storekeeper"], ["viewer", "viewer"]];

test("an organisation with one person in every built-in role, and something to trade", { skip }, async () => {
  const made = await Org.create({ legalName: "Perm Trading", code: "perm", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" });
  assert.equal(made.provisioning.complete, true);
  for (const [who, key] of ROLES) {
    // the five types that existed before roles are signed in by their TYPE alone; the four new ones by an explicit role
    const legacy = ["super_admin", "admin", "manager", "operator", "viewer"].includes(key);
    await as("perm", () => new M.Admin({ name: who, email: `${who}@perm.test`, password: PASSWORD, status: "active", isActive: true, type: legacy ? key : "viewer", ...(legacy ? {} : { roleKey: key }) }).save());
    const r = await call("POST", "/login", { body: { email: `${who}@perm.test`, password: PASSWORD } });
    assert.equal(r.status, 200, `${who}: ${JSON.stringify(r.data)}`);
    T[who] = r.body.tokens.accessToken;
  }
  ID.tax = (await api("owner", "GET", "/accounting/tax-codes")).body.find((c) => c.kind === "standard")._id;
  await as("perm", async () => {
    ID.customer = String((await new M.Customer({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", paymentTerms: "Net 30", creditLimit: 1000000, trnNumber: "100999888700003", billingAddress: "Deira" }).save())._id);
    ID.vendor = String((await new M.Vendor({ vendorId: "V1", vendorName: "Mill", contactPerson: "x", address: "y", trnNO: "100555444300003", paymentTerms: "Net 30" }).save())._id);
    ID.stock = String((await new M.Stock({ itemId: "RICE5", sku: "RICE5", itemName: "Rice 5kg", category: new mongoose.Types.ObjectId() }).save())._id);
  });
  const po = await order("purchase", "purchase_order", ID.vendor, "Vendor", 100, 10);
  assert.equal(po.status, 201, JSON.stringify(po.data));
  ID.po = po.body._id;
  const so = await order("sales", "sales_order", ID.customer, "Customer", 5, 20);
  assert.equal(so.status, 201, JSON.stringify(so.data));
  ID.so = so.body._id;
});

test("a viewer looks at things and changes nothing", { skip }, async () => {
  await can("viewer", "GET", "/transactions/transactions?type=sales_order");
  await can("viewer", "GET", "/transactions/transactions?type=purchase_order");
  await can("viewer", "GET", `/transactions/transactions/${ID.so}`);
  await can("viewer", "GET", "/vouchers/vouchers");
  await can("viewer", "GET", "/accounting/chart");
  await can("viewer", "GET", "/accounting/reports/profit-loss?from=2000-01-01&to=2100-01-01");
  await can("viewer", "GET", "/customers/customers");
  await can("viewer", "GET", "/dashboard-summary");
  await cannot("viewer", "POST", "/transactions/transactions", { type: "sales_order" });
  await cannot("viewer", "PUT", `/transactions/transactions/${ID.so}`, { notes: "x" });
  await cannot("viewer", "PATCH", `/transactions/transactions/${ID.so}/process`, { action: "approve" });
  await cannot("viewer", "DELETE", `/transactions/transactions/${ID.so}`);
  await cannot("viewer", "POST", "/vouchers/vouchers", { voucherType: "receipt" });
  await cannot("viewer", "PATCH", `/vouchers/vouchers/${FAKE}/approve`, { action: "approve" });
  await cannot("viewer", "DELETE", `/vouchers/vouchers/${FAKE}`);
  await cannot("viewer", "PATCH", `/stock/stock/${ID.stock}/quantity`, { quantity: 1 });
  await cannot("viewer", "DELETE", `/stock/stock/${ID.stock}`);
  await cannot("viewer", "POST", "/customers", { customerName: "x" });
  await cannot("viewer", "PUT", "/accounting/settings", { creditControl: { mode: "off" } });
  await cannot("viewer", "GET", "/accounting/audit-log");
  await cannot("viewer", "GET", "/");
  await cannot("viewer", "POST", "/", { name: "x", email: "x@x.test", password: PASSWORD, type: "viewer" });
  await cannot("viewer", "POST", "/messaging/send", {});
});

test("an operator enters documents, and a manager approves them", { skip }, async () => {
  await can("operator", "POST", "/transactions/transactions", { type: "sales_order" });
  await can("operator", "POST", "/transactions/transactions", { type: "purchase_order" });
  await can("operator", "POST", "/vouchers/vouchers", { voucherType: "receipt" });
  await can("operator", "PATCH", `/stock/stock/${ID.stock}/quantity`, { quantity: 1 });
  await cannot("operator", "PATCH", `/transactions/transactions/${ID.so}/process`, { action: "approve" });
  await cannot("operator", "PATCH", `/transactions/transactions/${ID.po}/process`, { action: "approve" });
  await cannot("operator", "DELETE", `/transactions/transactions/${ID.so}`);
  await cannot("operator", "PATCH", `/vouchers/vouchers/${FAKE}/approve`, { action: "approve" });
  await cannot("operator", "DELETE", `/stock/stock/${ID.stock}`);
  await cannot("operator", "POST", "/accounting/accounts", { accountName: "x" });
  await cannot("operator", "PUT", "/accounting/account-configuration", {});
  await cannot("operator", "POST", `/accounting/fiscal-years/${FAKE}/close`);
  await cannot("operator", "GET", `/accounting/fiscal-years/${FAKE}/year-end`);
  await cannot("operator", "POST", "/opening-balances/accounts", {});
  await cannot("operator", "POST", "/messaging/send", {});

  await can("manager", "PATCH", `/transactions/transactions/${ID.po}/process`, { action: "approve" });
  const approved = await api("manager", "PATCH", `/transactions/transactions/${ID.so}/process`, { action: "approve" });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data?.data?.transaction?.status, "APPROVED", "the manager really approved it");
});

test("a sales executive raises and sends sales documents, and cannot see or touch anything else", { skip }, async () => {
  await can("sales", "POST", "/transactions/transactions", { type: "sales_order" });
  await can("sales", "POST", "/quotations", {});
  await can("sales", "POST", "/messaging/send", {});
  await can("sales", "GET", "/customers/customers");
  await can("sales", "GET", "/stock/stock");
  await can("sales", "GET", "/accounting/tax-codes");
  await can("sales", "GET", "/banking/payment-options");
  await can("sales", "GET", "/dashboard-summary");
  await cannot("sales", "POST", "/transactions/transactions", { type: "purchase_order" });
  await cannot("sales", "GET", "/transactions/transactions?type=purchase_order");
  await cannot("sales", "GET", `/transactions/transactions/${ID.po}`);
  await cannot("sales", "PATCH", `/transactions/transactions/${ID.so}/process`, { action: "approve" });
  await cannot("sales", "DELETE", `/transactions/transactions/${ID.so}`);
  await cannot("sales", "POST", `/delivery-notes/${FAKE}/dispatch`);
  await cannot("sales", "POST", `/quotations/${FAKE}/accept`);
  await cannot("sales", "GET", "/vouchers/vouchers");
  await cannot("sales", "POST", "/vouchers/vouchers", { voucherType: "receipt" });
  await cannot("sales", "GET", "/accounting/chart");
  await cannot("sales", "GET", "/accounting/reports/profit-loss");
  await cannot("sales", "PATCH", `/stock/stock/${ID.stock}/quantity`, { quantity: 1 });
  await cannot("sales", "GET", "/vendors/vendors/" + ID.vendor);
});

test("the document list is narrowed to the types a person may see, not just guarded", { skip }, async () => {
  const mine = list(await api("sales", "GET", "/transactions/transactions?limit=100"));
  assert.ok(mine.length > 0 && mine.every((d) => d.type === "sales_order" || d.type === "sales_return"), `a sales list holds sales documents only: ${mine.map((d) => d.type).join(",")}`);
  const theirs = list(await api("purchase", "GET", "/transactions/transactions?limit=100"));
  assert.ok(theirs.length > 0 && theirs.every((d) => d.type.startsWith("purchase")), "and a purchase list purchase documents only");
  const all = list(await api("manager", "GET", "/transactions/transactions?limit=100"));
  assert.ok(all.some((d) => d.type === "sales_order") && all.some((d) => d.type === "purchase_order"), "a manager sees both");
  denied(await api("sales", "GET", "/transactions/transactions?type=purchase_order"), "asking for a type they may not see is refused, not answered with an empty list");
  denied(await api("sales", "GET", `/transactions/transactions/${ID.po}`), "and a purchase document by its id");
  assert.equal((await api("sales", "GET", `/transactions/transactions/${ID.so}`)).status, 200);
});

test("a purchase officer is the mirror of that: purchase documents, and nothing of the sales side", { skip }, async () => {
  await can("purchase", "POST", "/transactions/transactions", { type: "purchase_order" });
  await can("purchase", "GET", "/vendors/vendors");
  await can("purchase", "GET", "/stock/stock");
  await cannot("purchase", "POST", "/transactions/transactions", { type: "sales_order" });
  await cannot("purchase", "GET", "/transactions/transactions?type=sales_order");
  await cannot("purchase", "PATCH", `/transactions/transactions/${ID.po}/process`, { action: "approve" });
  await cannot("purchase", "POST", "/messaging/send", {});
  await cannot("purchase", "GET", "/vouchers/vouchers");
});

test("a storekeeper looks after stock, and touches no money and raises no sale", { skip }, async () => {
  await can("storekeeper", "PATCH", `/stock/stock/${ID.stock}/quantity`, { quantity: 1 });
  await can("storekeeper", "POST", "/stock", {});
  await can("storekeeper", "GET", "/transactions/transactions?type=sales_order");
  await can("storekeeper", "GET", "/stock-reports/valuation");
  await cannot("storekeeper", "POST", "/transactions/transactions", { type: "sales_order" });
  await cannot("storekeeper", "POST", `/delivery-notes/${FAKE}/dispatch`);
  await cannot("storekeeper", "GET", "/vouchers/vouchers");
  await cannot("storekeeper", "POST", "/vouchers/vouchers", { voucherType: "payment" });
  await cannot("storekeeper", "GET", "/accounting/chart");
  await cannot("storekeeper", "GET", "/accounting/reports/profit-loss");
});

test("an accountant keeps the books, but does not close a period, change settings or approve a sale", { skip }, async () => {
  await can("accountant", "POST", "/vouchers/vouchers", { voucherType: "receipt" });
  await can("accountant", "PATCH", `/vouchers/vouchers/${FAKE}/approve`, { action: "approve" });
  await can("accountant", "DELETE", `/vouchers/vouchers/${FAKE}`);
  await can("accountant", "POST", "/accounting/accounts", { accountName: "x" });
  await can("accountant", "POST", "/accounting/tax-codes", {});
  await can("accountant", "POST", "/vat-return/returns", {});
  await can("accountant", "GET", "/accounting/reports/profit-loss?from=2000-01-01&to=2100-01-01");
  await can("accountant", "GET", "/accounting/audit-log");
  await can("accountant", "GET", "/banking/reconciliation/accounts");
  await cannot("accountant", "POST", `/accounting/fiscal-years/${FAKE}/close`);
  await cannot("accountant", "POST", `/accounting/fiscal-years/${FAKE}/reopen`);
  await cannot("accountant", "GET", `/accounting/fiscal-years/${FAKE}/year-end`); // reading what closing would do is accounts.close too
  await cannot("accountant", "PUT", "/accounting/settings", { creditControl: { mode: "off" } });
  await cannot("accountant", "PATCH", `/transactions/transactions/${ID.so}/process`, { action: "approve" });
  await cannot("accountant", "POST", "/transactions/transactions", { type: "sales_order" });
  await cannot("accountant", "PATCH", `/stock/stock/${ID.stock}/quantity`, { quantity: 1 });
  await cannot("accountant", "POST", "/", { name: "x", email: "x@x.test", password: PASSWORD, type: "viewer" });
});

test("a manager is not an administrator: no people, no settings, no period lock, no audit trail", { skip }, async () => {
  await can("manager", "POST", "/transactions/transactions", { type: "sales_order" });
  await can("manager", "DELETE", `/transactions/transactions/${FAKE}`);
  await can("manager", "PATCH", `/vouchers/vouchers/${FAKE}/approve`, { action: "approve" });
  await can("manager", "GET", "/accounting/reports/profit-loss?from=2000-01-01&to=2100-01-01");
  await cannot("manager", "POST", "/", { name: "x", email: "x@x.test", password: PASSWORD, type: "viewer" });
  await cannot("manager", "GET", "/");
  await cannot("manager", "PUT", "/accounting/settings", { creditControl: { mode: "off" } });
  await cannot("manager", "POST", `/accounting/fiscal-years/${FAKE}/close`);
  await cannot("manager", "POST", "/accounting/accounts", { accountName: "x" });
  await cannot("manager", "PUT", "/messaging/settings", {});
  await cannot("manager", "GET", "/accounting/audit-log");
  await cannot("manager", "POST", "/vat-return/returns", {});
  await cannot("manager", "PUT", "/einvoice/settings", {});
});

test("an administrator and the owner may do the setup and the people, and the gate does not stand in the way", { skip }, async () => {
  for (const who of ["admin", "owner"]) {
    await can(who, "PUT", "/accounting/settings", { creditControl: { mode: "off" } });
    await can(who, "POST", `/accounting/fiscal-years/${FAKE}/close`);
    await can(who, "GET", `/accounting/fiscal-years/${FAKE}/year-end`);
    await can(who, "POST", "/accounting/accounts", { accountName: "x" });
    await can(who, "GET", "/");
    await can(who, "GET", "/accounting/audit-log");
    await can(who, "POST", "/vat-return/returns", {});
    await can(who, "PUT", "/messaging/settings", {});
    await can(who, "POST", "/messaging/send", {});
    await can(who, "PATCH", `/transactions/transactions/${FAKE}/process`, { action: "approve" });
  }
  // the gate lets an administrator in; the rank rule still stops them making an administrator
  const mk = await api("admin", "POST", "/", { name: "Rival", email: "rival@perm.test", password: PASSWORD, type: "admin" });
  assert.equal(mk.status, 403);
  assert.equal(mk.code, "SUPER_ADMIN_REQUIRED", "rank, not the gate");
  assert.equal((await api("owner", "POST", "/", { name: "Second", email: "second@perm.test", password: PASSWORD, type: "admin" })).status, 201);
});

test("the people lists do not leak: asking by type or by status is the same as asking for the list", { skip }, async () => {
  await cannot("viewer", "GET", "/type/super_admin");
  await cannot("sales", "GET", "/status/active");
  await cannot("manager", "GET", "/type/super_admin");
  await can("admin", "GET", "/type/super_admin");
  const owners = await api("owner", "GET", "/type/super_admin");
  assert.equal(owners.status, 200);
});

test("a person may always read their own record and their own profile", { skip }, async () => {
  const me = (await api("viewer", "GET", "/profile/me")).body;
  assert.equal(me.email, "viewer@perm.test");
  assert.equal((await api("viewer", "GET", `/${me._id || me.id}`)).status, 200, "their own record");
  denied(await api("viewer", "GET", `/${FAKE}`), "but not another's");
  assert.equal((await api("viewer", "GET", "/organisation/status")).status, 200, "and the status that tells them what they may do");
});

test("what is open to the public stays open, and nothing else is", { skip }, async () => {
  assert.equal((await call("GET", "/share/NOSUCHLINK.nothing")).status, 404, "a customer's link, unknown: not found, not 'sign in'");
  assert.equal((await call("POST", "/login", { body: { email: "nobody@x.test", password: "x" } })).status, 401, "sign-in answers for itself");
  for (const [m, u] of [["GET", "/transactions/transactions"], ["GET", "/customers/customers"], ["POST", "/vouchers/vouchers"], ["GET", "/organisation/status"], ["GET", "/"]]) {
    assert.equal((await call(m, u)).status, 401, `${m} ${u} needs a sign-in`);
  }
  assert.equal((await call("GET", "/test")).status, 401, "the unauthenticated ping that used to answer is gone (it now meets the admin router's :id)");
});

test("approving a sale past a customer's credit limit is a decision of its own", { skip }, async () => {
  await as("perm", () => M.Role.create({ key: "approver", name: "Sales approver", rank: 45, permissions: ["sales.approve"] }));
  await as("perm", () => new M.Admin({ name: "approver", email: "approver@perm.test", password: PASSWORD, status: "active", isActive: true, type: "viewer", roleKey: "approver" }).save());
  T.approver = (await call("POST", "/login", { body: { email: "approver@perm.test", password: PASSWORD } })).body.tokens.accessToken;
  await as("perm", async () => {
    await M.Customer.updateOne({ _id: ID.customer }, { $set: { creditLimit: 10 } });
    await M.Settings.updateOne({}, { $set: { "creditControl.mode": "warn" } });
  });
  const s1 = await order("sales", "sales_order", ID.customer, "Customer", 5, 20);
  assert.equal(s1.status, 201, JSON.stringify(s1.data));
  const warned = await api("approver", "PATCH", `/transactions/transactions/${s1.body._id}/process`, { action: "approve" });
  assert.equal(warned.status, 409, "the gate lets an approver in, and the credit check warns them");
  assert.equal(warned.code, "RISK_WARNING_ACKNOWLEDGEMENT_REQUIRED");
  const ack = await api("approver", "PATCH", `/transactions/transactions/${s1.body._id}/process`, { action: "approve", riskAck_limit_party_credit: true });
  denied(ack, "pressing 'approve anyway' needs sales.creditOverride, which an approver does not hold");
  assert.deepEqual(ack.details.required, ["sales.creditOverride"]);
  const done = await api("manager", "PATCH", `/transactions/transactions/${s1.body._id}/process`, { action: "approve", riskAck_limit_party_credit: true });
  assert.equal(done.status, 200, `a manager holds it: ${JSON.stringify(done.data)}`);
});

test("a custom role works the moment it is saved, with the token the person already holds", { skip }, async () => {
  await can("approver", "PATCH", `/transactions/transactions/${FAKE}/process`, { action: "approve" });
  await cannot("approver", "POST", "/transactions/transactions", { type: "sales_order" });
  await as("perm", () => M.Role.updateOne({ key: "approver" }, { $set: { permissions: ["sales.create"] } }));
  await cannot("approver", "PATCH", `/transactions/transactions/${FAKE}/process`, { action: "approve" });
  await can("approver", "POST", "/transactions/transactions", { type: "sales_order" });
  await as("perm", () => M.Role.updateOne({ key: "approver" }, { $set: { isActive: false } }));
  await cannot("approver", "POST", "/transactions/transactions", { type: "sales_order" });
  await cannot("approver", "GET", "/dashboard-summary");
  const off = await api("approver", "GET", "/transactions/transactions");
  assert.match(off.data.message, /switched off/i, "and says why, rather than a bare refusal");
});

test("a refusal says what was needed, and is written to the organisation's own trail", { skip }, async () => {
  const r = await api("viewer", "PATCH", `/transactions/transactions/${ID.so}/process`, { action: "approve" });
  denied(r, "viewer approving");
  assert.deepEqual(r.details.required, ["sales.approve"]);
  assert.equal(r.details.role, "viewer");
  assert.match(r.data.message, /Viewer/);
  await new Promise((resolve) => setTimeout(resolve, 600)); // the note is written without being waited for
  const rows = await as("perm", () => M.Activity.find({ action: "PERMISSION_DENIED" }).lean());
  assert.ok(rows.length > 5, `denials are recorded: ${rows.length}`);
  assert.ok(rows.some((x) => /needs sales\.approve/.test(x.summary) && x.username === "viewer@perm.test"), "naming who and what");
});
