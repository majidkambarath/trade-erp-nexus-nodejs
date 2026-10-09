// A person may hold a different role in a particular branch: a manager at head office who is only a viewer in Sharjah, a clerk
// at Sharjah who may also look at Dubai. Against a strict server with real sign-ins. What this pins:
//   - the role that applies is the one for the branch being worked in, decided from the database on every request
//   - a branch person reaches another branch only by being given a role there
//   - a person whose role differs by branch works in one branch at a time (no all-branches view)
//   - giving branch roles is a users.manage act, limited by rank, never a thing a person does to themselves or from a request body
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

async function call(method, url, { body, token, branch } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (branch) headers["X-Branch"] = branch;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode, details: data?.details, message: data?.message };
}
const as = (fn) => ctx.runWithTenant({ companyId: "acc", branchId: "main" }, fn);
const api = (who, method, url, body, branch) => call(method, url, { token: T[who], body: method === "GET" || method === "DELETE" ? undefined : body, branch });
const login = async (email) => (await call("POST", "/login", { body: { email, password: PASSWORD } })).body?.tokens?.accessToken;
const statusAt = async (who, branch) => (await api(who, "GET", "/organisation/status", undefined, branch));

async function addPerson(key, role, extra = {}) {
  const added = await api("owner", "POST", "/access/users", { name: key, email: `${key}@acc.test`, password: PASSWORD, role, ...extra });
  assert.equal(added.status, 201, `${key}: ${JSON.stringify(added.data)}`);
  await as(() => M.Admin.updateOne({ email: `${key}@acc.test` }, { $set: { mustChangePassword: false } })); // (the forced first change: passwordPolicyHttp.test.js)
  T[key] = await login(`${key}@acc.test`);
  assert.ok(T[key], `${key} signs in`);
  return added.body;
}
const order = (qty = 1) => ({ type: "sales_order", partyId: S.customer, partyType: "Customer", partyTypeRef: "Customer", createdBy: "test", items: [{ itemId: S.item, description: "Rice 5kg", qty, price: 20, rate: 20, vatPercent: 5, taxCodeId: S.tax }] });
const idOf = async (email) => String((await as(() => M.Admin.findOne({ email }).lean()))._id);

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = { Admin: require("../../models/core/adminModel"), Stock: require("../../models/modules/stockModel"), Customer: require("../../models/modules/customerModel"), Transaction: require("../../models/modules/transactionModel") };
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

test("an organisation with head office and two branches, and people whose role differs by branch", { skip }, async () => {
  assert.equal((await Org.create({ legalName: "Acc Trading", code: "acc", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" })).provisioning.complete, true);
  await as(() => new M.Admin({ name: "owner", email: "owner@acc.test", password: PASSWORD, status: "active", isActive: true, type: "super_admin" }).save());
  T.owner = await login("owner@acc.test");
  S.customer = String((await as(() => new M.Customer({ customerId: "CUST001", customerName: "Al Noor Trading", contactPerson: "Ali Hassan", email: "ali@alnoor.test", phone: "0501234567", paymentTerms: "Net 30", creditLimit: 10000000, trnNumber: "100999888700003", billingAddress: "Deira, Dubai" }).save()))._id);
  S.item = String((await as(() => new M.Stock({ itemId: "RICE5", sku: "RICE5", itemName: "Rice 5kg", category: new mongoose.Types.ObjectId(), currentStock: 1000 }).save()))._id);
  S.tax = (await api("owner", "GET", "/accounting/tax-codes")).body.find((c) => c.kind === "standard")?._id;
  for (const [code, name] of [["shj", "Sharjah"], ["dxb", "Dubai"]]) {
    const made = await api("owner", "POST", "/branches", { code, name });
    assert.equal(made.status, 201, JSON.stringify(made.data));
  }
  // a head-office manager who is only a viewer in Sharjah; a Sharjah operator who may also look at Dubai; a manager like any other
  await addPerson("hq_mgr", "manager", { branchRoles: [{ branchId: "shj", role: "viewer" }] });
  await addPerson("shj_clerk", "operator", { branchId: "shj", branchRoles: [{ branchId: "dxb", role: "viewer" }] });
  await addPerson("plain_mgr", "manager");
});

test("the users list says where each person holds another role, by name", { skip }, async () => {
  const people = (await api("owner", "GET", "/access/users")).body;
  const hq = people.find((p) => p.email === "hq_mgr@acc.test");
  assert.equal(hq.role.key, "manager");
  assert.deepEqual(hq.branchRoles.map((b) => [b.branchId, b.role.key, b.role.name]), [["shj", "viewer", "Viewer"]]);
  assert.deepEqual(people.find((p) => p.email === "plain_mgr@acc.test").branchRoles, []);
});

test("a head-office person holds their own role at head office and the given role in that branch", { skip }, async () => {
  const home = (await statusAt("hq_mgr")).body;
  assert.equal(home.me.role.key, "manager");
  assert.ok(home.me.grants.includes("sales.approve"));
  const shj = (await statusAt("hq_mgr", "shj")).body;
  assert.equal(shj.me.role.key, "viewer", "in Sharjah they are a viewer");
  assert.ok(!shj.me.grants.includes("sales.approve") && !shj.me.grants.includes("sales.create"));
  assert.deepEqual(shj.me.branchRoles, [{ branchId: "shj", roleKey: "viewer", roleName: "Viewer" }]);
  assert.equal(shj.branch.code, "shj");

  // the server holds them to it
  assert.equal((await api("hq_mgr", "POST", "/transactions/transactions", order(1), "shj")).status, 403, "a viewer adds nothing in Sharjah");
  assert.equal((await api("hq_mgr", "POST", "/transactions/transactions", order(1), "shj")).code, "PERMISSION_DENIED");
  assert.equal((await api("hq_mgr", "POST", "/transactions/transactions", order(1), "dxb")).status, 201, "in Dubai they are a manager again");
  assert.equal((await api("hq_mgr", "POST", "/transactions/transactions", order(1))).status, 201, "and at head office");
});

test("someone whose role differs by branch works in one branch at a time: there is no all-branches view for them", { skip }, async () => {
  const all = (await statusAt("hq_mgr", "all")).body;
  assert.equal(all.branch.view, "main", "asking for all branches puts them at head office");
  assert.equal(all.branch.canViewAll, false);
  assert.equal(all.branch.canSwitch, true);
  assert.equal((await statusAt("hq_mgr")).body.branch.view, "main", "and so does asking for nothing");
  // while a manager like any other still has it
  const plain = (await statusAt("plain_mgr", "all")).body;
  assert.equal(plain.branch.view, null);
  assert.equal(plain.branch.canViewAll, true);
  assert.equal((await statusAt("owner")).body.branch.canViewAll, true);
});

test("a branch person works in their own branch and in the branches they were given, and nowhere else", { skip }, async () => {
  const own = (await statusAt("shj_clerk")).body;
  assert.equal(own.branch.code, "shj");
  assert.equal(own.me.role.key, "operator");
  assert.deepEqual(own.branches.map((b) => b.code).sort(), ["dxb", "shj"], "they are offered the two");
  assert.equal(own.branch.canSwitch, true);
  assert.equal(own.branch.canViewAll, false);

  const dxb = (await statusAt("shj_clerk", "dxb")).body;
  assert.equal(dxb.me.role.key, "viewer", "in Dubai they are a viewer");
  assert.equal(dxb.branch.code, "dxb");

  for (const where of ["main", "all", "nowhere"]) {
    const r = await statusAt("shj_clerk", where);
    assert.equal(r.status, 403, where);
    assert.equal(r.code, "BRANCH_NOT_ALLOWED", where);
  }
  assert.equal((await api("shj_clerk", "POST", "/transactions/transactions", order(1))).status, 201, "an operator adds at Sharjah");
  assert.equal((await api("shj_clerk", "POST", "/transactions/transactions", order(1), "dxb")).code, "PERMISSION_DENIED", "and only looks at Dubai");
});

test("what a person sees in a branch is that branch's documents, whichever role they hold there", { skip }, async () => {
  const mine = await api("owner", "POST", "/transactions/transactions", order(2), "dxb");
  assert.equal(mine.status, 201, JSON.stringify(mine.data));
  S.dxbDoc = mine.body._id;
  const atDxb = (await api("shj_clerk", "GET", "/transactions/transactions?type=sales_order&limit=50", undefined, "dxb")).data.data;
  assert.ok(atDxb.some((t) => t._id === S.dxbDoc), "the clerk looking at Dubai sees Dubai's document");
  const atShj = (await api("shj_clerk", "GET", "/transactions/transactions?type=sales_order&limit=50")).data.data;
  assert.ok(atShj.length > 0 && atDxb.length > 0, "both have something to show");
  const atShjIds = new Set(atShj.map((t) => t._id));
  assert.equal(atDxb.some((t) => atShjIds.has(t._id)), false, "the two branches' lists share nothing");
  assert.equal(atShjIds.has(S.dxbDoc), false, "at Sharjah, Dubai's document is not listed");
  assert.equal((await api("shj_clerk", "GET", `/transactions/transactions/${S.dxbDoc}`)).status, 404, "Dubai's document is not Sharjah's to open");
});

test("branch roles are checked: a real branch, a real role, one role per branch, a list", { skip }, async () => {
  const hq = await idOf("hq_mgr@acc.test");
  const patch = (branchRoles) => api("owner", "PATCH", `/access/users/${hq}`, { branchRoles });
  assert.equal((await patch([{ branchId: "atlantis", role: "viewer" }])).code, "BRANCH_NOT_FOUND");
  assert.equal((await patch([{ branchId: "dxb", role: "wizard" }])).code, "ROLE_NOT_FOUND");
  assert.equal((await patch([{ branchId: "dxb", role: "viewer" }, { branchId: "dxb", role: "operator" }])).code, "DUPLICATE_BRANCH_ROLE");
  assert.equal((await patch("everywhere")).code, "BRANCH_ROLES_INVALID");
  assert.equal((await patch([{ branchId: "dxb" }])).code, "BRANCH_ROLES_INVALID");
  assert.equal((await api("owner", "POST", "/access/users", { name: "Xavier Xu", email: "x@acc.test", password: PASSWORD, role: "viewer", branchRoles: [{ branchId: "atlantis", role: "viewer" }] })).code, "BRANCH_NOT_FOUND", "when adding someone, too");
  const row = await as(() => M.Admin.findById(hq).lean());
  assert.deepEqual(row.branchRoles.map((b) => b.branchId), ["shj"], "none of that changed anything");
});

test("giving a branch role is limited by rank, and nobody gives themselves one", { skip }, async () => {
  const made = await api("owner", "POST", "/access/roles", { key: "people_lead", name: "People lead", rank: 60, permissions: ["users.view", "users.manage"] });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  await addPerson("people_lead", "people_lead");
  const target = await idOf("plain_mgr@acc.test");
  // a role at or above their own rank is not theirs to give, in a branch either
  const clerk = await idOf("shj_clerk@acc.test");
  const tooHigh = await api("people_lead", "PATCH", `/access/users/${clerk}`, { branchRoles: [{ branchId: "dxb", role: "admin" }] });
  assert.equal(tooHigh.status, 403, JSON.stringify(tooHigh.data));
  const fine = await api("people_lead", "PATCH", `/access/users/${clerk}`, { branchRoles: [{ branchId: "dxb", role: "viewer" }] });
  assert.equal(fine.status, 200, JSON.stringify(fine.data));
  // a person above them is out of reach whatever the branch
  assert.equal((await api("people_lead", "PATCH", `/access/users/${target}`, { branchRoles: [{ branchId: "dxb", role: "viewer" }] })).status, 403);
  // nobody changes their own
  const self = await api("people_lead", "PATCH", `/access/users/${await idOf("people_lead@acc.test")}`, { branchRoles: [{ branchId: "dxb", role: "viewer" }] });
  assert.equal(self.status, 403);
  assert.equal(self.code, "CANNOT_CHANGE_SELF");
});

test("a request body cannot give a person a branch role: only the users API does", { skip }, async () => {
  const own = await api("plain_mgr", "PUT", "/profile/me", { name: "Plain", branchRoles: [{ branchId: "shj", roleKey: "super_admin" }] });
  assert.ok(own.status === 200 || own.status === 400, `${own.status}`);
  const row = await as(() => M.Admin.findOne({ email: "plain_mgr@acc.test" }).lean());
  assert.deepEqual(row.branchRoles || [], []);
  const viaOld = await api("owner", "PUT", `/${await idOf("plain_mgr@acc.test")}`, { name: "Plain", branchRoles: [{ branchId: "shj", roleKey: "super_admin" }] });
  assert.ok(viaOld.status >= 200);
  assert.deepEqual((await as(() => M.Admin.findOne({ email: "plain_mgr@acc.test" }).lean())).branchRoles || [], [], "the older account routes ignore it too");
});

test("a change of branch roles bites on the very next request with the same token", { skip }, async () => {
  const hq = await idOf("hq_mgr@acc.test");
  assert.equal((await statusAt("hq_mgr", "shj")).body.me.role.key, "viewer");
  assert.equal((await api("owner", "PATCH", `/access/users/${hq}`, { branchRoles: [{ branchId: "shj", role: "operator" }] })).status, 200);
  const now = (await statusAt("hq_mgr", "shj")).body;
  assert.equal(now.me.role.key, "operator", "the same token, a new role in Sharjah");
  assert.equal((await api("hq_mgr", "POST", "/transactions/transactions", order(1), "shj")).status, 201, "now they may add there");
  assert.equal((await api("owner", "PATCH", `/access/users/${hq}`, { branchRoles: [] })).status, 200);
  const cleared = (await statusAt("hq_mgr", "shj")).body;
  assert.equal(cleared.me.role.key, "manager", "with none given, their own role everywhere again");
  assert.equal((await statusAt("hq_mgr", "all")).body.branch.view, null, "and the all-branches view is back");
  assert.deepEqual(cleared.me.branchRoles, []);
});

test("a role someone holds in a branch cannot be removed or switched off, and is counted", { skip }, async () => {
  assert.equal((await api("owner", "POST", "/access/roles", { key: "shj_auditor", name: "Sharjah auditor", rank: 30, permissions: ["sales.view", "audit.view"] })).status, 201);
  const hq = await idOf("hq_mgr@acc.test");
  assert.equal((await api("owner", "PATCH", `/access/users/${hq}`, { branchRoles: [{ branchId: "shj", role: "shj_auditor" }] })).status, 200);
  const roles = (await api("owner", "GET", "/access/roles")).body.roles;
  assert.equal(roles.find((r) => r.key === "shj_auditor").people, 1, "counted where it is held");
  const off = await api("owner", "PATCH", "/access/roles/shj_auditor", { isActive: false });
  assert.equal(off.code, "ROLE_IN_USE");
  const del = await api("owner", "DELETE", "/access/roles/shj_auditor");
  assert.equal(del.code, "ROLE_IN_USE");
  assert.equal((await api("owner", "PATCH", `/access/users/${hq}`, { branchRoles: [] })).status, 200);
  assert.equal((await api("owner", "DELETE", "/access/roles/shj_auditor")).status, 200, "once nobody holds it");
});
