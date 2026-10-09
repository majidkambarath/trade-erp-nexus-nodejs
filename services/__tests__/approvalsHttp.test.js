// Holding Approve is the first test. These are the next ones, against a strict server with real sign-ins and roles made
// through the API:
//   - a role's approval LIMIT: the largest document its people may approve
//   - SEPARATE APPROVER: the person who prepared a document may not approve it
//   - SECOND APPROVAL above an amount: the first approval is recorded and nothing moves; a different person finishes it
// Everything is off until set, and a refusal is the server's own 403 with a code the screen can show.
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
const T = {};
const S = {};

async function call(method, url, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode, details: data?.details, message: data?.message };
}
const as = (fn) => ctx.runWithTenant({ companyId: "acc", branchId: "main" }, fn);
const api = (who, method, url, body) => call(method, url, { token: T[who], body: method === "GET" || method === "DELETE" ? undefined : body });
const login = async (email) => (await call("POST", "/login", { body: { email, password: PASSWORD } })).body?.tokens?.accessToken;

async function person(key, permissions, { approvalLimit, rank = 50 } = {}) {
  const made = await api("owner", "POST", "/access/roles", { key, name: key.replace(/_/g, " "), rank, permissions, ...(approvalLimit !== undefined ? { approvalLimit } : {}) });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const added = await api("owner", "POST", "/access/users", { name: key, email: `${key}@acc.test`, password: PASSWORD, role: key });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  await as(() => M.Admin.updateOne({ email: `${key}@acc.test` }, { $set: { mustChangePassword: false } })); // (the forced first change: passwordPolicyHttp.test.js)
  T[key] = await login(`${key}@acc.test`);
  assert.ok(T[key], `${key} signs in`);
  return made.body;
}

const order = (qty) => ({ type: "sales_order", partyId: S.customer, partyType: "Customer", partyTypeRef: "Customer", createdBy: "test", items: [{ itemId: S.item, description: "Rice 5kg", qty, price: 20, rate: 20, vatPercent: 5, taxCodeId: S.tax }] });
// qty x 20 + 5% VAT: 6 -> 126, 40 -> 840
const stock = async () => (await as(() => M.Stock.findById(S.item).lean())).currentStock;
const row = (id) => as(() => M.Transaction.findById(id).lean());
const draft = async (who, qty) => {
  const r = await api(who, "POST", "/transactions/transactions", order(qty));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.body._id;
};
const approve = (who, id) => api(who, "PATCH", `/transactions/transactions/${id}/process`, { action: "approve" });
const settings = (patch) => api("owner", "PUT", "/accounting/settings", patch);

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

test("an organisation with a customer and stock, and people who approve: one with a limit, two without, one who also prepares", { skip }, async () => {
  assert.equal((await Org.create({ legalName: "Acc Trading", code: "acc", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" })).provisioning.complete, true);
  await as(() => new M.Admin({ name: "owner", email: "owner@acc.test", password: PASSWORD, status: "active", isActive: true, type: "super_admin" }).save());
  T.owner = await login("owner@acc.test");
  S.customer = String((await as(() => new M.Customer({ customerId: "CUST001", customerName: "Al Noor Trading", contactPerson: "Ali Hassan", email: "ali@alnoor.test", phone: "0501234567", paymentTerms: "Net 30", creditLimit: 10000000, trnNumber: "100999888700003", billingAddress: "Deira, Dubai" }).save()))._id);
  S.item = String((await as(() => new M.Stock({ itemId: "RICE5", sku: "RICE5", itemName: "Rice 5kg", category: new mongoose.Types.ObjectId(), currentStock: 1000 }).save()))._id);
  S.tax = (await api("owner", "GET", "/accounting/tax-codes")).body.find((c) => c.kind === "standard")?._id;
  assert.ok(S.tax);

  const junior = await person("junior", ["sales.create", "sales.approve", "finance.approve"], { approvalLimit: 500 });
  assert.equal(junior.approvalLimit, 500, "the limit is saved and shown");
  await person("senior", ["sales.create", "sales.approve", "finance.approve"]);
  await person("preparer", ["sales.create", "sales.approve"]);
});

test("built-in roles have no limit; a custom one shows what was saved; the status carries it", { skip }, async () => {
  const roles = (await api("owner", "GET", "/access/roles")).body.roles;
  for (const r of roles.filter((x) => x.builtIn)) assert.equal(r.approvalLimit, null, r.key);
  assert.equal(roles.find((r) => r.key === "junior").approvalLimit, 500);
  assert.equal(roles.find((r) => r.key === "senior").approvalLimit, null);
  const status = (await api("junior", "GET", "/organisation/status")).body;
  assert.equal(status.me.role.approvalLimit, 500);
  assert.deepEqual(status.policy.approvals, { separateApprover: false, secondApprovalAbove: null }, "nothing is set by default");
});

test("a limit is an amount of 0 or more, empty for none, and can be changed", { skip }, async () => {
  const bad = await api("owner", "POST", "/access/roles", { key: "badlimit", name: "Bad limit", rank: 50, permissions: ["sales.approve"], approvalLimit: -5 });
  assert.equal(bad.status, 400);
  assert.equal(bad.code, "ROLE_INVALID");
  assert.equal(bad.details.field, "approvalLimit");
  assert.equal((await api("owner", "POST", "/access/roles", { key: "textlimit", name: "Text limit", rank: 50, permissions: ["sales.approve"], approvalLimit: "lots" })).status, 400);
  const changed = await api("owner", "PATCH", "/access/roles/junior", { approvalLimit: 750 });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal(changed.body.approvalLimit, 750);
  assert.equal((await api("owner", "PATCH", "/access/roles/junior", { approvalLimit: 500 })).body.approvalLimit, 500, "and back");
  const cleared = await api("owner", "PATCH", "/access/roles/junior", { approvalLimit: "" });
  assert.equal(cleared.body.approvalLimit, null, "empty means no limit");
  await api("owner", "PATCH", "/access/roles/junior", { approvalLimit: 500 });
});

test("nobody hands out a bigger limit than their own, or takes a ceiling off a role that approves", { skip }, async () => {
  await person("delegator", ["users.manage", "sales.create", "sales.approve"], { approvalLimit: 1000, rank: 60 });
  const tooBig = await api("delegator", "POST", "/access/roles", { key: "bigger", name: "Bigger", rank: 40, permissions: ["sales.approve"], approvalLimit: 2000 });
  assert.equal(tooBig.status, 400, JSON.stringify(tooBig.data));
  assert.match(tooBig.message, /above your own \(1000\)/);
  const unlimited = await api("delegator", "POST", "/access/roles", { key: "unbounded", name: "Unbounded", rank: 40, permissions: ["sales.approve"] });
  assert.equal(unlimited.status, 400, "no ceiling on an approving role would be above theirs");
  assert.match(unlimited.message, /Set a limit/);
  const fine = await api("delegator", "POST", "/access/roles", { key: "smaller", name: "Smaller", rank: 40, permissions: ["sales.approve"], approvalLimit: 1000 });
  assert.equal(fine.status, 201, JSON.stringify(fine.data));
  const noApprove = await api("delegator", "POST", "/access/roles", { key: "enterer", name: "Enterer", rank: 40, permissions: ["sales.create"] });
  assert.equal(noApprove.status, 201, "a role that approves nothing needs no limit");
});

test("the limit: a document inside it is approved, one over it is refused and nothing moves", { skip }, async () => {
  const small = await draft("preparer", 6); // 126
  const big = await draft("preparer", 40); // 840
  const before = await stock();

  const ok = await approve("junior", small);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await row(small)).status, "APPROVED");
  assert.equal(await stock(), before - 6);

  const refused = await approve("junior", big);
  assert.equal(refused.status, 403);
  assert.equal(refused.code, "APPROVAL_LIMIT_EXCEEDED");
  assert.deepEqual(refused.details, { amount: 840, limit: 500 });
  assert.match(refused.message, /840\.00 AED/);
  assert.equal((await row(big)).status, "DRAFT");
  assert.equal(await stock(), before - 6, "nothing moved");

  const done = await approve("senior", big);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal((await row(big)).status, "APPROVED");
  const approvals = (await row(big)).approvals;
  assert.deepEqual(approvals.map((a) => [a.name, a.step]), [["senior", 1]], "who approved it is kept");
});

test("the separate approver: the person who prepared a document may not approve it, anyone else may", { skip }, async () => {
  assert.equal((await settings({ approvals: { separateApprover: true } })).status, 200);
  assert.equal((await api("owner", "GET", "/accounting/settings")).body.approvals.separateApprover, true);

  const mine = await draft("preparer", 2);
  const own = await approve("preparer", mine);
  assert.equal(own.status, 403);
  assert.equal(own.code, "SELF_APPROVAL_NOT_ALLOWED");
  assert.equal((await row(mine)).status, "DRAFT");
  const theirs = await approve("senior", mine);
  assert.equal(theirs.status, 200, JSON.stringify(theirs.data));

  // the owner is no exception to their own work
  const owners = await draft("owner", 1);
  assert.equal((await approve("owner", owners)).code, "SELF_APPROVAL_NOT_ALLOWED");
  assert.equal((await approve("senior", owners)).status, 200);

  await settings({ approvals: { separateApprover: false } });
  const back = await draft("preparer", 1);
  assert.equal((await approve("preparer", back)).status, 200, "off again: the preparer may approve");
});

test("the policy can be read back, is validated, and only someone who manages settings changes it", { skip }, async () => {
  const bad = await settings({ approvals: { secondApprovalAbove: "plenty" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.code, "APPROVALS_INVALID");
  assert.equal((await settings({ approvals: { secondApprovalAbove: -1 } })).status, 400);
  const set = await settings({ approvals: { secondApprovalAbove: "500.456" } });
  assert.equal(set.body.approvals.secondApprovalAbove, 500.46, "to the fils");
  assert.equal((await settings({ approvals: { secondApprovalAbove: "" } })).body.approvals.secondApprovalAbove, null, "empty switches it off");
  assert.equal((await api("senior", "PUT", "/accounting/settings", { approvals: { separateApprover: true } })).status, 403, "approving is not setting the rules for approving");
  assert.equal((await api("owner", "GET", "/accounting/settings")).body.approvals.separateApprover, false);
});

test("a second approver above an amount: the first approval is kept and nothing moves; a different person finishes it", { skip }, async () => {
  assert.equal((await settings({ approvals: { secondApprovalAbove: 500 } })).body.approvals.secondApprovalAbove, 500);
  const before = await stock();

  // under the threshold one approval is final, as before
  const small = await draft("preparer", 6); // 126
  assert.equal((await approve("senior", small)).status, 200);
  assert.equal((await row(small)).status, "APPROVED");

  // over it, the first approval does not approve
  const big = await draft("preparer", 40); // 840
  const stockMid = await stock();
  const first = await approve("senior", big);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual(first.body.approval, { awaitingSecond: true, given: 1 });
  assert.equal(first.body.transaction.status, "DRAFT");
  let doc = await row(big);
  assert.equal(doc.status, "DRAFT", "still not approved");
  assert.equal(doc.approvals.length, 1);
  assert.equal(await stock(), stockMid, "no stock moved on the first approval");

  // the list says it is waiting
  const listed = (await api("owner", "GET", "/transactions/transactions?type=sales_order&limit=50")).data.data.find((t) => t._id === big);
  assert.equal(listed.approvals.length, 1, "list rows carry who has approved");

  // the same person cannot give the second
  const again = await approve("senior", big);
  assert.equal(again.status, 403);
  assert.equal(again.code, "SECOND_APPROVER_REQUIRED");

  // a different person with a limit too low for it cannot either (limit 500, document 840)
  const tooSmall = await approve("junior", big);
  assert.equal(tooSmall.code, "APPROVAL_LIMIT_EXCEEDED");

  // a different person finishes it: now it is approved and the stock goes
  const second = await approve("owner", big);
  assert.equal(second.status, 200, JSON.stringify(second.data));
  assert.equal(second.body.approval, undefined, "this one was final");
  doc = await row(big);
  assert.equal(doc.status, "APPROVED");
  assert.deepEqual(doc.approvals.map((a) => [a.name, a.step]), [["senior", 1], ["owner", 2]]);
  assert.equal(await stock(), stockMid - 40);
  assert.ok(before > 0);
});

test("editing a document after its first approval takes the approval back", { skip }, async () => {
  const id = await draft("preparer", 40);
  assert.equal((await approve("senior", id)).body.approval.awaitingSecond, true);
  assert.equal((await row(id)).approvals.length, 1);
  const edited = await api("owner", "PUT", `/transactions/transactions/${id}`, { ...order(41), notes: "changed" });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  assert.equal((await row(id)).approvals.length, 0, "what was approved is no longer what is there");
  // so the next approval is a first one again, and the same person may give it
  const next = await approve("senior", id);
  assert.equal(next.status, 200);
  assert.equal(next.body.approval.awaitingSecond, true);
  // a body cannot write approvals
  const forged = await api("owner", "PUT", `/transactions/transactions/${id}`, { notes: "again", approvals: [{ by: "x", name: "forged", step: 1 }, { by: "y", name: "forged too", step: 2 }] });
  assert.equal(forged.status, 200);
  assert.deepEqual((await row(id)).approvals.map((a) => a.name), [], "the edit cleared it and the forged ones were ignored");
});

test("turning a document down before it is approved leaves nothing standing", { skip }, async () => {
  const id = await draft("preparer", 40);
  await approve("senior", id);
  assert.equal((await row(id)).approvals.length, 1);
  const rejected = await api("owner", "PATCH", `/transactions/transactions/${id}/process`, { action: "reject" });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
  const doc = await row(id);
  assert.equal(doc.status, "REJECTED");
  assert.equal(doc.approvals.length, 0);
});

test("raising the threshold after a first approval lets it stand alone, and nobody is recorded twice", { skip }, async () => {
  const id = await draft("preparer", 40);
  await approve("senior", id);
  assert.equal((await settings({ approvals: { secondApprovalAbove: 100000 } })).status, 200);
  const done = await approve("senior", id);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const doc = await row(id);
  assert.equal(doc.status, "APPROVED");
  assert.deepEqual(doc.approvals.map((a) => a.name), ["senior"], "one person, one entry");
  await settings({ approvals: { secondApprovalAbove: "" } });
});

test("the separate approver and the second approver together", { skip }, async () => {
  assert.equal((await settings({ approvals: { separateApprover: true, secondApprovalAbove: 500 } })).status, 200);
  const id = await draft("preparer", 40);
  assert.equal((await approve("preparer", id)).code, "SELF_APPROVAL_NOT_ALLOWED", "the preparer is out of both steps");
  assert.equal((await approve("senior", id)).body.approval.awaitingSecond, true);
  assert.equal((await approve("senior", id)).code, "SECOND_APPROVER_REQUIRED");
  assert.equal((await approve("preparer", id)).code, "SELF_APPROVAL_NOT_ALLOWED", "and cannot be the second either");
  assert.equal((await approve("owner", id)).status, 200);
  assert.equal((await row(id)).status, "APPROVED");
  await settings({ approvals: { separateApprover: false, secondApprovalAbove: "" } });
});

test("a voucher waiting for approval follows the same rules", { skip }, async () => {
  const pending = async (total, by) => String((await as(() => new M.Voucher({
    voucherNo: `JV-T-${Math.random().toString(36).slice(2, 8)}`, voucherType: "journal", date: new Date(), totalAmount: total, status: "pending", approvalStatus: "pending",
    createdBy: new mongoose.Types.ObjectId(by), entries: [],
  }).save()))._id);
  const idOf = async (email) => String((await as(() => M.Admin.findOne({ email }).lean()))._id);
  const approveV = (who, id) => api(who, "PATCH", `/vouchers/vouchers/${id}/approve`, { action: "approve" });
  const voucher = (id) => as(() => M.Voucher.findById(id).lean());

  // the limit
  const big = await pending(840, await idOf("preparer@acc.test"));
  const limited = await approveV("junior", big);
  assert.equal(limited.status, 403);
  assert.equal(limited.code, "APPROVAL_LIMIT_EXCEEDED");
  assert.equal((await voucher(big)).status, "pending");

  // the separate approver
  await settings({ approvals: { separateApprover: true } });
  const own = await pending(100, await idOf("senior@acc.test"));
  assert.equal((await approveV("senior", own)).code, "SELF_APPROVAL_NOT_ALLOWED");
  await settings({ approvals: { separateApprover: false, secondApprovalAbove: 500 } });

  // the second approver: the first is kept and the voucher stays pending
  const first = await approveV("senior", big);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual(first.body.approval, { awaitingSecond: true, given: 1 });
  let doc = await voucher(big);
  assert.equal(doc.status, "pending");
  assert.equal(doc.approvals.length, 1);
  assert.equal((await approveV("senior", big)).code, "SECOND_APPROVER_REQUIRED");

  // under the threshold one approval finishes it
  const small = await pending(100, await idOf("preparer@acc.test"));
  const done = await approveV("senior", small);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  doc = await voucher(small);
  assert.equal(doc.status, "approved");
  assert.deepEqual(doc.approvals.map((a) => a.name), ["senior"]);

  // a different person finishes the big one
  const second = await approveV("owner", big);
  assert.equal(second.status, 200, JSON.stringify(second.data));
  doc = await voucher(big);
  assert.equal(doc.status, "approved");
  assert.deepEqual(doc.approvals.map((a) => [a.name, a.step]), [["senior", 1], ["owner", 2]]);
  await settings({ approvals: { secondApprovalAbove: "" } });
});
