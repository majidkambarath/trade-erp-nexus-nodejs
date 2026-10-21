// Writing to a customer from the CRM, over HTTP against a strict server with real sign-ins.
//
// What is tested hardest is what would embarrass somebody: a letter that claims to have been sent when nothing left
// the building, a placeholder that reached the customer unfilled, a template saved by someone who may not configure,
// and the daily cap being bypassed by a second door. The `console` provider records and sends nothing, which is
// exactly what a demo organisation has, so the honest wording of that case is tested too.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3700 + Math.floor(Math.random() * 200);
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
  return { status: res.status, data, body: data?.data, code: data?.errorCode, details: data?.details };
}
const as = (fn, company = "post") => ctx.runWithTenant({ companyId: company, branchId: "main" }, fn);
const api = (who, method, url, body) => call(method, url, { token: T[who], body: method === "GET" || method === "DELETE" ? undefined : body });
const login = async (email) => (await call("POST", "/login", { body: { email, password: PASSWORD } })).body?.tokens?.accessToken;

async function person(key, permissions) {
  const made = await api("owner", "POST", "/access/roles", { key, name: key, rank: 50, permissions });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const added = await api("owner", "POST", "/access/users", { name: key, email: `${key}@post.test`, password: PASSWORD, role: key });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  await as(() => M.Admin.updateOne({ email: `${key}@post.test` }, { $set: { mustChangePassword: false } }));
  T[key] = await login(`${key}@post.test`);
  assert.ok(T[key], `${key} signs in`);
}

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
    Lead: require("../../models/modules/crm/leadModel"),
    Contact: require("../../models/modules/crm/contactModel"),
    CrmActivity: require("../../models/modules/crm/crmActivityModel"),
    CompanySettings: require("../../models/modules/financial/companySettingsModel"),
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
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test("an organisation, a lead, a customer with people, and the roles that will try this", { skip }, async () => {
  assert.equal((await Org.create({ legalName: "Post Works", code: "post", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" })).provisioning.complete, true);
  await as(() => new M.Admin({ name: "Asif Rahman", email: "owner@post.test", password: PASSWORD, status: "active", isActive: true, type: "super_admin" }).save());
  T.owner = await login("owner@post.test");
  assert.ok(T.owner);

  await person("looker", ["crm.view"]);
  await person("writer", ["crm.view", "crm.create", "crm.edit"]);

  const lead = await api("owner", "POST", "/crm/leads", { name: "Hassan Al Noor", company: "Al Noor Foods", phone: "0501234567", email: "hassan@alnoor.test" });
  assert.equal(lead.status, 201, JSON.stringify(lead.data));
  S.lead = lead.body._id;

  const customer = await api("owner", "POST", "/customers", {
    customerName: "Gulf Steel LLC", contactPerson: "Rania Haddad", email: "office@gulfsteel.test", phoneNumber: "0509998888", address: "Dubai",
  });
  assert.equal(customer.status, 201, JSON.stringify(customer.data));
  S.customer = customer.body._id;

  const contact = await api("owner", "POST", "/crm/contacts", { name: "Rania Haddad", email: "rania@gulfsteel.test", customerId: S.customer, isPrimary: true });
  assert.equal(contact.status, 201, JSON.stringify(contact.data));

  const deal = await api("owner", "POST", "/crm/opportunities", { title: "Coating line", customerId: S.customer, value: 48000 });
  assert.equal(deal.status, 201, JSON.stringify(deal.data));
  S.deal = deal.body._id;

  // The sender's address must be real for the test of "the reply goes to the person who wrote it".
  await as(() => M.Admin.updateOne({ email: "writer@post.test" }, { $set: { name: "Imran Writer" } }));
});

// ---- templates --------------------------------------------------------------------------------------------------

test("an organisation that has saved none is OFFERED the starters, and they are marked as such", { skip }, async () => {
  const got = await api("writer", "GET", "/crm/email/templates");
  assert.equal(got.status, 200, JSON.stringify(got.data));
  assert.equal(got.body.starters, true, "nothing has been saved yet");
  assert.ok(got.body.templates.length >= 3);
  assert.ok(got.body.placeholders.some((p) => p.key === "contact.firstName"), "the editor is told what it may use");

  const stored = await as(() => M.CompanySettings.findOne({}).select("crm").lean());
  assert.ok(!stored?.crm?.emailTemplates, "offering a starter does not write it: clearing the list must really clear it");
});

test("saving templates is configuration, so somebody who may only write emails cannot", { skip }, async () => {
  const refused = await api("writer", "PUT", "/crm/email/templates", { templates: [{ name: "Mine", subject: "S", body: "B" }] });
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
  assert.equal(refused.code, "PERMISSION_DENIED");

  const saved = await api("owner", "PUT", "/crm/email/templates", {
    templates: [{ name: "After a call", subject: "Following up", body: "Hello {{contact.firstName}},\n\nAs promised." }],
    signature: "Imran Writer\nPost Works",
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.body.starters, false);
  assert.equal(saved.body.templates.length, 1);
  assert.equal(saved.body.templates[0].key, "after-a-call");
  assert.equal(saved.body.signature, "Imran Writer\nPost Works");
});

test("a template without a subject is refused, with the field named", { skip }, async () => {
  const bad = await api("owner", "PUT", "/crm/email/templates", { templates: [{ name: "Broken", body: "B" }] });
  assert.equal(bad.status, 400, JSON.stringify(bad.data));
  assert.equal(bad.code, "TEMPLATE_SUBJECT_REQUIRED");
  assert.equal(bad.details.errors[0].field, "templates.0.subject");
  // and nothing was saved over what worked
  assert.equal((await api("owner", "GET", "/crm/email/templates")).body.templates.length, 1);
});

// ---- who it goes to ---------------------------------------------------------------------------------------------

test("the form is offered the people we already hold, not an empty box", { skip }, async () => {
  const forDeal = await api("writer", "GET", `/crm/email/recipients?kind=opportunity&id=${S.deal}`);
  assert.equal(forDeal.status, 200, JSON.stringify(forDeal.data));
  assert.ok(forDeal.body.people.some((p) => p.email === "rania@gulfsteel.test"), "the customer's own person");
  assert.ok(forDeal.body.people.some((p) => p.email === "office@gulfsteel.test"), "and the company address");
  assert.equal(forDeal.body.deal.title, "Coating line", "so a template can say what the deal is for");

  const forLead = await api("writer", "GET", `/crm/email/recipients?kind=lead&id=${S.lead}`);
  assert.equal(forLead.body.people[0].email, "hassan@alnoor.test", "a lead's enquirer is the only address there is");
});

test("a deal in another organisation is not found, it is not read", { skip }, async () => {
  const other = await api("writer", "GET", `/crm/email/recipients?kind=opportunity&id=${new mongoose.Types.ObjectId()}`);
  assert.equal(other.status, 404, JSON.stringify(other.data));
});

// ---- sending ----------------------------------------------------------------------------------------------------

const letter = (over = {}) => ({
  regarding: { kind: "opportunity", id: S.deal },
  to: ["rania@gulfsteel.test"],
  subject: "Our quotation for {{deal.title}}",
  body: "Hello {{contact.firstName}},\n\nHere is the price we discussed.",
  ...over,
});

test("writing to a customer is recorded on the deal, with the placeholders filled", { skip }, async () => {
  const sent = await api("writer", "POST", "/crm/email/send", letter());
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  S.email = sent.body.activity._id;

  const a = sent.body.activity;
  assert.equal(a.kind, "email");
  assert.equal(a.status, "DONE", "an email is a thing that happened, not a thing to do");
  assert.equal(a.subject, "Our quotation for Coating line", "the deal's own title, not the placeholder");
  assert.ok(a.email.body.startsWith("Hello Rania,"), `the contact's first name reached the customer: ${a.email.body.slice(0, 40)}`);
  assert.ok(a.email.body.includes("Imran Writer"), "and the signature was added");
  assert.deepEqual(a.email.to, ["rania@gulfsteel.test"]);
  assert.equal(a.email.replyTo, "writer@post.test", "a reply goes to the person who wrote it, not to the sending address");
  assert.equal(a.customerId, S.customer, "so the customer's own CRM tab shows it without a join");
});

test("nothing unfilled reaches the customer, and nothing is stored that was not sent", { skip }, async () => {
  const stored = await as(() => M.CrmActivity.findById(S.email).lean());
  assert.ok(!/\{\{/.test(stored.email.body), "no placeholder survived into what was sent");
  assert.ok(!/\{\{/.test(stored.subject));
  assert.equal(stored.email.sentBy, (await as(() => M.Admin.findOne({ email: "writer@post.test" }).lean()))._id.toString());
});

test("the default provider records and sends nothing, and SAYS so", { skip }, async () => {
  const sent = await api("writer", "POST", "/crm/email/send", letter({ subject: "Just checking in" }));
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal(sent.body.provider, "console");
  assert.equal(sent.body.recordedOnly, true, "a demo must never read as though a customer was written to");
  assert.equal(sent.body.sent, true, "it did not fail - it was recorded");
  assert.equal(sent.body.activity.email.recordedOnly, true, "and the record says it too, forever");
});

test("it lands on the timeline beside the calls, which is the whole point", { skip }, async () => {
  const log = await api("writer", "GET", `/crm/activities?regardingId=${S.deal}&status=all`);
  assert.equal(log.status, 200, JSON.stringify(log.data));
  const mine = log.body.filter((a) => a.kind === "email");
  assert.ok(mine.length >= 2, `the emails are on the deal's timeline: ${log.body.map((a) => a.kind).join(",")}`);
  assert.ok(mine.every((a) => a.status === "DONE"));
});

test("an email never appears in somebody's worklist", { skip }, async () => {
  const worklist = await api("writer", "GET", "/crm/follow-ups?status=OPEN");
  assert.equal(worklist.status, 200);
  assert.ok(!worklist.body.some((a) => String(a._id) === String(S.email)), "a sent email is not something still owed");
});

test("what will not be sent, said with the field named", { skip }, async () => {
  const cases = [
    [{ to: [] }, "EMAIL_TO_REQUIRED"],
    [{ to: ["not an address"] }, "EMAIL_TO_INVALID"],
    [{ subject: "   " }, "EMAIL_SUBJECT_REQUIRED"],
    [{ body: "" }, "EMAIL_BODY_REQUIRED"],
  ];
  for (const [over, code] of cases) {
    const bad = await api("writer", "POST", "/crm/email/send", letter(over));
    assert.equal(bad.status, 400, `${code}: ${JSON.stringify(bad.data)}`);
    assert.equal(bad.code, code);
  }
});

test("an injection probe is refused cleanly, never run as a query", { skip }, async () => {
  const probe = await api("writer", "POST", "/crm/email/send", {
    regarding: { kind: "opportunity", id: S.deal }, to: { $ne: null }, subject: { $ne: null }, body: ["x"],
  });
  assert.ok(probe.status >= 400 && probe.status < 500, `a clean refusal, not a 500: ${probe.status}`);
});

test("nothing is sent about something in another branch or another organisation", { skip }, async () => {
  const nowhere = await api("writer", "POST", "/crm/email/send", letter({ regarding: { kind: "opportunity", id: new mongoose.Types.ObjectId() } }));
  assert.equal(nowhere.status, 404, JSON.stringify(nowhere.data));
  assert.equal(nowhere.code, "OPPORTUNITY_NOT_FOUND");
});

test("somebody who may only look cannot write to a customer", { skip }, async () => {
  const refused = await api("looker", "POST", "/crm/email/send", letter());
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
  assert.equal(refused.code, "PERMISSION_DENIED");
  // and they can still read the templates, which is how the screen draws a read-only view
  assert.equal((await api("looker", "GET", "/crm/email/templates")).status, 200);
});

test("the daily cap counts CRM letters, so this is not the way around it", { skip }, async () => {
  // Drop the organisation's allowance to what has already been used: the next letter must be refused.
  const CrmEmailService = require("../crm/crmEmailService");
  const used = await as(() => CrmEmailService.sentInLastDay("post"));
  assert.ok(used >= 2, `the letters so far are counted: ${used}`);

  const { MessagingSettings } = require("../../models/modules/messagingModels");
  await as(() => MessagingSettings.updateOne({}, { $set: { dailyLimit: used, enabled: true, fromEmail: "sales@post.test" } }, { upsert: true }));

  const refused = await api("writer", "POST", "/crm/email/send", letter({ subject: "One too many" }));
  assert.equal(refused.status, 429, JSON.stringify(refused.data));
  assert.equal(refused.code, "SEND_LIMIT_REACHED");

  await as(() => MessagingSettings.updateOne({}, { $set: { dailyLimit: 200 } }));
});

test("the audit trail says who wrote to whom", { skip }, async () => {
  const trail = await api("owner", "GET", "/accounting/audit-log?limit=100");
  assert.equal(trail.status, 200, JSON.stringify(trail.data));
  const rows = trail.body.rows || trail.body.logs || trail.body;
  const row = (Array.isArray(rows) ? rows : []).find((r) => r.action === "CRM_EMAIL_SENT");
  assert.ok(row, "an email to a customer is on the record");
  assert.ok(row.summary.includes("rania@gulfsteel.test"), `who it went to: ${row.summary}`);
});
