// The plan, the limits and the subscription, ENFORCED on real requests against a strict server: an optional
// feature that is switched off is refused, the number of people and the documents in a month stop at their
// limit, and an organisation past the end of its subscription is blocked (or read-only, or given grace), at
// sign-in and on a token it already holds. A second organisation on the same plan is never touched.
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
const DAY = 24 * 3600 * 1000;

let child, M, Org, ctx, Usage;
let logs = "";
const T = {};
const ORGS = ["acme", "bravo"];

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
    Stock: require("../../models/modules/stockModel"),
    Transaction: require("../../models/modules/transactionModel"),
  };
  Org = require("../core/organisationService");
  Usage = require("../core/usageService");
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

test("two organisations on the standard plan, each with a signed-in owner and something to sell", { skip }, async () => {
  for (const code of ORGS) {
    const made = await Org.create({ legalName: `${code} Trading`, code, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "standard" });
    assert.equal(made.provisioning.complete, true, `${code}: provisioned`);
    await as(code, () => new M.Admin({ name: `${code}-boss`, email: `${code}-boss@test.uae`, password: PASSWORD, type: "super_admin", status: "active", isActive: true }).save());
    const r = await call("POST", "/login", { body: { email: `${code}-boss@test.uae`, password: PASSWORD } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.body.subscription.state, "active", "sign-in says where the subscription stands");
    T[code] = { token: r.body.tokens.accessToken };
    T[code].std = (await api(code, "GET", "/accounting/tax-codes")).body.find((c) => c.kind === "standard");
    await as(code, async () => {
      T[code].customer = String((await new M.Customer({ customerId: "C1", customerName: "Al Noor", contactPerson: "x", paymentTerms: "Net 30", creditLimit: 100000, trnNumber: "100999888700003", billingAddress: "Deira" }).save())._id);
      T[code].stock = String((await new M.Stock({ itemId: "RICE5", sku: "RICE5", itemName: "Rice 5kg", category: new mongoose.Types.ObjectId() }).save())._id);
    });
  }
});

test("a feature outside the plan is refused, switching it on takes effect at once, and the other organisation is untouched", { skip }, async () => {
  // the standard plan has no e-invoicing and no IFRS statements, but does have quotations
  const no = await api("acme", "GET", "/einvoice/settings");
  assert.equal(no.status, 403);
  assert.equal(no.code, "FEATURE_NOT_IN_PLAN");
  assert.equal(no.details.feature, "einvoicing");
  assert.equal((await api("acme", "GET", "/ifrs/financial-position")).code, "FEATURE_NOT_IN_PLAN");
  assert.equal((await api("acme", "GET", "/quotations")).status, 200, "in the plan");

  await setOrg("acme", { "featureOverrides.einvoicing": true, "featureOverrides.quotations": false });
  assert.notEqual((await api("acme", "GET", "/einvoice/settings")).code, "FEATURE_NOT_IN_PLAN", "switched on for this organisation, on the token it already holds");
  assert.equal((await api("acme", "GET", "/quotations")).code, "FEATURE_NOT_IN_PLAN", "switched off although the plan includes it");

  assert.equal((await api("bravo", "GET", "/einvoice/settings")).code, "FEATURE_NOT_IN_PLAN", "bravo still has the plan's defaults");
  assert.equal((await api("bravo", "GET", "/quotations")).status, 200);
  await setOrg("acme", { featureOverrides: {} });
});

test("cheques and cards need the banking feature, cash does not", { skip }, async () => {
  const PaymentModes = require("../banking/paymentModeService");
  await setOrg("acme", { "featureOverrides.banking": false });
  const resolve = (mode) => as("acme", () => PaymentModes.resolve({ direction: "receipt", mode, details: {}, amount: 100, date: new Date() }));
  await assert.rejects(() => resolve("cheque"), (e) => e.code === "FEATURE_NOT_IN_PLAN" && e.details.feature === "banking");
  await assert.rejects(() => resolve("card"), (e) => e.code === "FEATURE_NOT_IN_PLAN");
  const cash = await resolve("cash").then(() => null, (e) => e);
  assert.notEqual(cash?.code, "FEATURE_NOT_IN_PLAN", "cash is not a banking feature");
  await setOrg("acme", { featureOverrides: {} });
  const cheque = await resolve("cheque").then(() => null, (e) => e);
  assert.notEqual(cheque?.code, "FEATURE_NOT_IN_PLAN", "with banking on it gets past the plan (and is judged on its details)");
});

test("the number of people stops at the plan's limit, and lifting the limit lets the next one in", { skip }, async () => {
  const add = (org, n) => api(org, "POST", "/", { name: `User ${n}`, email: `u${n}-${org}@test.uae`, password: PASSWORD, type: "viewer" });
  await setOrg("acme", { "limitOverrides.users": 2 }); // the owner is one already
  assert.equal((await add("acme", 1)).status, 201);
  const full = await add("acme", 2);
  assert.equal(full.status, 403, JSON.stringify(full.data));
  assert.equal(full.code, "LIMIT_REACHED");
  assert.equal(full.details.resource, "users");
  assert.equal(full.details.limit, 2);
  assert.equal(full.details.used, 2);
  assert.match(full.data.message, /limited to 2 users/);
  assert.equal(await M.Admin.countDocuments({ email: `u2-acme@test.uae` }), 0, "nobody was created");
  assert.equal((await add("bravo", 1)).status, 201, "the other organisation has its own count and its own limit");
  await setOrg("acme", { "limitOverrides.users": null });
  assert.equal((await add("acme", 2)).status, 201, "unlimited for this organisation");
});

const order = (org, type = "sales_order") =>
  api(org, "POST", "/transactions/transactions", {
    type, partyId: T[org].customer, partyType: "Customer", partyTypeRef: "Customer", createdBy: "tester",
    items: [{ itemId: T[org].stock, description: "Rice 5kg", qty: 1, price: 10, rate: 10, vatPercent: 5, taxCodeId: T[org].std._id }],
  });

test("trade documents stop at the month's limit, counted on the organisation's own calendar month", { skip }, async () => {
  // an old document and an opening balance must not use up this month
  await M.Transaction.collection.insertMany([
    { companyId: "acme", branchId: "main", transactionNo: "OLD-1", type: "sales_order", createdAt: new Date(Date.now() - 45 * DAY), updatedAt: new Date() },
    { companyId: "acme", branchId: "main", transactionNo: "OPEN-1", type: "sales_order", isOpening: true, createdAt: new Date(), updatedAt: new Date() },
  ]);
  const used = await as("acme", async () => Usage.current(await Usage.organisation()));
  assert.equal(used.documentsPerMonth, 0, "neither an old document nor an opening balance counts");

  await setOrg("acme", { "limitOverrides.documentsPerMonth": 2 });
  assert.equal((await order("acme")).status, 201);
  assert.equal((await order("acme", "purchase_order")).status, 201);
  const over = await order("acme");
  assert.equal(over.status, 403, JSON.stringify(over.data));
  assert.equal(over.code, "LIMIT_REACHED");
  assert.equal(over.details.resource, "documentsPerMonth");
  assert.equal(over.details.limit, 2);
  assert.equal(over.details.used, 2);
  assert.equal(await as("acme", () => M.Transaction.countDocuments({ type: "sales_order", isOpening: { $ne: true }, createdAt: { $gte: new Date(Date.now() - DAY) } })), 1, "the refused document was not saved");

  assert.equal((await order("bravo")).status, 201, "bravo counts its own documents");
  await setOrg("acme", { "limitOverrides.documentsPerMonth": null });
  assert.equal((await order("acme")).status, 201, "lifted");
});

test("past the end of the subscription an organisation is blocked, at sign-in and on a token it already holds", { skip }, async () => {
  await setOrg("acme", { "subscription.endsAt": endOfDay(-1), "subscription.graceDays": 0, "subscription.onExpiry": "block" });

  const held = await api("acme", "GET", "/customers/customers");
  assert.equal(held.status, 403);
  assert.equal(held.code, "ORGANISATION_EXPIRED");
  assert.equal(held.details.state, "expired");
  assert.equal(held.details.contact, "help@zarvia.example");
  assert.ok(held.details.endsAt, "the screen can name the date");
  assert.equal((await api("acme", "POST", "/transactions/transactions", {})).code, "ORGANISATION_EXPIRED", "writes too");

  const login = await call("POST", "/login", { body: { email: "acme-boss@test.uae", password: PASSWORD } });
  assert.equal(login.status, 403);
  assert.equal(login.code, "ORGANISATION_EXPIRED");
  assert.match(login.data.message, /ended on/);

  const status = await api("acme", "GET", "/organisation/status");
  assert.equal(status.status, 200, "the one route that still answers, so the app can say why");
  assert.equal(status.body.subscription.state, "expired");
  assert.equal(status.body.subscription.blocked, true);

  assert.equal((await api("bravo", "GET", "/customers/customers")).status, 200, "another organisation is not affected");

  await setOrg("acme", { "subscription.endsAt": endOfDay(365) });
  assert.equal((await api("acme", "GET", "/customers/customers")).status, 200, "extended: the same token works again at once");
  assert.equal((await call("POST", "/login", { body: { email: "acme-boss@test.uae", password: PASSWORD } })).status, 200);
});

test("the grace period keeps working and announces itself; the last fortnight is warned about", { skip }, async () => {
  await setOrg("acme", { "subscription.endsAt": endOfDay(-1), "subscription.graceDays": 3 });
  const r = await api("acme", "GET", "/customers/customers");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-subscription-state"), "grace");
  assert.ok(Number(r.headers.get("x-subscription-days-left")) >= 1);
  assert.equal((await order("acme")).status, 201, "everything still works in grace");

  await setOrg("acme", { "subscription.endsAt": endOfDay(5), "subscription.graceDays": 0 });
  const soon = await api("acme", "GET", "/customers/customers");
  assert.equal(soon.headers.get("x-subscription-state"), "active");
  assert.ok(Number(soon.headers.get("x-subscription-days-left")) <= 6);

  await setOrg("acme", { "subscription.endsAt": endOfDay(365) });
  assert.equal((await api("acme", "GET", "/customers/customers")).headers.get("x-subscription-state"), null, "nothing to warn about");
});

test("a read-only organisation can sign in and read, but nothing can be changed", { skip }, async () => {
  await setOrg("acme", { "subscription.endsAt": endOfDay(-1), "subscription.graceDays": 0, "subscription.onExpiry": "readonly" });
  const login = await call("POST", "/login", { body: { email: "acme-boss@test.uae", password: PASSWORD } });
  assert.equal(login.status, 200, "it may sign in to look at its records");
  assert.equal(login.body.subscription.state, "expired");
  assert.equal(login.body.subscription.canWrite, false);

  assert.equal((await api("acme", "GET", "/customers/customers")).status, 200, "reading works");
  const write = await order("acme");
  assert.equal(write.status, 403);
  assert.equal(write.code, "ORGANISATION_READ_ONLY");
  assert.equal((await api("acme", "POST", "/", { name: "X", email: "x-ro@test.uae", password: PASSWORD, type: "viewer" })).code, "ORGANISATION_READ_ONLY");
  assert.equal((await order("bravo")).status, 201, "bravo trades as normal");

  await setOrg("acme", { "subscription.endsAt": endOfDay(365), "subscription.onExpiry": "block" });
});

test("a suspended organisation is blocked at once, whatever its dates say, until it is reopened", { skip }, async () => {
  await setOrg("acme", { status: "suspended" });
  const held = await api("acme", "GET", "/customers/customers");
  assert.equal(held.status, 403);
  assert.equal(held.code, "ORGANISATION_SUSPENDED");
  assert.equal((await call("POST", "/login", { body: { email: "acme-boss@test.uae", password: PASSWORD } })).code, "ORGANISATION_SUSPENDED");
  assert.equal((await api("bravo", "GET", "/customers/customers")).status, 200);
  await setOrg("acme", { status: "active" });
  assert.equal((await api("acme", "GET", "/customers/customers")).status, 200);
});

test("background jobs serve only organisations that are live and have the feature", { skip }, async () => {
  const names = async (opts) => [...(await Usage.liveCodes(opts))].filter((c) => ORGS.includes(c)).sort(); // the default organisation is on the internal plan: not part of this
  assert.deepEqual(await names(), ["acme", "bravo"]);
  assert.deepEqual(await names({ feature: "einvoicing" }), [], "the standard plan has no e-invoicing");
  assert.deepEqual(await names({ feature: "messaging" }), ["acme", "bravo"]);

  await setOrg("acme", { "subscription.endsAt": endOfDay(-1), "subscription.graceDays": 0, "subscription.onExpiry": "block" });
  assert.deepEqual(await names({ feature: "messaging" }), ["bravo"], "nothing is sent for an expired organisation");
  await setOrg("acme", { "subscription.onExpiry": "readonly" });
  assert.deepEqual(await names({ feature: "messaging" }), ["bravo"], "nor for a read-only one: it cannot change anything");
  await setOrg("acme", { "subscription.endsAt": endOfDay(365), "subscription.onExpiry": "block", status: "suspended" });
  assert.deepEqual(await names({ feature: "messaging" }), ["bravo"], "nor a suspended one");
  await setOrg("acme", { status: "active" });
  assert.deepEqual(await names({ feature: "messaging" }), ["acme", "bravo"]);

  // the jobs that run for every organisation skip the locked ones too
  await setOrg("bravo", { "subscription.endsAt": endOfDay(-1), "subscription.graceDays": 0 });
  const seen = (await Org.forEach((code) => code, { label: "test" })).map((r) => r.code);
  assert.deepEqual(seen.filter((c) => ORGS.includes(c)), ["acme"]);
  const all = (await Org.forEach((code) => code, { label: "test", includeLocked: true })).map((r) => r.code);
  assert.ok(all.includes("bravo"));
  await setOrg("bravo", { "subscription.endsAt": null });
});

test("the status route tells a screen what it may show", { skip }, async () => {
  const s = (await api("acme", "GET", "/organisation/status")).body;
  assert.equal(s.organisation.code, "acme");
  assert.equal(s.organisation.baseCurrency, "AED");
  assert.equal(s.organisation.planName, "Standard");
  assert.equal(s.features.einvoicing, false);
  assert.equal(s.features.quotations, true);
  assert.equal(s.limits.users, null, "the override from the earlier test is the limit now");
  assert.ok(s.usage.users >= 2 && s.usage.documentsPerMonth >= 3);
  assert.equal(s.room.branches.limit, 3);
  assert.equal((await call("GET", "/organisation/status")).status, 401, "and it needs a sign-in");
});
