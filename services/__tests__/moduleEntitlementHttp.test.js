// The MODULES an organisation was sold, enforced on real requests against a strict server. The claim worth
// proving is one: the organisation's OWNER, whose role is every permission there is, is refused a module the
// organisation did not buy - and is told it is the plan, not their role. Also that the ceiling applies on a
// token already held, that the pick lists survive a module being switched off, that the role editor is drawn
// without what cannot be held, that nobody can build a role beyond the ceiling, and that a second
// organisation is untouched.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_mod_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3760 + Math.floor(Math.random() * 180);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PASSWORD = "12312312";
const DAY = 24 * 3600 * 1000;

let child, M, Org, ctx, Usage;
let logs = "";
const T = {};
const ORGS = ["acme", "delta"]; // acme bought the whole product, delta bought trading only

async function call(method, url, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode, details: data?.details, headers: res.headers };
}
const as = (code, fn) => ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const api = (org, method, url, body) => call(method, url, { token: T[org].token, body });
// The developer's changes, made straight to the organisation row: the server reads it fresh on every request.
const setOrg = (code, $set) => M.Organisation.updateOne({ code }, { $set });
const endOfDay = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * DAY);
  d.setUTCHours(23, 59, 59, 999);
  return d;
};

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0", SUPPORT_CONTACT: "help@zarvia.example" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = {
    Admin: require("../../models/core/adminModel"),
    Organisation: require("../../models/core/organisationModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Stock: require("../../models/modules/stockModel"),
    Transaction: require("../../models/modules/transactionModel"),
  };
  Org = require("../core/organisationService");
  Usage = require("../core/usageService");
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

const PLAN = { acme: "premium", delta: "trading" };

// Each case sets delta's overrides and puts them back; this is the safety net, so one failing assertion cannot
// leave a module switched off and fail every case after it (which is what the mutation check showed it doing).
test.afterEach(async () => {
  if (!skip) await setOrg("delta", { moduleOverrides: {} });
});

test("two organisations, one that bought the whole product and one that bought trading only", { skip }, async () => {
  for (const code of ORGS) {
    const made = await Org.create({ legalName: `${code} Trading`, code, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: PLAN[code] });
    assert.equal(made.provisioning.complete, true, `${code}: provisioned`);
    await as(code, () => new M.Admin({ name: `${code}-boss`, email: `${code}-boss@test.uae`, password: PASSWORD, type: "super_admin", status: "active", isActive: true }).save());
    const r = await call("POST", "/login", { body: { email: `${code}-boss@test.uae`, password: PASSWORD } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    T[code] = { token: r.body.tokens.accessToken };
  }
});

test("the owner of the trading organisation is refused what it did not buy, and told it is the plan", { skip }, async () => {
  // Their role is super_admin: every permission in the catalogue. The ceiling is the organisation's, not theirs.
  const status = await api("delta", "GET", "/organisation/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.me.role.key, "super_admin");
  assert.equal(status.body.modules.finance.on, false, "the status says which modules it holds");
  assert.equal(status.body.modules.sales.full, true);
  assert.deepEqual(status.body.modules.reports.actions, ["view"], "Reports was sold as far as looking only");
  assert.equal(status.body.me.grants.some((g) => g.startsWith("finance.")), false, "the owner's own grants are capped");
  assert.equal(status.body.me.grants.includes("sales.approve"), true);
  assert.equal(status.body.me.grants.includes("lookups.view"), true);

  for (const [url, module] of [["/vouchers/vouchers", "finance"], ["/accounting/account-configuration", "accounts"], ["/accounting/reports/general-ledger", "reports"], ["/accounting/audit-log", "audit"]]) {
    const r = await api("delta", "GET", url);
    assert.equal(r.status, 403, `${url}: ${JSON.stringify(r.data)}`);
    assert.equal(r.code, "MODULE_NOT_IN_PLAN", `${url} is refused as the plan, not as the person's role`);
    assert.equal(r.details.module, module);
    assert.equal(r.details.plan, "trading");
    assert.match(r.data.message, /not included in this organisation's plan/);
  }

  // what it did buy answers as it always did
  assert.equal((await api("delta", "GET", "/transactions/transactions?type=sales_order")).status, 200, "Sales was bought");
  assert.equal((await api("delta", "GET", "/stock/stock")).status, 200, "Inventory was bought");
  assert.equal((await api("delta", "GET", "/dashboard-summary/")).status, 200, "reports.view is the floor: the first screen always opens");

  // and the organisation that bought everything is untouched
  assert.equal((await api("acme", "GET", "/vouchers/vouchers")).status, 200);
  assert.equal((await api("acme", "GET", "/accounting/reports/general-ledger")).status, 200);
});

test("a module refusal writes no PERMISSION_DENIED row: nobody in the organisation can act on it", { skip }, async () => {
  const Audit = require("../../models/modules/financial/activityLogModel");
  const before = await as("delta", () => Audit.countDocuments({ action: "PERMISSION_DENIED" }));
  assert.equal((await api("delta", "GET", "/vouchers/vouchers")).code, "MODULE_NOT_IN_PLAN");
  await new Promise((r) => setTimeout(r, 300)); // the row, if any, is written without being waited for
  const after = await as("delta", () => Audit.countDocuments({ action: "PERMISSION_DENIED" }));
  assert.equal(after, before, "a plan boundary is not a person hitting a wall their administrator can open");
});

test("a module switched on by the developer applies to the next request on the SAME token", { skip }, async () => {
  await setOrg("delta", { "moduleOverrides.finance": true });
  assert.equal((await api("delta", "GET", "/vouchers/vouchers")).status, 200, "no new sign-in needed");
  // sold in part: how much of it was sold is the ceiling too
  await setOrg("delta", { "moduleOverrides.finance": ["view"] });
  assert.equal((await api("delta", "GET", "/vouchers/vouchers")).status, 200, "finance.view was sold");
  const create = await api("delta", "POST", "/vouchers/vouchers", { voucherType: "journal", ledgerBased: true, date: new Date().toISOString(), lines: [] });
  assert.equal(create.status, 403, JSON.stringify(create.data));
  assert.equal(create.code, "MODULE_NOT_IN_PLAN", "finance.create was not");
  await setOrg("delta", { moduleOverrides: {} });
  assert.equal((await api("delta", "GET", "/vouchers/vouchers")).code, "MODULE_NOT_IN_PLAN", "back to the plan");
});

test("switching a module off does not shut the forms that pick from it", { skip }, async () => {
  // Inventory off: the item screens are refused, but the pick lists a sales form fills itself from are not,
  // because every route that offers them accepts lookups.view - which is the floor.
  await setOrg("delta", { "moduleOverrides.inventory": false });
  assert.equal((await api("delta", "GET", "/inventory/inventory")).code, "MODULE_NOT_IN_PLAN", "the movements screen is gone");
  assert.equal((await api("delta", "GET", "/stock/stock")).status, 200, "the item pick list still answers");
  assert.equal((await api("delta", "GET", "/categories/categories")).status, 200);
  await setOrg("delta", { moduleOverrides: {} });
});

test("everything switched off still leaves the floor: the pick lists, the letterhead, the first screen", { skip }, async () => {
  const plans = require("../../utils/plans");
  await setOrg("delta", { moduleOverrides: Object.fromEntries(plans.MODULE_KEYS.map((m) => [m, false])) });
  assert.equal((await api("delta", "GET", "/organisation/status")).status, 200, "a person can always find out what they may do");
  assert.equal((await api("delta", "GET", "/dashboard-summary/")).status, 200);
  assert.equal((await api("delta", "GET", "/company/profile")).status, 200, "the letterhead is printed on every document");
  assert.equal((await api("delta", "GET", "/stock/stock")).status, 200);
  assert.equal((await api("delta", "GET", "/transactions/transactions?type=sales_order")).code, "MODULE_NOT_IN_PLAN");
  await setOrg("delta", { moduleOverrides: {} });
});

test("the role editor is drawn without what the organisation cannot hold, and no role can be built beyond it", { skip }, async () => {
  const roles = await api("delta", "GET", "/access/roles");
  assert.equal(roles.status, 200, JSON.stringify(roles.data));
  const keys = roles.body.catalogue.map((m) => m.key);
  assert.equal(keys.includes("sales"), true);
  assert.equal(keys.includes("finance"), false, "a module with nothing left is not offered as a tick");
  assert.deepEqual(roles.body.catalogue.find((m) => m.key === "reports").actions.map((a) => a.action), ["view"]);

  const made = await api("delta", "POST", "/access/roles", { key: "book_keeper", name: "Book keeper", rank: 50, permissions: ["finance.create"] });
  assert.equal(made.status, 400, JSON.stringify(made.data));
  assert.equal(made.code, "ROLE_INVALID");
  assert.match(JSON.stringify(made.details), /cannot grant what you do not hold/);

  // the same role is fine in the organisation that bought Finance
  const ok = await api("acme", "POST", "/access/roles", { key: "book_keeper", name: "Book keeper", rank: 50, permissions: ["finance.create"] });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal((await api("acme", "GET", "/access/roles")).body.catalogue.some((m) => m.key === "finance"), true);
});

test("a developer cannot store a module override that means nothing", { skip }, async () => {
  await assert.rejects(() => Org.update("delta", { moduleOverrides: { ledger: true } }), (e) => e.code === "MODULES_INVALID" && /Not a known module/.test(e.message));
  await assert.rejects(() => Org.update("delta", { moduleOverrides: { reports: ["view", "bogus"] } }), (e) => e.code === "MODULES_INVALID");
  const saved = await Org.update("delta", { moduleOverrides: { reports: ["view", "financial"] } });
  assert.deepEqual(saved.moduleOverrides.reports, ["view", "financial"]);
  assert.equal((await api("delta", "GET", "/accounting/reports/general-ledger")).status, 200, "reports.financial was added for this organisation alone");
  await Org.update("delta", { resetModules: ["reports"] });
  assert.equal((await api("delta", "GET", "/accounting/reports/general-ledger")).code, "MODULE_NOT_IN_PLAN", "and taken away again");
});

test("a custom role made while a module was sold grants nothing of it once it is not", { skip }, async () => {
  // Finance is switched on for this organisation, an administrator builds a role around it, someone is put on it
  await setOrg("delta", { "moduleOverrides.finance": true });
  const role = await api("delta", "POST", "/access/roles", { key: "cashier", name: "Cashier", rank: 40, permissions: ["finance.create", "sales.view"] });
  assert.equal(role.status, 201, JSON.stringify(role.data));
  const person = await api("delta", "POST", "/access/users", { name: "Cash Desk", email: "cashier@delta.test", password: "cashier-pass-1", role: "cashier" });
  assert.equal(person.status, 201, JSON.stringify(person.data));
  const signIn = await call("POST", "/login", { body: { email: "cashier@delta.test", password: "cashier-pass-1" } });
  assert.equal(signIn.status, 200, JSON.stringify(signIn.data));
  const token = signIn.body.tokens.accessToken;
  const asCashier = (method, url, body) => call(method, url, { token, body });
  assert.equal((await asCashier("GET", "/vouchers/vouchers")).status, 200, "while it is sold");

  // the developer takes Finance away. The role still names it; the person holds none of it, at once.
  await setOrg("delta", { "moduleOverrides.finance": false });
  const refused = await asCashier("GET", "/vouchers/vouchers");
  assert.equal(refused.code, "MODULE_NOT_IN_PLAN", JSON.stringify(refused.data));
  const status = await asCashier("GET", "/organisation/status");
  assert.equal(status.body.me.role.key, "cashier", "they keep their role");
  assert.equal(status.body.me.grants.some((g) => g.startsWith("finance.")), false);
  assert.equal(status.body.me.grants.includes("sales.view"), true, "the rest of the role is untouched");

  // and the stored role is still there, listed, and can be saved again without the permission nobody can hold
  const listed = (await api("delta", "GET", "/access/roles")).body.roles.find((r) => r.key === "cashier");
  assert.ok(listed, "a role naming a permission the organisation no longer holds still lists");
  const saved = await api("delta", "PATCH", "/access/roles/cashier", { name: "Cash desk", rank: 40, permissions: ["sales.view"] });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  await setOrg("delta", { moduleOverrides: {} });
});
