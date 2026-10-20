// The CRM over HTTP against a strict server with real sign-ins (/api/v1/crm).
//
// Who may do what: reading needs crm.view; adding needs crm.create; changing and moving need crm.edit; handing over
// needs crm.assign; the stages and the automation settings need crm.manage; and qualifying a lead - which creates a
// REAL customer with its own ledger account - also needs sales.create, which no amount of crm.* grants can stand in
// for. Also: an organisation whose plan does not include the CRM is refused the whole module, another organisation's
// lead is not found, and the audit rows say what happened.
//
// A refusal must be the server's own 403. An allowed call only has to get PAST the gate.
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
const FAKE_ID = "64b64b64b64b64b64b64b64b"; // matches nothing: a gate that lets it through answers 404, one that does not answers 403

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
const as = (fn, company = "crm") => ctx.runWithTenant({ companyId: company, branchId: "main" }, fn);
const api = (who, method, url, body) => call(method, url, { token: T[who], body: method === "GET" || method === "DELETE" ? undefined : body });
const login = async (email) => (await call("POST", "/login", { body: { email, password: PASSWORD } })).body?.tokens?.accessToken;

const cannot = async (who, method, url, body) => {
  const r = await api(who, method, url, body);
  assert.equal(r.status, 403, `${who} ${method} ${url} should be refused: ${r.status} ${JSON.stringify(r.data)?.slice(0, 200)}`);
  assert.equal(r.code, "PERMISSION_DENIED", `${who} ${method} ${url}`);
  return r;
};

async function roleAndPerson(key, permissions) {
  const made = await api("owner", "POST", "/access/roles", { key, name: key.replace(/_/g, " "), rank: 50, permissions });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const added = await api("owner", "POST", "/access/users", { name: key, email: `${key}@crm.test`, password: PASSWORD, role: key });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  await as(() => M.Admin.updateOne({ email: `${key}@crm.test` }, { $set: { mustChangePassword: false } }));
  T[key] = await login(`${key}@crm.test`);
  assert.ok(T[key], `${key} signs in`);
}

const enquiry = (over = {}) => ({ name: "Hassan Al Noor", company: "Al Noor Foods", phone: "0501234567", source: "referral", expectedValue: 45000, ...over });

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
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

test("an organisation that bought the CRM, with people who hold different parts of it", { skip }, async () => {
  assert.equal((await Org.create({ legalName: "Crm Works", code: "crm", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" })).provisioning.complete, true);
  await as(() => new M.Admin({ name: "owner", email: "owner@crm.test", password: PASSWORD, status: "active", isActive: true, type: "super_admin" }).save());
  T.owner = await login("owner@crm.test");
  assert.ok(T.owner);

  await roleAndPerson("looker", ["crm.view"]);
  await roleAndPerson("chaser", ["crm.view", "crm.create", "crm.edit"]);
  await roleAndPerson("closer", ["crm.view", "crm.create", "crm.edit", "sales.create"]);
  await roleAndPerson("leader", ["crm.view", "crm.create", "crm.edit", "crm.assign", "crm.manage"]);
});

test("the pipeline is there on the first read, seeded without anybody setting it up", { skip }, async () => {
  const stages = await api("looker", "GET", "/crm/stages");
  assert.equal(stages.status, 200, JSON.stringify(stages.data));
  assert.deepEqual(stages.body.map((s) => s.key), ["new", "qualified", "quoted", "accepted", "won", "lost"]);
  const board = await api("looker", "GET", "/crm/pipeline");
  assert.equal(board.status, 200);
  assert.equal(board.body.totals.count, 0);
});

test("reading needs crm.view; adding needs crm.create; changing needs crm.edit", { skip }, async () => {
  const list = await api("looker", "GET", "/crm/leads");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, []);
  await cannot("looker", "POST", "/crm/leads", enquiry());

  const made = await api("chaser", "POST", "/crm/leads", enquiry());
  assert.equal(made.status, 201, JSON.stringify(made.data));
  S.lead = made.body._id;
  assert.match(made.body.leadNo, /^LD-\d{4}-0001$/);
  assert.ok(made.body.ownerId, "the automation gave it to somebody");

  await cannot("looker", "PUT", `/crm/leads/${S.lead}`, { notes: "mine now" });
  const edited = await api("chaser", "PUT", `/crm/leads/${S.lead}`, { notes: "Wants a price for 200 bags" });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
});

test("a bad body is refused cleanly, never with a 500", { skip }, async () => {
  // What the security sweep posts at every route: an object where a string belongs, an array where a word belongs.
  const junk = await api("chaser", "POST", "/crm/leads", { name: { $ne: "x" }, phone: ["0501234567"], status: ["a"], expectedValue: -1 });
  assert.equal(junk.status, 400, JSON.stringify(junk.data));
  assert.equal(junk.code, "LEAD_NAME_REQUIRED");
  const noContact = await api("chaser", "POST", "/crm/leads", { name: "Nobody reachable" });
  assert.equal(noContact.status, 400);
  assert.equal(noContact.code, "LEAD_CONTACT_REQUIRED");
});

test("handing a lead to somebody else is its own permission", { skip }, async () => {
  const them = await api("owner", "GET", "/crm/owners");
  assert.equal(them.status, 200);
  const maya = them.body.find((o) => o.name === "leader");
  await cannot("chaser", "POST", `/crm/leads/${S.lead}/assign`, { ownerId: maya.id });
  const given = await api("leader", "POST", `/crm/leads/${S.lead}/assign`, { ownerId: maya.id });
  assert.equal(given.status, 200, JSON.stringify(given.data));
  assert.equal(given.body.ownerName, "leader");
});

test("qualifying makes a real customer, so crm.edit alone is not enough: it asks for sales.create", { skip }, async () => {
  const refused = await cannot("chaser", "POST", `/crm/leads/${S.lead}/qualify`, { creditLimit: 50000 });
  assert.deepEqual(refused.details.required, ["sales.create"]);
  assert.equal(await as(() => M.Customer.countDocuments({})), 0, "and nothing was created on the way to being refused");

  const done = await api("closer", "POST", `/crm/leads/${S.lead}/qualify`, { creditLimit: 50000 });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  S.deal = done.body.opportunity._id;
  assert.match(done.body.opportunity.opportunityNo, /^OPP-\d{4}-0001$/);

  const customer = await as(() => M.Customer.findById(done.body.customerId).lean());
  assert.equal(customer.customerName, "Al Noor Foods");
  const account = await as(() => M.LedgerAccount.findOne({ accountName: "Customer - Al Noor Foods" }).lean());
  assert.ok(account, "with its account in the chart, exactly like a customer entered by hand");
});

test("moving a deal needs crm.edit, and a lost one needs a reason", { skip }, async () => {
  await cannot("looker", "POST", `/crm/opportunities/${S.deal}/stage`, { stageKey: "qualified" });
  const moved = await api("chaser", "POST", `/crm/opportunities/${S.deal}/stage`, { stageKey: "qualified" });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.body.stageName, "Qualified");

  const noReason = await api("chaser", "POST", `/crm/opportunities/${S.deal}/lose`, {});
  assert.equal(noReason.status, 400);
  assert.equal(noReason.code, "LOST_REASON_REQUIRED");
});

test("the follow-up worklist and its count are the person's own", { skip }, async () => {
  const mine = await api("closer", "GET", "/crm/follow-ups?scope=mine");
  assert.equal(mine.status, 200);
  const count = await api("closer", "GET", "/crm/follow-ups/count");
  assert.equal(count.status, 200);
  assert.equal(typeof count.body.count, "number");
  // The deal was qualified by `closer` but given to `leader`, so what is owed is on the leader's list, not this one.
  const theirs = await api("leader", "GET", "/crm/follow-ups?scope=mine");
  assert.ok(theirs.body.length >= mine.body.length);
});

test("the stages and the automation are crm.manage, not crm.edit", { skip }, async () => {
  const stages = (await api("leader", "GET", "/crm/stages")).body;
  await cannot("chaser", "PUT", "/crm/stages", { stages });
  await cannot("chaser", "PUT", "/crm/settings", { autoAdvance: false });

  const renamed = stages.map((s) => (s.key === "quoted" ? { ...s, name: "Offer out" } : s));
  const saved = await api("leader", "PUT", "/crm/stages", { stages: renamed });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.body.find((s) => s.key === "quoted").name, "Offer out");

  // A pipeline the automation could not run on is refused with the reason, not saved
  const broken = await api("leader", "PUT", "/crm/stages", { stages: stages.filter((s) => s.type !== "won") });
  assert.equal(broken.status, 400);
  assert.equal(broken.code, "STAGE_WON_REQUIRED");

  const settings = await api("leader", "PUT", "/crm/settings", { autoAdvance: false, autoFollowUp: true, assignmentMode: "round_robin", uncontactedHours: 12, staleDays: 10 });
  assert.equal(settings.status, 200, JSON.stringify(settings.data));
  assert.equal(settings.body.autoAdvance, false);
  await api("leader", "PUT", "/crm/settings", { autoAdvance: true });
});

test("another organisation's lead is simply not found - never somebody else's data, never a 500", { skip }, async () => {
  assert.equal((await Org.create({ legalName: "Other Co", code: "other", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" })).provisioning.complete, true);
  await ctx.runWithTenant({ companyId: "other", branchId: "main" }, () => new M.Admin({ name: "spy", email: "spy@other.test", password: PASSWORD, status: "active", isActive: true, type: "super_admin" }).save());
  T.spy = await login("spy@other.test");

  for (const url of [`/crm/leads/${S.lead}`, `/crm/opportunities/${S.deal}`, `/crm/leads/${FAKE_ID}`]) {
    const r = await api("spy", "GET", url);
    assert.equal(r.status, 404, `${url}: ${r.status}`);
    assert.ok(!JSON.stringify(r.data).includes("Al Noor"), "and nothing of the other organisation's is echoed back");
  }
  const theirs = await api("spy", "GET", "/crm/leads");
  assert.deepEqual(theirs.body, [], "the list is their own, which is empty");
});

test("an organisation whose plan does not include the CRM is refused the module, not the role", { skip }, async () => {
  assert.equal((await Org.create({ legalName: "Trade Only", code: "trd", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "trading" })).provisioning.complete, true);
  await ctx.runWithTenant({ companyId: "trd", branchId: "main" }, () => new M.Admin({ name: "boss", email: "boss@trd.test", password: PASSWORD, status: "active", isActive: true, type: "super_admin" }).save());
  T.trade = await login("boss@trd.test");

  for (const [method, url, body] of [["GET", "/crm/leads"], ["GET", "/crm/pipeline"], ["POST", "/crm/leads", enquiry()], ["GET", "/crm/stages"]]) {
    const r = await api("trade", method, url, body);
    assert.equal(r.status, 403, `${method} ${url}`);
    assert.equal(r.code, "MODULE_NOT_IN_PLAN", `${method} ${url}: the OWNER of the organisation, who holds every permission there is`);
    assert.equal(r.details.module, "crm");
  }

  // A module refusal writes no audit row: nobody in that organisation can act on it, and a row naming the URL
  // somebody typed is what the data-bleed sweep reads as a leak.
  const rows = await ctx.runWithTenant({ companyId: "trd", branchId: "main" }, () => M.ActivityLog.countDocuments({ action: "PERMISSION_DENIED" }));
  assert.equal(rows, 0);
});

test("and it is sold per organisation: a module override turns it on with no change of plan", { skip }, async () => {
  await Org.update("trd", { moduleOverrides: { crm: true } });
  const now = await api("trade", "GET", "/crm/leads");
  assert.equal(now.status, 200, JSON.stringify(now.data));
  assert.deepEqual(now.body, [], "on the token they were already holding");
});

test("the audit trail says what happened, in words a person can read", { skip }, async () => {
  const rows = await as(() => M.ActivityLog.find({ action: /^CRM_/ }).sort({ at: 1 }).lean());
  const actions = rows.map((r) => r.action);
  for (const action of ["CRM_LEAD_CREATED", "CRM_LEAD_ASSIGNED", "CRM_LEAD_QUALIFIED", "CRM_OPPORTUNITY_MOVED", "CRM_STAGES_SAVED", "CRM_SETTINGS_SAVED"]) {
    assert.ok(actions.includes(action), `${action} is on record: ${actions.join(", ")}`);
  }
  const qualified = rows.find((r) => r.action === "CRM_LEAD_QUALIFIED");
  assert.match(qualified.summary, /became a customer and OPP-/);
  // The house shape for an activity trail is { rows, total, page, pages } (AuditService.list), as every other
  // module's /:id/activity returns - not a bare array.
  const trail = await api("looker", "GET", `/crm/leads/${S.lead}/activity`);
  assert.equal(trail.status, 200);
  assert.ok(trail.body.rows.length >= 1, "and the lead's own screen can read it");
  assert.ok(trail.body.rows.every((r) => r.entity === "Lead"), "its own rows, nobody else's");
});

test("the dashboard and the communications log are crm.view", { skip }, async () => {
  const board = await api("looker", "GET", "/crm/dashboard");
  assert.equal(board.status, 200, JSON.stringify(board.data));
  // It is the summary plus the three lists the module opens on.
  for (const key of ["openLeads", "openDeals", "pipelineValue", "late", "mine", "moved", "topDeals", "byOwner", "trend", "funnel"]) {
    assert.ok(key in board.body, `the dashboard answers ${key}`);
  }
  assert.ok(Array.isArray(board.body.moved), "what the documents moved by themselves");
  // Six months, every one of them: a month with nothing won is a point on the line, not a gap in it.
  assert.equal(board.body.trend.length, 6);
  assert.ok(board.body.trend.every((t) => typeof t.month === "string" && typeof t.value === "number"));

  const log = await api("looker", "GET", "/crm/activities");
  assert.equal(log.status, 200);
  assert.ok(Array.isArray(log.body));
  // The log shows what is finished; the worklist never does.
  const worklist = await api("looker", "GET", "/crm/follow-ups");
  assert.equal(worklist.body.every((a) => a.status === "OPEN"), true);
});

test("people: reading needs crm.view, adding crm.create, changing crm.edit, removing crm.delete", { skip }, async () => {
  const list = await api("looker", "GET", "/crm/contacts");
  assert.equal(list.status, 200, JSON.stringify(list.data));

  await cannot("looker", "POST", "/crm/contacts", { name: "Nobody" });
  const made = await api("chaser", "POST", "/crm/contacts", { name: "Rajesh Kumar", designation: "Purchase Manager", phone: "0507778888" });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.body.unlinked, true, "a person who belongs to no company yet");
  const id = made.body._id;

  const read = await api("looker", "GET", `/crm/contacts/${id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.name, "Rajesh Kumar");
  assert.ok(Array.isArray(read.body.timeline), "their page carries what has been said to them");

  await cannot("looker", "PUT", `/crm/contacts/${id}`, { designation: "Owner" });
  const changed = await api("chaser", "PUT", `/crm/contacts/${id}`, { designation: "Head of Purchasing" });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal(changed.body.designation, "Head of Purchasing");
  assert.equal(String(changed.body._id), String(id), "the same person, not a replacement");

  // chaser holds create and edit but not delete.
  await cannot("chaser", "DELETE", `/crm/contacts/${id}`);
  const gone = await api("owner", "DELETE", `/crm/contacts/${id}`);
  assert.equal(gone.status, 200);
  assert.equal((await api("looker", "GET", `/crm/contacts/${id}`)).status, 404);
});

test("a bad person is refused cleanly, and another organisation's is simply not there", { skip }, async () => {
  const bad = await api("chaser", "POST", "/crm/contacts", { email: "someone@nowhere.test" });
  assert.equal(bad.status, 400);
  assert.equal(bad.code, "CONTACT_NAME_REQUIRED");
  const missing = await api("looker", "GET", `/crm/contacts/${FAKE_ID}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.code, "CONTACT_NOT_FOUND");
});

test("the named reports are crm.view, and aging is as at today whatever dates are sent", { skip }, async () => {
  const aging = await api("looker", "GET", "/crm/reports/aging?from=2020-01-01&to=2020-12-31");
  assert.equal(aging.status, 200, JSON.stringify(aging.data));
  // It takes no range on purpose: how old a deal was in 2020 answers nothing anybody acts on.
  assert.equal(aging.body.period, undefined);
  assert.ok(Array.isArray(aging.body.bands) && aging.body.bands.length === 5);
  assert.equal(aging.body.bands.reduce((t, b) => t + b.deals, 0), aging.body.rows.length, "every open deal is in exactly one band");

  const activity = await api("looker", "GET", "/crm/reports/activity");
  assert.equal(activity.status, 200, JSON.stringify(activity.data));
  for (const key of ["byKind", "byPerson", "byDay", "done", "open", "overdue"]) {
    assert.ok(key in activity.body, `the activity report answers ${key}`);
  }
  assert.ok(activity.body.period.from && activity.body.period.to, "it does read a period");

  // Neither is a write, so nobody needs more than crm.view - and a backwards range is still refused cleanly.
  const backwards = await api("looker", "GET", "/crm/reports/activity?from=2026-12-31&to=2026-01-01");
  assert.equal(backwards.status, 400);
  assert.equal(backwards.code, "INVALID_RANGE");
});

test("what was done today shows up on the pulse, the activity report and the calendar - from a real Date", { skip }, async () => {
  // The case that was broken: Mongo hands back completedAt as a Date, and an earlier version turned that into a
  // "day" with String(date).slice(0, 10), got nothing, and reported three finished calls as no busiest day.
  const lead = await api("chaser", "POST", "/crm/leads", enquiry({ name: "Calendar Caller", phone: "0509998888" }));
  assert.equal(lead.status, 201, JSON.stringify(lead.data));
  const note = await api("chaser", "POST", "/crm/activities", { kind: "note", subject: "Rang about the rice", regarding: { kind: "lead", id: lead.body._id } });
  assert.equal(note.status, 201, JSON.stringify(note.data));
  assert.equal(note.body.status, "DONE", "a note is a thing that happened, so it is recorded finished");

  const report = await api("looker", "GET", "/crm/reports/activity");
  assert.ok(report.body.done >= 1);
  assert.ok(report.body.byDay.length >= 1, "a finished follow-up is placed on a day");
  assert.ok(report.body.byDay.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day)), "and every day is a real calendar day");

  const board = await api("looker", "GET", "/crm/dashboard");
  assert.equal(board.body.pulse.length, 14, "two weeks, every day, quiet ones included");
  assert.ok(board.body.pulse.at(-1).count >= 1, "and today is on the end of it");
  assert.ok(Array.isArray(board.body.leadSources) && board.body.leadSources.length >= 1);

  const today = board.body.today;
  const cal = await api("looker", "GET", `/crm/calendar?from=${today}&to=${today}`);
  assert.equal(cal.status, 200, JSON.stringify(cal.data));
  assert.ok(cal.body.items.some((i) => i.type === "activity" && i.title === "Rang about the rice" && i.status === "DONE" && i.movable === false));
  assert.ok(cal.body.items.some((i) => i.type === "lead" && i.title === "Calendar Caller"), "an enquiry is placed on the day it came in");
});

test("the calendar is crm.view, needs a range, and refuses one too long to read", { skip }, async () => {
  assert.equal((await api("looker", "GET", "/crm/calendar")).code, "INVALID_RANGE", "no range at all");
  assert.equal((await api("looker", "GET", "/crm/calendar?from=2026-10-31&to=2026-10-01")).code, "INVALID_RANGE", "backwards");
  const long = await api("looker", "GET", "/crm/calendar?from=2026-01-01&to=2026-12-31");
  assert.equal(long.status, 400);
  assert.equal(long.code, "RANGE_TOO_LONG");
  assert.equal((await api("looker", "GET", "/crm/calendar?from=2026-10-01&to=2026-10-31")).status, 200);
});

test("a follow-up can be rescheduled and handed on with the ordinary edit - no special endpoint", { skip }, async () => {
  const made = await api("chaser", "POST", "/crm/activities", { kind: "call", subject: "Move me", dueAt: "2026-10-21", regarding: { kind: "lead", id: S.lead } });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  // chaser holds crm.edit, so dragging a card to another day is just this call.
  const moved = await api("chaser", "PUT", `/crm/activities/${made.body._id}`, { dueAt: "2026-10-28" });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.equal(moved.body.dueAt, "2026-10-28");
  // looker only holds crm.view: it cannot reschedule anything.
  await cannot("looker", "PUT", `/crm/activities/${made.body._id}`, { dueAt: "2026-10-29" });
  // and a finished one cannot be moved at all.
  const done = await api("chaser", "POST", `/crm/activities/${made.body._id}/done`, { outcome: "spoke" });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const late = await api("chaser", "PUT", `/crm/activities/${made.body._id}`, { dueAt: "2026-11-02" });
  assert.equal(late.status, 409);
  assert.equal(late.code, "ACTIVITY_DONE");
});
