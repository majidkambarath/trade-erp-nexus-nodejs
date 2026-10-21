// The CRM sold on its own, over HTTP against a strict server with real sign-ins.
//
// Two organisations on one throwaway database: SOLO is on the CRM-only plan (no Sales, no Inventory, no books), FULL is on
// Premium and is the control - everything that works for SOLO must be a change for SOLO only.
//
// What is proved: a CRM-only organisation can do the one thing the module exists for (qualify a lead into a customer),
// while the Sales module it did not buy stays shut; the customer pick list the deal form uses is narrow and needs no Sales
// key; where Sales WAS bought, qualifying still asks for the Sales key exactly as before; a spreadsheet of leads and of
// people is previewed before it is written, never imported by accident, safe to run twice, and audited without the rows;
// and files on a lead or a deal are the CRM's own - another module's file id, another organisation's and an
// executable renamed .pdf are all refused.
//
// A refusal must be the server's own 403/404. An allowed call only has to get PAST the gate.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const UPLOADS = path.join(ROOT, "uploads", "attachments");
const PASSWORD = "12312312";
const FAKE_ID = "64b64b64b64b64b64b64b64b";

let child, M, Org, ctx;
let logs = "";
const T = {};
const S = {};

async function call(method, url, { body, token, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, headers: res.headers, res, data, body: data?.data, code: data?.errorCode, details: data?.details };
}
const as = (fn, company = "solo") => ctx.runWithTenant({ companyId: company, branchId: "main" }, fn);
const api = (who, method, url, body) => call(method, url, { token: T[who], body: method === "GET" || method === "DELETE" ? undefined : body });
const login = async (email) => (await call("POST", "/login", { body: { email, password: PASSWORD } })).body?.tokens?.accessToken;

const cannot = async (who, method, url, body, code = "PERMISSION_DENIED") => {
  const r = await api(who, method, url, body);
  assert.equal(r.status, 403, `${who} ${method} ${url} should be refused: ${r.status} ${JSON.stringify(r.data)?.slice(0, 200)}`);
  assert.equal(r.code, code, `${who} ${method} ${url}`);
  return r;
};

// A person with exactly these permissions, in the organisation whose owner is `${org}_owner`.
async function person(org, key, permissions) {
  const role = `${org}_${key}`;
  const made = await api(`${org}_owner`, "POST", "/access/roles", { key: role, name: role.replace(/_/g, " "), rank: 50, permissions });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const added = await api(`${org}_owner`, "POST", "/access/users", { name: role, email: `${role}@${org}.test`, password: PASSWORD, role });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  await as(() => M.Admin.updateOne({ email: `${role}@${org}.test` }, { $set: { mustChangePassword: false } }), org);
  T[role] = await login(`${role}@${org}.test`);
  assert.ok(T[role], `${role} signs in`);
}

async function organisation(code, planCode) {
  const made = await Org.create({ legalName: `${code} works`, code, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode });
  assert.equal(made.provisioning.complete, true, `${code} is provisioned`);
  await as(() => new M.Admin({ name: `${code} owner`, email: `${code}_owner@${code}.test`, password: PASSWORD, status: "active", isActive: true, type: "super_admin" }).save(), code);
  T[`${code}_owner`] = await login(`${code}_owner@${code}.test`);
  assert.ok(T[`${code}_owner`], `${code} owner signs in`);
}

const enquiry = (over = {}) => ({ name: "Hassan Al Noor", company: "Al Noor Foods", phone: "0501234567", source: "referral", expectedValue: 45000, ...over });
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");

async function upload(who, url, filename, bytes, label) {
  const form = new FormData();
  form.append("file", new Blob([bytes]), filename);
  if (label) form.append("label", label);
  return call("POST", url, { token: T[who], form });
}

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  // ATTACHMENT_STORAGE=disk: the server inherits the Cloudinary account from .env, and a test must never upload there.
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0", ATTACHMENT_STORAGE: "disk" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = {
    Admin: require("../../models/core/adminModel"),
    Customer: require("../../models/modules/customerModel"),
    Lead: require("../../models/modules/crm/leadModel"),
    Contact: require("../../models/modules/crm/contactModel"),
    Opportunity: require("../../models/modules/crm/opportunityModel"),
    CrmActivity: require("../../models/modules/crm/crmActivityModel"),
    Attachment: require("../../models/modules/financial/attachmentModel"),
    ActivityLog: require("../../models/modules/financial/activityLogModel"),
    LedgerAccount: require("../../models/modules/financial/financialModels").LedgerAccount,
  };
  Org = require("../core/organisationService");
  ctx = require("../../utils/tenantContext");
  await mongoose.connection.syncIndexes();
  const deadline = Date.now() + 90000;
  for (;;) {
    try {
      const h = await fetch(`${BASE}/health`);
      if (h.ok && (await h.json()).ready !== false) break;
    } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.after(async () => {
  if (skip) return;
  child?.kill();
  if (mongoose.connection.readyState === 1) {
    assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
    // the files this run wrote to the server's own disk: the database goes, so nothing else will ever name them
    const rows = await mongoose.connection.collection("attachments").find({}).project({ key: 1, storage: 1 }).toArray();
    for (const r of rows) if (r.storage === "disk") fs.rmSync(path.join(UPLOADS, ...String(r.key).split("/")), { force: true });
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

// ---- the organisations ---------------------------------------------------------------------------------------------

test("a CRM-only organisation and a Premium one, each with the people it needs", { skip }, async () => {
  await organisation("solo", "crm");
  await organisation("full", "premium");

  await person("solo", "looker", ["crm.view"]);
  await person("solo", "editor", ["crm.view", "crm.edit"]); // may change a lead; may not add one
  await person("solo", "chaser", ["crm.view", "crm.create", "crm.edit"]);
  await person("full", "looker", ["crm.view"]); // the CRM and nothing of Sales
  await person("full", "chaser", ["crm.view", "crm.create", "crm.edit"]);
  await person("full", "closer", ["crm.view", "crm.create", "crm.edit", "sales.create"]);
});

test("the status tells the screen this organisation bought the CRM and nothing of the trade", { skip }, async () => {
  const solo = await api("solo_owner", "GET", "/organisation/status");
  assert.equal(solo.status, 200, JSON.stringify(solo.data));
  assert.equal(solo.body.modules.crm.on, true);
  assert.equal(solo.body.modules.users.on, true, "its owner can add the colleagues who will use it");
  for (const off of ["sales", "purchase", "inventory", "finance", "banking", "accounts"]) assert.equal(solo.body.modules[off].on, false, off);
  const grants = solo.body.me.grants;
  assert.ok(grants.includes("crm.manage") && grants.includes("users.manage"));
  assert.ok(!grants.some((g) => /^(sales|purchase|inventory|finance|banking|accounts)\./.test(g)), "not even the owner holds a trade key");

  const full = await api("full_owner", "GET", "/organisation/status");
  assert.equal(full.body.modules.sales.on, true);
});

// ---- qualifying ----------------------------------------------------------------------------------------------------

test("a CRM-only organisation can qualify a lead into a real customer - the thing the module is for", { skip }, async () => {
  const made = await api("solo_owner", "POST", "/crm/leads", enquiry());
  assert.equal(made.status, 201, JSON.stringify(made.data));
  S.lead = made.body._id;

  const done = await api("solo_owner", "POST", `/crm/leads/${S.lead}/qualify`, {});
  assert.equal(done.status, 201, `it used to be 403 here: ${JSON.stringify(done.data)}`);
  S.customerId = done.body.customerId;
  S.deal = done.body.opportunity._id;
  assert.equal(done.body.lead.status, "CONVERTED");
  assert.equal(done.body.opportunity.stageKey, "new");

  const customer = await as(() => M.Customer.findById(S.customerId).lean());
  assert.equal(customer.customerName, "Al Noor Foods");
  const account = await as(() => M.LedgerAccount.findOne({ accountName: /^Customer - Al Noor Foods/ }).lean());
  assert.ok(account, "the customer has its ledger account, exactly as one made through Sales has");
  const people = await as(() => M.Contact.find({ customerId: S.customerId }).lean());
  assert.equal(people.length, 1, "and the enquirer is a real contact of it");
});

test("qualifying still needs crm.create of a CRM-only person: editing a lead is not adding a customer", { skip }, async () => {
  const made = await api("solo_owner", "POST", "/crm/leads", enquiry({ name: "Second Enquirer", company: "Second Co", phone: "0507654321" }));
  S.lead2 = made.body._id;
  const refused = await cannot("solo_editor", "POST", `/crm/leads/${S.lead2}/qualify`, {});
  assert.deepEqual(refused.details.required, ["crm.create"], "the key it asks for is the CRM's own");
  assert.equal((await api("solo_chaser", "POST", `/crm/leads/${S.lead2}/qualify`, {})).status, 201);
});

test("the Sales module it did not buy stays shut, even to its owner", { skip }, async () => {
  for (const [method, url] of [
    ["GET", "/customers/customers"],
    ["GET", "/transactions/transactions"],
    ["GET", "/vouchers/vouchers"],
    ["POST", "/stock/stock"],
  ]) {
    const r = await api("solo_owner", method, url);
    assert.equal(r.status, 403, `${url} -> ${r.status}`);
    assert.equal(r.code, "MODULE_NOT_IN_PLAN", `${url} is refused as the plan, not as the person's role`);
  }
  // The item list is a pick list every form fills itself from (lookups.view, which every organisation holds), so it is
  // deliberately NOT shut: what stays shut is the module's own screens and every way of changing it.
  assert.equal((await api("solo_owner", "GET", "/stock/stock")).status, 200, "the pick list is open by design");
  const add = await api("solo_owner", "POST", "/customers", { customerName: "Back Door Ltd" });
  assert.equal(add.code, "MODULE_NOT_IN_PLAN", "qualifying is the way a customer is made in this plan, not the Sales route");
  assert.equal(await as(() => M.Customer.countDocuments({ customerName: "Back Door Ltd" })), 0);
});

test("where Sales WAS bought, qualifying asks for the Sales key exactly as it always did", { skip }, async () => {
  const made = await api("full_chaser", "POST", "/crm/leads", enquiry({ name: "Full Enquirer", company: "Full Co", phone: "0509998877" }));
  S.leadFull = made.body._id;
  const refused = await cannot("full_chaser", "POST", `/crm/leads/${S.leadFull}/qualify`, {});
  assert.deepEqual(refused.details.required, ["sales.create"], "crm.create does not stand in for it");
  const done = await api("full_closer", "POST", `/crm/leads/${S.leadFull}/qualify`, {});
  assert.equal(done.status, 201, JSON.stringify(done.data));
});

// ---- every screen the CRM draws has what it reads ---------------------------------------------------------------------

test("everything the CRM's screens read answers for the owner of a CRM-only organisation", { skip }, async () => {
  // The likeliest way for a CRM-only organisation to break is a CRM screen quietly reading a route that belongs to a module
  // it did not buy, and answering 403 where the screen expects a list. These are the reads each screen makes on the way up.
  const week = "from=2026-10-01&to=2026-10-31";
  const reads = [
    "/organisation/status", "/profile/me", "/notifications", "/notifications/unread-count", "/company/profile",
    "/crm/dashboard", "/crm/summary", "/crm/analysis", "/crm/pipeline", "/crm/owners", "/crm/customers", "/crm/timeline",
    "/crm/stages", "/crm/settings", "/crm/follow-ups", "/crm/follow-ups/count", "/crm/leads", "/crm/leads/summary",
    "/crm/leads/duplicates?phone=0501234567", "/crm/opportunities", "/crm/contacts", "/crm/activities",
    `/crm/calendar?${week}`, "/crm/reports/aging", `/crm/reports/activity?${week}`,
    `/crm/leads/${S.lead2}`, `/crm/leads/${S.lead2}/activity`, `/crm/opportunities/${S.deal}`, `/crm/opportunities/${S.deal}/activity`,
    "/access/users", "/access/roles",
  ];
  for (const url of reads) {
    const r = await api("solo_owner", "GET", url);
    assert.equal(r.status, 200, `${url} -> ${r.status} ${r.code || ""} ${JSON.stringify(r.data)?.slice(0, 160)}`);
  }
  // and the writes the CRM screens make, in one go: a follow-up, a deal moved by hand, the settings
  const followUp = await api("solo_owner", "POST", "/crm/activities", { kind: "call", subject: "Ring the buyer", regarding: { kind: "opportunity", id: S.deal }, dueAt: "2026-10-30" });
  assert.equal(followUp.status, 201, JSON.stringify(followUp.data));
  const moved = await api("solo_owner", "POST", `/crm/opportunities/${S.deal}/stage`, { stageKey: "qualified", note: "after the call" });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
});

test("a CRM-only owner can add the colleague who will use it, with the CRM's roles and none of the trade's", { skip }, async () => {
  const roles = await api("solo_owner", "GET", "/access/roles");
  const catalogue = JSON.stringify(roles.body.catalogue);
  assert.match(catalogue, /"crm"/, "the CRM's actions are offered in the role editor");
  assert.ok(!/"sales"|"finance"|"inventory"/.test(catalogue), "the trade's are not: a role cannot hold what was never sold");
  const tooMuch = await api("solo_owner", "POST", "/access/roles", { key: "greedy", name: "Greedy", rank: 40, permissions: ["crm.view", "sales.approve"] });
  assert.equal(tooMuch.status, 400, "a role may not grant a trade permission the organisation does not hold");
  const added = await api("solo_owner", "POST", "/access/users", { name: "Colleague", email: "colleague@solo.test", password: PASSWORD, role: "solo_chaser" });
  assert.equal(added.status, 201, JSON.stringify(added.data));
});

// ---- the customer pick list ------------------------------------------------------------------------------------------

test("the deal form's customer list is narrow, and needs no Sales key", { skip }, async () => {
  await as(() => M.Customer.create({ customerId: "CUST-DORMANT", customerName: "Dormant Co", contactPerson: "Nobody", status: "Inactive" }));
  const r = await api("solo_looker", "GET", "/crm/customers");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = r.body.find((c) => c.name === "Al Noor Foods");
  assert.ok(row, "the customer the lead became");
  assert.deepEqual(Object.keys(row).sort(), ["active", "code", "id", "name"], "a name and a code to choose by, and nothing else");
  assert.ok(!JSON.stringify(r.body).match(/creditLimit|cashBalance|phone|email|bankAccounts|totalSpent/), "none of the customer's money or contact details");
  assert.ok(!r.body.some((c) => c.name === "Dormant Co"), "an inactive customer is not offered");
  assert.ok((await api("solo_looker", "GET", "/crm/customers?status=all")).body.some((c) => c.name === "Dormant Co"), "unless asked for");
  assert.deepEqual((await api("solo_looker", "GET", "/crm/customers?search=zzzz-nobody")).body, []);
  assert.equal((await api("solo_looker", "GET", "/crm/customers?search=noor")).body.length, 1, "searchable by name");

  const bare = await api("full_looker", "GET", "/crm/customers");
  assert.equal(bare.status, 200, "also where Sales exists but this person holds none of it");
  const sales = await api("full_looker", "GET", "/customers/customers");
  assert.equal(sales.status, 403, "and the customer master itself is still not theirs");
});

test("a deal can be opened on a customer chosen from that list", { skip }, async () => {
  const pick = (await api("solo_chaser", "GET", "/crm/customers?search=noor")).body[0];
  const made = await api("solo_chaser", "POST", "/crm/opportunities", { title: "Second order", customerId: pick.id, value: 12000 });
  assert.equal(made.status, 201, JSON.stringify(made.data));
});

// ---- importing leads -------------------------------------------------------------------------------------------------

const leadRows = () => [
  { name: "Imported One", company: "One Trading", phone: "+971 50 111 2222", source: "Walk-in", expectedValue: "AED 5,000", city: "Dubai" },
  { name: "Imported Two", email: "two@import.test", source: "LinkedIn", interest: "Pallets" },
  { name: "Imported Three", phone: "0503334444", source: "WhatsApp" },
  { name: "", phone: "0505556666" }, // no name
  { name: "No way to reach" }, // no phone or email
  { name: "Al Noor Foods again", phone: "0501234567" }, // the lead already qualified above: held by phone
  { name: "Same as one", phone: "050-111-2222" }, // the same number as row one
];

test("a spreadsheet is previewed first, and the preview writes nothing", { skip }, async () => {
  const before = await as(() => M.Lead.countDocuments());
  const r = await api("solo_chaser", "POST", "/crm/leads/import", { rows: leadRows() }); // no dryRun: still the preview
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.body.dryRun, true, "a request that does not say otherwise is a preview");
  assert.deepEqual(r.body.summary, { total: 7, create: 3, invalid: 2, duplicate: 2, skipped: 0 });
  assert.equal(r.body.issues.length, 4, "the rows a person has to look at, and not the clean ones");
  assert.deepEqual(r.body.issues.map((i) => i.line), [5, 6, 7, 8], "numbered as the spreadsheet is, the header being line 1");
  assert.equal(r.body.issues.find((i) => i.line === 7).duplicateOf.kind, "lead", "the lead we already hold is named");
  assert.equal(r.body.sample.length, 3);
  assert.equal(await as(() => M.Lead.countDocuments()), before, "nothing was written");
  assert.equal((await api("solo_chaser", "POST", "/crm/leads/import", { rows: leadRows(), dryRun: "false" })).body.dryRun, true, "only a real false imports, not the word");
  assert.equal(await as(() => M.Lead.countDocuments()), before);
});

test("the real import makes the good rows, reports the rest, and leaves no first-contact tasks unless asked", { skip }, async () => {
  const before = await as(() => M.CrmActivity.countDocuments({ auto: true, "regarding.kind": "lead" }));
  const r = await api("solo_chaser", "POST", "/crm/leads/import", { rows: leadRows(), dryRun: false, fileName: "enquiries.csv" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.body.dryRun, false);
  assert.equal(r.body.summary.created, 3);
  assert.equal(r.body.summary.invalid, 2);
  assert.equal(r.body.summary.duplicate, 2);
  assert.equal(r.body.failed.length, 0);
  assert.match(r.body.created[0].leadNo, /^LD-\d{4}-\d{4}$/, "numbered by the same series as a typed one");

  const made = await as(() => M.Lead.find({ name: /^Imported/ }).sort({ createdAt: 1 }).lean());
  assert.equal(made.length, 3);
  assert.equal(made[0].source, "walk_in");
  assert.equal(made[0].expectedValue, 5000, "AED 5,000 is five thousand");
  assert.equal(made[1].source, "other");
  assert.equal(made[1].sourceNote, "LinkedIn", "a source we do not have is kept, not lost");
  assert.ok(made.every((l) => l.ownerId && l.score >= 0), "each has an owner and a score, as a typed lead does");
  const tasks = await as(() => M.CrmActivity.countDocuments({ auto: true, "regarding.kind": "lead" }));
  assert.equal(tasks, before, "importing old enquiries must not flood today's worklist with first-contact tasks");
});

test("running the same file again makes nothing: every row is now a duplicate", { skip }, async () => {
  const before = await as(() => M.Lead.countDocuments());
  const r = await api("solo_chaser", "POST", "/crm/leads/import", { rows: leadRows(), dryRun: false });
  assert.equal(r.body.summary.created, 0);
  assert.equal(r.body.summary.duplicate, 5, "the three just made, and the two that were already duplicates");
  assert.equal(await as(() => M.Lead.countDocuments()), before);
});

test("a person can ask for the first-contact tasks, and for duplicates to be made anyway", { skip }, async () => {
  const rows = [{ name: "Wants A Task", email: "task@import.test" }, { name: "Twin Of One", email: "two@import.test" }];
  const before = await as(() => M.CrmActivity.countDocuments({ auto: true, "regarding.kind": "lead" }));
  const r = await api("solo_chaser", "POST", "/crm/leads/import", { rows, dryRun: false, followUp: true, allowDuplicates: true });
  assert.equal(r.body.summary.created, 2);
  assert.equal(await as(() => M.CrmActivity.countDocuments({ auto: true, "regarding.kind": "lead" })), before + 2, "one first-contact task each");
});

test("importing needs crm.create, rejects a body that is not rows, and survives hostile input", { skip }, async () => {
  await cannot("solo_looker", "POST", "/crm/leads/import", { rows: leadRows() });
  await cannot("solo_editor", "POST", "/crm/leads/import", { rows: leadRows() });

  for (const body of [{}, { rows: [] }, { rows: "many" }, { rows: { length: 5 } }]) {
    const r = await api("solo_chaser", "POST", "/crm/leads/import", body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.code, "IMPORT_ROWS_REQUIRED");
  }
  const many = Array.from({ length: 201 }, (_, i) => ({ name: `Bulk ${i}`, email: `bulk${i}@import.test` }));
  const big = await api("solo_chaser", "POST", "/crm/leads/import", { rows: many, dryRun: false });
  assert.equal(big.code, "IMPORT_TOO_MANY");
  assert.equal(await as(() => M.Lead.countDocuments({ name: /^Bulk/ })), 0, "a file that is too big writes nothing at all");

  const hostile = await api("solo_chaser", "POST", "/crm/leads/import", {
    rows: [{ name: { $ne: "x" }, phone: ["0501234567"], email: { $gt: "" }, source: {}, expectedValue: [1], owner: { $ne: null } }, null, "text", [], { name: "Fine", email: "fine@import.test" }],
    dryRun: false,
    allowDuplicates: "yes",
    followUp: { $ne: false },
  });
  assert.equal(hostile.status, 200, JSON.stringify(hostile.data));
  assert.equal(hostile.body.summary.created, 1, "only the real row");
  assert.equal(hostile.body.summary.invalid, 4);
});

test("the audit row for an import says how many, and never who they were", { skip }, async () => {
  const rows = await as(() => M.ActivityLog.find({ action: "CRM_LEADS_IMPORTED" }).lean());
  assert.ok(rows.length >= 2, "every real import is on record, a preview is not");
  const first = rows.find((r) => r.after?.fileName === "enquiries.csv");
  assert.match(first.summary, /^3 enquiries were imported, 2 already held, 2 could not be$/);
  assert.equal(first.after.created, 3);
  const everything = JSON.stringify(rows);
  assert.ok(!/Imported One|0501112222|two@import\.test|One Trading/.test(everything), "no name, number or email is copied into the trail");
});

// ---- importing people ------------------------------------------------------------------------------------------------

test("a spreadsheet of people links each to the customer their company names, and mirrors them into it", { skip }, async () => {
  const rows = [
    { name: "Omar Buyer", designation: "Purchasing", email: "omar@noor.test", phone: "0501110000", company: "al noor foods" },
    { name: "Sana Card", phone: "0502220000", company: "Not A Customer Yet", notes: "met at Gulfood" },
    { name: "Omar Buyer", email: "omar@noor.test" }, // the same person twice
    { name: "" },
  ];
  const preview = await api("solo_chaser", "POST", "/crm/contacts/import", { rows });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.body.dryRun, true);
  assert.deepEqual(preview.body.summary, { total: 4, create: 2, invalid: 1, duplicate: 1, skipped: 0 });

  const real = await api("solo_chaser", "POST", "/crm/contacts/import", { rows, dryRun: false, fileName: "people.csv" });
  assert.equal(real.body.summary.created, 2, JSON.stringify(real.body));

  const omar = await as(() => M.Contact.findOne({ email: "omar@noor.test" }).lean());
  assert.equal(String(omar.customerId), S.customerId, "linked to the customer by name, ignoring case");
  const customer = await as(() => M.Customer.findById(S.customerId).lean());
  assert.ok(customer.contacts.some((c) => String(c._id) === String(omar._id)), "and mirrored into the customer's own contacts under the SAME id");
  const sana = await as(() => M.Contact.findOne({ name: "Sana Card" }).lean());
  assert.equal(sana.customerId, null, "a company that is not a customer leaves the person unlinked");
  assert.equal(sana.notes, "Company: Not A Customer Yet. met at Gulfood", "with the company kept");

  const again = await api("solo_chaser", "POST", "/crm/contacts/import", { rows, dryRun: false });
  assert.equal(again.body.summary.created, 0, "the second run makes nobody");
  await cannot("solo_looker", "POST", "/crm/contacts/import", { rows });

  const skipped = await api("solo_chaser", "POST", "/crm/contacts/import", { rows: [{ name: "Left Out", phone: "0509990000", company: "Nobody Co" }], unmatched: "skip" });
  assert.equal(skipped.body.summary.skipped, 1);
});

// ---- files on a lead or a deal ---------------------------------------------------------------------------------------

test("a file is attached to a lead and to a deal, listed, and downloaded exactly as it went in", { skip }, async () => {
  const lead = await api("solo_chaser", "POST", "/crm/leads", enquiry({ name: "File Holder", company: "Files Co", phone: "0508887777" }));
  S.fileLead = lead.body._id;

  const up = await upload("solo_chaser", `/crm/leads/${S.fileLead}/attachments`, "spec sheet.pdf", PDF, "Specification");
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal(up.body.fileName, "spec sheet.pdf");
  assert.equal(up.body.fileType, "application/pdf");
  assert.equal(up.body.label, "Specification");
  S.file = up.body.attachmentId;

  const list = await api("solo_looker", "GET", `/crm/leads/${S.fileLead}/attachments`);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1, "anyone who can see the lead can see its files");

  const dl = await call("GET", `/crm/attachments/${S.file}`, { token: T.solo_looker });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get("x-content-type-options"), "nosniff");
  assert.match(dl.headers.get("content-disposition"), /^attachment;/, "the browser saves it, never interprets it");
  assert.deepEqual(Buffer.from(await dl.res.arrayBuffer()), PDF, "byte for byte");

  const deal = await upload("solo_chaser", `/crm/opportunities/${S.deal}/attachments`, "signed quotation.pdf", PDF);
  assert.equal(deal.status, 201, JSON.stringify(deal.data));
  assert.equal((await api("solo_looker", "GET", `/crm/opportunities/${S.deal}/attachments`)).body.length, 1);
});

test("who may add and remove a file: viewing is not editing", { skip }, async () => {
  const r = await upload("solo_looker", `/crm/leads/${S.fileLead}/attachments`, "nope.pdf", PDF);
  assert.equal(r.status, 403);
  assert.equal(r.code, "PERMISSION_DENIED");
  await cannot("solo_looker", "DELETE", `/crm/attachments/${S.file}`);
  assert.equal((await api("solo_looker", "GET", `/crm/leads/${S.fileLead}/attachments`)).body.length, 1, "still there");
});

test("only the types the system keeps, and only what they claim to be", { skip }, async () => {
  const exe = await upload("solo_chaser", `/crm/leads/${S.fileLead}/attachments`, "invoice.pdf", Buffer.from("MZ\x90\x00 this is a program, not a pdf"));
  assert.equal(exe.status, 415, "an executable renamed .pdf");
  assert.equal(exe.code, "FILE_CONTENT_MISMATCH");
  const html = await upload("solo_chaser", `/crm/leads/${S.fileLead}/attachments`, "page.html", Buffer.from("<script>alert(1)</script>"));
  assert.equal(html.code, "FILE_TYPE_NOT_ALLOWED");
  const none = await call("POST", `/crm/leads/${S.fileLead}/attachments`, { token: T.solo_chaser, form: new FormData() });
  assert.equal(none.status, 400, "no file at all");
  assert.equal((await api("solo_chaser", "GET", `/crm/leads/${S.fileLead}/attachments`)).body.length, 1, "none of the three was kept");
});

test("a file id from any other module, another organisation, or a lead that is gone, is a plain 404", { skip }, async () => {
  // A voucher's attachment, in the same organisation: the CRM's door must not open it, whatever id a caller guesses.
  const foreign = await as(() => M.Attachment.create({ companyId: "solo", key: "2026/foreign-voucher-file.pdf", originalName: "voucher.pdf", mimeType: "application/pdf", size: 10, ownerType: "voucher", ownerId: new mongoose.Types.ObjectId() }));
  const asVoucher = await api("solo_owner", "GET", `/crm/attachments/${foreign._id}`);
  assert.equal(asVoucher.status, 404, "another module's file");
  assert.equal((await api("solo_owner", "DELETE", `/crm/attachments/${foreign._id}`)).status, 404, "and it cannot be deleted through the CRM either");
  assert.ok(await as(() => M.Attachment.exists({ _id: foreign._id })), "it is untouched");

  // Another organisation's lead file.
  assert.equal((await api("full_owner", "GET", `/crm/attachments/${S.file}`)).status, 404, "another organisation's file");
  assert.equal((await api("full_owner", "GET", `/crm/leads/${S.fileLead}/attachments`)).status, 404, "and its lead");
  assert.equal((await api("solo_owner", "GET", `/crm/attachments/${FAKE_ID}`)).status, 404);
  assert.equal((await api("solo_owner", "GET", "/crm/attachments/not-an-id")).status, 404);
});

test("a lead or deal holds a limited number of files", { skip }, async () => {
  const ownerId = new mongoose.Types.ObjectId(S.fileLead);
  const held = await as(() => M.Attachment.countDocuments({ ownerType: "lead", ownerId }));
  const rows = Array.from({ length: 25 - held }, (_, i) => ({ companyId: "solo", key: `2026/limit-${i}.pdf`, originalName: `f${i}.pdf`, mimeType: "application/pdf", size: 1, ownerType: "lead", ownerId }));
  await as(() => M.Attachment.insertMany(rows));
  const r = await upload("solo_chaser", `/crm/leads/${S.fileLead}/attachments`, "one-too-many.pdf", PDF);
  assert.equal(r.status, 409);
  assert.equal(r.code, "ATTACHMENT_LIMIT");
});

test("removing a file removes it; deleting a lead takes its files with it", { skip }, async () => {
  const gone = await api("solo_chaser", "DELETE", `/crm/attachments/${S.file}`);
  assert.equal(gone.status, 200, JSON.stringify(gone.data));
  assert.equal((await api("solo_chaser", "GET", `/crm/attachments/${S.file}`)).status, 404);

  const row = await as(() => M.Attachment.findOne({ ownerType: "lead", ownerId: S.fileLead, storage: "disk", key: { $not: /limit-|foreign/ } }).lean());
  assert.equal(row, null, "the file's row went with it");

  const ownerId = new mongoose.Types.ObjectId(S.fileLead);
  assert.ok((await as(() => M.Attachment.countDocuments({ ownerType: "lead", ownerId }))) > 0, "the lead still has the rows planted for the limit test");
  const del = await api("solo_owner", "DELETE", `/crm/leads/${S.fileLead}`);
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.equal(await as(() => M.Attachment.countDocuments({ ownerType: "lead", ownerId })), 0, "deleting the lead cleared every file it held");
});

test("every file action is on record", { skip }, async () => {
  const rows = await as(() => M.ActivityLog.find({ action: /^CRM_ATTACHMENT_/ }).lean());
  const actions = rows.map((r) => r.action);
  assert.ok(actions.includes("CRM_ATTACHMENT_ADDED") && actions.includes("CRM_ATTACHMENT_REMOVED"), actions.join(", "));
  assert.match(rows.find((r) => r.action === "CRM_ATTACHMENT_ADDED").summary, /was attached$/);
});
