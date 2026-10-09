// Deleting a document that has not been approved books nothing, so Delete is enough. Deleting an APPROVED one reverses its
// stock and its ledger postings, and that is its own permission (sales.deletePosted, purchase.deletePosted,
// finance.deletePosted). Against a strict server with real sign-ins, with roles made through the API the way a customer's
// administrator makes them. Also: the staff records answer to their own permissions, not to the people who sign in.
//
// A refusal must be the server's own 403 PERMISSION_DENIED. An allowed call only has to get PAST the gate.
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
const FAKE = "64b64b64b64b64b64b64b64b";

let child, M, Org, ctx;
let logs = "";
const T = {};
const S = {};

async function call(method, url, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode, details: data?.details };
}
const as = (fn) => ctx.runWithTenant({ companyId: "acc", branchId: "main" }, fn);
const api = (who, method, url, body) => call(method, url, { token: T[who], body: method === "GET" || method === "DELETE" ? undefined : body });
const login = async (email) => (await call("POST", "/login", { body: { email, password: PASSWORD } })).body?.tokens?.accessToken;

const cannot = async (who, method, url, body) => {
  const r = await api(who, method, url, body);
  assert.equal(r.status, 403, `${who} ${method} ${url} should be refused: ${r.status} ${JSON.stringify(r.data)?.slice(0, 200)}`);
  assert.equal(r.code, "PERMISSION_DENIED", `${who} ${method} ${url}`);
  return r;
};
const gets = async (who, method, url, body) => {
  const r = await api(who, method, url, body);
  assert.notEqual(r.status, 403, `${who} ${method} ${url} should get past the gate: ${JSON.stringify(r.data)?.slice(0, 200)}`);
  assert.notEqual(r.status, 401, `${who} ${method} ${url}`);
  return r;
};

async function roleAndPerson(key, permissions) {
  const made = await api("owner", "POST", "/access/roles", { key, name: key.replace(/_/g, " "), rank: 50, permissions });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const added = await api("owner", "POST", "/access/users", { name: key, email: `${key}@acc.test`, password: PASSWORD, role: key });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  await as(() => M.Admin.updateOne({ email: `${key}@acc.test` }, { $set: { mustChangePassword: false } })); // (the forced first change: passwordPolicyHttp.test.js)
  T[key] = await login(`${key}@acc.test`);
  assert.ok(T[key], `${key} signs in`);
  return made.body;
}

const order = (qty) => ({ type: "sales_order", partyId: S.customer, partyType: "Customer", partyTypeRef: "Customer", createdBy: "test", items: [{ itemId: S.item, description: "Rice 5kg", qty, price: 20, rate: 20, vatPercent: 5, taxCodeId: S.tax }] });
const stock = async () => (await as(() => M.Stock.findById(S.item).lean())).currentStock;
const orderRow = (id) => as(() => M.Transaction.findById(id).lean());
const voucherRow = (id) => as(() => M.Voucher.findById(id).lean());

// a sales order made and approved by the owner: stock out and the ledger posted
async function approvedOrder(qty = 6) {
  const draft = await api("owner", "POST", "/transactions/transactions", order(qty));
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  const approved = await api("owner", "PATCH", `/transactions/transactions/${draft.body._id}/process`, { action: "approve" });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal((await orderRow(draft.body._id)).status, "APPROVED");
  return draft.body._id;
}

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = {
    Admin: require("../../models/core/adminModel"), Stock: require("../../models/modules/stockModel"), Customer: require("../../models/modules/customerModel"),
    Transaction: require("../../models/modules/transactionModel"), Voucher: require("../../models/modules/financial/financialModels").Voucher,
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

test("an organisation with a customer, an item, and people who only delete, who reverse, and who do neither", { skip }, async () => {
  assert.equal((await Org.create({ legalName: "Acc Trading", code: "acc", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" })).provisioning.complete, true);
  await as(() => new M.Admin({ name: "owner", email: "owner@acc.test", password: PASSWORD, status: "active", isActive: true, type: "super_admin" }).save());
  T.owner = await login("owner@acc.test");
  assert.ok(T.owner);
  S.customer = String((await as(() => new M.Customer({ customerId: "CUST001", customerName: "Al Noor Trading", contactPerson: "Ali Hassan", email: "ali@alnoor.test", phone: "0501234567", paymentTerms: "Net 30", creditLimit: 1000000, trnNumber: "100999888700003", billingAddress: "Deira, Dubai" }).save()))._id);
  S.item = String((await as(() => new M.Stock({ itemId: "RICE5", sku: "RICE5", itemName: "Rice 5kg", category: new mongoose.Types.ObjectId(), currentStock: 50 }).save()))._id);
  S.tax = (await api("owner", "GET", "/accounting/tax-codes")).body.find((c) => c.kind === "standard")?._id;
  assert.ok(S.tax, "a standard tax code");

  await roleAndPerson("deleter", ["sales.delete", "finance.delete"]);
  await roleAndPerson("reverser", ["sales.deletePosted", "finance.deletePosted"]);
  await roleAndPerson("approver", ["sales.approve", "finance.approve"]);
});

test("deletePosted brings plain Delete with it, and plain Delete does not bring deletePosted", { skip }, async () => {
  const roles = (await api("owner", "GET", "/access/roles")).body.roles;
  const held = (key) => roles.find((r) => r.key === key).permissions;
  assert.ok(held("reverser").includes("sales.delete") && held("reverser").includes("finance.delete"));
  assert.ok(!held("deleter").includes("sales.deletePosted") && !held("deleter").includes("finance.deletePosted"));
  assert.ok(!held("approver").includes("sales.deletePosted"), "approving a document is not the right to reverse it");
});

test("a trade document that is not approved is deleted with plain Delete", { skip }, async () => {
  const draft = await api("owner", "POST", "/transactions/transactions", order(2));
  assert.equal(draft.status, 201, JSON.stringify(draft.data));
  await cannot("approver", "DELETE", `/transactions/transactions/${draft.body._id}`); // approving is not deleting
  const gone = await api("deleter", "DELETE", `/transactions/transactions/${draft.body._id}`);
  assert.ok(gone.status === 204 || gone.status === 200, `${gone.status} ${JSON.stringify(gone.data)}`);
  assert.equal(await orderRow(draft.body._id), null, "the draft is gone");
  assert.equal(await stock(), 50, "a draft moved no stock");
});

test("an APPROVED trade document needs deletePosted: Delete alone is refused and nothing is touched", { skip }, async () => {
  S.so1 = await approvedOrder(6);
  assert.equal(await stock(), 44, "approval took the stock out");
  const refused = await cannot("deleter", "DELETE", `/transactions/transactions/${S.so1}`);
  assert.ok(refused.details.required.includes("sales.deletePosted"), `the refusal names what is missing: ${JSON.stringify(refused.details)}`);
  await cannot("approver", "DELETE", `/transactions/transactions/${S.so1}`);
  assert.equal((await orderRow(S.so1)).status, "APPROVED", "still approved");
  assert.equal(await stock(), 44, "stock was not put back");
});

test("someone who holds deletePosted reverses it: the document goes and the stock comes back", { skip }, async () => {
  const gone = await api("reverser", "DELETE", `/transactions/transactions/${S.so1}`);
  assert.ok(gone.status === 204 || gone.status === 200, `${gone.status} ${JSON.stringify(gone.data)}`);
  assert.equal(await orderRow(S.so1), null);
  assert.equal(await stock(), 50, "the 6 are back on the shelf");
});

test("the status in the request cannot talk the gate into the cheaper permission: it is read from the stored document", { skip }, async () => {
  const id = await approvedOrder(3);
  await cannot("deleter", "DELETE", `/transactions/transactions/${id}?status=DRAFT`);
  await cannot("deleter", "DELETE", `/transactions/transactions/${id}`);
  assert.ok((await orderRow(id)), "still there");
  assert.equal((await api("reverser", "DELETE", `/transactions/transactions/${id}`)).status >= 400, false);
  assert.equal(await stock(), 50);
});

test("a voucher: an approved one needs deletePosted, any other plain Delete", { skip }, async () => {
  const accounts = (await api("owner", "GET", "/accounting/accounts/postable")).body;
  const rent = accounts.find((a) => /Rent Expense/i.test(a.accountName || a.name));
  const cash = accounts.find((a) => /Cash in Hand/i.test(a.accountName || a.name));
  assert.ok(rent && cash, "the starter chart has Rent Expense and Cash in Hand");
  const make = async () => {
    const r = await api("owner", "POST", "/vouchers/vouchers", { voucherType: "journal", date: new Date().toISOString(), narration: "Month-end accrual", lines: [{ accountId: rent._id, debit: 50 }, { accountId: cash._id, credit: 50 }] });
    assert.equal(r.status, 201, JSON.stringify(r.data)?.slice(0, 300));
    const id = r.body._id || r.body.voucher?._id;
    assert.equal((await voucherRow(id)).status, "approved", "a journal posts as it is saved");
    return id;
  };
  const v1 = await make();
  const refused = await cannot("deleter", "DELETE", `/vouchers/vouchers/${v1}`);
  assert.ok(refused.details.required.includes("finance.deletePosted"), JSON.stringify(refused.details));
  assert.equal((await voucherRow(v1)).status, "approved", "untouched");
  const done = await api("reverser", "DELETE", `/vouchers/vouchers/${v1}`);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal((await voucherRow(v1)).status, "cancelled", "reversed and kept as cancelled");

  // a voucher that has not been approved books nothing: plain Delete is enough
  const draft = await as(() => new M.Voucher({ voucherNo: "JV-TEST-1", voucherType: "journal", date: new Date(), totalAmount: 1, status: "draft", approvalStatus: "pending", createdBy: new mongoose.Types.ObjectId() }).save());
  const plain = await api("deleter", "DELETE", `/vouchers/vouchers/${draft._id}`);
  assert.notEqual(plain.status, 403, `plain Delete reaches a voucher that is not approved: ${JSON.stringify(plain.data)}`);
});

test("'delete its entries' when undoing a bank match is the same right, so it cannot be a side door", { skip }, async () => {
  await roleAndPerson("reconciler", ["banking.reconcile"]);
  const r = await cannot("reconciler", "DELETE", `/banking/reconciliation/matches/${FAKE}?deleteVouchers=true`);
  assert.ok(r.details.required.includes("finance.deletePosted"));
  const plain = await gets("reconciler", "DELETE", `/banking/reconciliation/matches/${FAKE}`);
  assert.ok(plain.status === 404 || plain.status === 400 || plain.status === 409, `an id that matches nothing is not a permission problem: ${plain.status}`);
  await roleAndPerson("reconciler_reverser", ["banking.reconcile", "finance.deletePosted"]);
  await gets("reconciler_reverser", "DELETE", `/banking/reconciliation/matches/${FAKE}?deleteVouchers=true`);
});

test("the staff records answer to staff.view and staff.manage, not to the people who sign in", { skip }, async () => {
  await roleAndPerson("people_manager", ["users.view", "users.manage"]);
  await roleAndPerson("hr_reader", ["staff.view"]);
  await roleAndPerson("hr_manager", ["staff.manage"]);

  // a person who manages sign-in accounts sees no employee file
  await cannot("people_manager", "GET", "/staff/staff");
  await cannot("people_manager", "POST", "/staff/staff", {});
  await cannot("people_manager", "DELETE", `/staff/staff/${FAKE}`);
  assert.equal((await api("people_manager", "GET", "/access/users")).status, 200, "and still manages the people who sign in");

  // a reader reads and does nothing else
  assert.equal((await api("hr_reader", "GET", "/staff/staff")).status, 200);
  await gets("hr_reader", "GET", "/staff/staff/stats");
  await cannot("hr_reader", "POST", "/staff/staff", {});
  await cannot("hr_reader", "PUT", `/staff/staff/${FAKE}`, {});
  await cannot("hr_reader", "DELETE", `/staff/staff/${FAKE}`);

  // a manager changes the records, and is not thereby a manager of sign-in accounts
  assert.equal((await api("hr_manager", "GET", "/staff/staff")).status, 200, "managing brings viewing");
  await gets("hr_manager", "POST", "/staff/staff", {});
  await gets("hr_manager", "PUT", `/staff/staff/${FAKE}`, {});
  await gets("hr_manager", "DELETE", `/staff/staff/${FAKE}`);
  await cannot("hr_manager", "GET", "/access/users");

  // the owner holds both
  assert.equal((await api("owner", "GET", "/staff/staff")).status, 200);
  const me = (await api("hr_reader", "GET", "/organisation/status")).body.me;
  assert.ok(me.grants.includes("staff.view") && !me.grants.includes("staff.manage"));
});
