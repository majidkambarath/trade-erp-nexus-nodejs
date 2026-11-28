// A new client's onboarding form, against a real strict server: the developer makes a private link, the client fills it in
// with no account (saved as they go, files beside it) and sends it, and the developer makes the organisation from it - which
// writes the client's letterhead and tax identity into the new organisation and can make their other people's accounts.
//
// What it guards above all: the link is the only credential and opens only its own form; nothing the client sends reaches
// the database uncleaned; a sent, withdrawn, out-of-date or used form cannot be changed; one form makes one organisation.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");
const { runUnscoped } = require("../../utils/tenantContext");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_e2e_onb_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const PORT = 3300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const DEV = { name: "Dev One", email: "dev-onb@zarvia.test", password: "a-long-passphrase-123" };
const RUN = Date.now().toString(36);

let child, PlatformAuth, OnboardingRequest, OnboardingFile, Organisation, CompanySettings, PlatformAudit, Admin;
let logs = "";
const S = {};

async function call(method, url, { body, token, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: form || (body !== undefined ? JSON.stringify(body) : undefined) });
  const type = res.headers.get("content-type") || "";
  const raw = type.includes("json") ? null : Buffer.from(await res.arrayBuffer());
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode, headers: res.headers, raw };
}
const plat = (method, url, body) => call(method, `/platform${url}`, { body, token: S.token });
const pub = (method, token, tail = "", body) => call(method, `/client-onboarding/${token}${tail}`, { body });
const upload = (token, kind, name, bytes, type = "application/octet-stream") => {
  const form = new FormData();
  form.append("kind", kind);
  form.append("file", new Blob([bytes], { type }), name);
  return call("POST", `/client-onboarding/${token}/files`, { form });
};
const invite = (extra = {}) => plat("POST", "/onboarding", { clientName: "Gulf Fresh Trading LLC", contactName: "Omar Hassan", contactEmail: `omar.${RUN}@gulffresh.test`, planCode: "premium", ...extra });

// The complete answers a real client might give.
const answers = (tag = "a") => ({
  company: {
    legalName: "Gulf Fresh Trading LLC", tradeName: "Gulf Fresh", country: "AE", emirate: "Dubai",
    addressLine1: "Warehouse 4, Al Quoz 3", city: "Dubai", phone: "+971501234567", email: `accounts.${tag}.${RUN}@gulffresh.test`,
    taxRegistered: "yes", taxNumber: "100123456789012", taxRegisteredFrom: "2024-01-01",
    bankName: "Emirates NBD", bankAccountName: "Gulf Fresh Trading LLC", iban: "AE070331234567890123456", swift: "EBILAEAD",
  },
  business: { baseCurrency: "AED", fiscalYearStart: 1, businessType: "distribution", sells: "goods", modules: ["sales", "purchase", "inventory", "accounts", "vansales"] },
  people: {
    admin: { name: "Omar Hassan", email: `omar.${tag}.${RUN}@gulffresh.test`, mobile: "+971501112222", jobTitle: "Owner" },
    users: [
      { name: "Leena", email: `leena.${tag}.${RUN}@gulffresh.test`, role: "accountant" },
      { name: "Ravi", email: `ravi.${tag}.${RUN}@gulffresh.test`, role: "van_salesman" },
    ],
  },
  goLive: { goLiveDate: "2027-01-01", customersCount: 120 },
});

const orgBody = (form, extra = {}) => ({
  legalName: form.company.legalName, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium",
  moduleOverrides: { vansales: true },
  firstAdmin: { name: form.people.admin.name, email: form.people.admin.email, password: "Welcome-12345" },
  ...extra,
});

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0", PLATFORM_LOGIN_LIMIT: "200", PUBLIC_APP_URL: "https://app.zarvia.test", SYSTEM_MAIL_PROVIDER: "console" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  PlatformAuth = require("../platform/platformAuthService");
  ({ OnboardingRequest } = require("../../models/platform/onboardingRequestModel"));
  OnboardingFile = require("../../models/platform/onboardingFileModel");
  Organisation = require("../../models/core/organisationModel");
  CompanySettings = require("../../models/modules/financial/companySettingsModel");
  PlatformAudit = require("../../models/platform/platformAuditModel");
  Admin = require("../../models/core/adminModel");
  await mongoose.connection.syncIndexes();
  const deadline = Date.now() + 90000;
  for (;;) {
    try { const h = await fetch(`${BASE}/health`); if (h.ok && (await h.json()).ready !== false) break; } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
  await PlatformAuth.create(DEV);
  S.token = (await call("POST", "/platform/login", { body: { email: DEV.email, password: DEV.password } })).body.token;
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

test("only the console makes a link, the link is shown once, and only its hash is kept", { skip }, async () => {
  assert.equal((await call("POST", "/platform/onboarding", { body: { clientName: "X Co" } })).status, 401, "no console token, no link");
  assert.equal((await plat("POST", "/onboarding", { clientName: " " })).code, "CLIENT_NAME_REQUIRED");
  assert.equal((await plat("POST", "/onboarding", { clientName: "X Co", contactEmail: "nope" })).code, "INVALID_EMAIL");
  assert.equal((await plat("POST", "/onboarding", { clientName: "X Co", days: 500 })).code, "ONBOARDING_DAYS_INVALID");

  const r = await invite();
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.headers.get("cache-control") || "", /no-store/);
  assert.match(r.body.url, /^https:\/\/app\.zarvia\.test\/onboard\/[0-9A-Z]{11}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(r.body.request.status, "invited");
  assert.equal(r.body.request.answers.company.legalName, "Gulf Fresh Trading LLC", "what the developer knows is written in for the client");
  assert.equal(r.body.request.answers.people.admin.name, "Omar Hassan");
  S.id = r.body.request.id;
  S.link = r.body.token;

  const secret = S.link.split(".")[1];
  const row = await OnboardingRequest.findById(S.id).select("+secretHash").lean();
  assert.equal(row.secretHash, crypto.createHash("sha256").update(secret).digest("hex"));
  assert.ok(!JSON.stringify(row).includes(secret), "the secret itself is stored nowhere");
  const audit = await PlatformAudit.find({ action: "ONBOARDING_LINK_CREATED" }).lean();
  assert.equal(audit.length, 1);
  assert.ok(!JSON.stringify(audit).includes(secret), "nor in the platform's log");
  assert.equal((await plat("GET", "/onboarding/0123456789abcdef01234567")).status, 404);
});

test("the client opens the form with the link alone, and learns nothing about anybody else", { skip }, async () => {
  const r = await pub("GET", S.link);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.headers.get("cache-control") || "", /no-store/);
  assert.match(r.headers.get("x-robots-tag") || "", /noindex/);
  assert.equal(r.body.clientName, "Gulf Fresh Trading LLC");
  assert.ok(r.body.options.currencies.some((c) => c.code === "AED"));
  for (const k of ["secretHash", "publicId", "createdBy", "note", "history", "contactEmail"]) assert.equal(r.body[k], undefined, `${k} is not the client's to see`);

  const [pid] = S.link.split(".");
  const wrong = await pub("GET", `${pid}.${"A".repeat(43)}`);
  const junk = await pub("GET", "not-a-link");
  const unknown = await pub("GET", `${"0".repeat(11)}.${"A".repeat(43)}`);
  for (const x of [wrong, junk, unknown]) assert.equal(x.code, "ONBOARDING_NOT_FOUND");
  assert.equal(wrong.data.message, junk.data.message, "a wrong secret reads exactly like a made-up link");
  const opened = await OnboardingRequest.findById(S.id).lean();
  assert.equal(opened.views, 1, "only the real link counts as a visit");
  assert.ok(opened.openedAt);
});

test("what the client saves is cleaned first: no object, no stray key, no Owner", { skip }, async () => {
  const hostile = await pub("PUT", S.link, "", {
    answers: { company: { legalName: { $ne: null }, country: "AE" }, people: { users: [{ name: "Boss", email: "b@x.test", role: "super_admin" }] }, $where: "1", status: "created" },
    status: "created", organisationCode: "evil",
  });
  assert.equal(hostile.status, 200, JSON.stringify(hostile.data));
  let row = await OnboardingRequest.findById(S.id).lean();
  assert.equal(row.answers.company.legalName, "");
  assert.equal(row.answers.people.users[0].role, "");
  assert.equal(row.answers.$where, undefined);
  assert.equal(row.status, "in_progress", "the body cannot set the form's own state");
  assert.equal(row.organisationCode, null);

  const saved = await pub("PUT", S.link, "", { answers: answers("a") });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.progress.percent, 100);
  assert.deepEqual(saved.body.issues, []);
  row = await OnboardingRequest.findById(S.id).lean();
  assert.equal(row.answers.company.taxNumber, "100123456789012");
});

test("files: each slot takes its own kinds, the bytes must match, size is capped, and only the console reads them back", { skip }, async () => {
  const csv = Buffer.from("Name,Phone\nAl Noor Foods,+971501234567\n");
  const ok = await upload(S.link, "customers", "customers list.csv", csv, "text/csv");
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.body.kind, "customers");
  assert.equal(ok.body.name, "customers list.csv");
  S.fileId = ok.body.id;

  assert.equal((await upload(S.link, "customers", "list.pdf", Buffer.from("%PDF-1.4"))).code, "FILE_TYPE_NOT_ALLOWED", "a list must be a spreadsheet");
  assert.equal((await upload(S.link, "logo", "logo.svg", Buffer.from("<svg onload=alert(1)>"))).code, "FILE_TYPE_NOT_ALLOWED");
  assert.equal((await upload(S.link, "items", "items.xlsx", Buffer.from("just text, not a workbook"))).code, "FILE_CONTENT_MISMATCH", "the ending alone proves nothing");
  assert.equal((await upload(S.link, "made-up", "a.csv", csv)).code, "FILE_KIND_INVALID");
  assert.equal((await upload(S.link, "customers", "big.csv", Buffer.alloc(5 * 1024 * 1024 + 10, 65))).status, 413);
  assert.equal((await upload(S.link, "../../etc", "../../evil.csv", csv)).code, "FILE_KIND_INVALID");

  const named = await upload(S.link, "other", "../../evil <script>.csv", csv);
  assert.equal(named.status, 201);
  assert.equal(named.body.name, "evil _script_.csv", "the sender's name is made safe");
  assert.equal((await pub("DELETE", S.link, `/files/${named.body.id}`)).status, 200);
  assert.equal(await OnboardingFile.countDocuments({ _id: named.body.id }), 0, "removed means the bytes are gone too");

  const detail = await plat("GET", `/onboarding/${S.id}`);
  assert.equal(detail.body.files.length, 1);
  const dl = await call("GET", `/platform/onboarding/${S.id}/files/${S.fileId}`, { token: S.token });
  assert.equal(dl.status, 200);
  assert.ok(dl.raw.equals(csv), "the developer gets the very bytes the client sent");
  assert.match(dl.headers.get("content-disposition") || "", /^attachment;/);
  assert.equal(dl.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await call("GET", `/platform/onboarding/${S.id}/files/${S.fileId}`)).status, 401, "never without the console's token");
  const fromLink = await pub("GET", S.link, `/files/${S.fileId}`);
  assert.ok(!fromLink.raw || !fromLink.raw.equals(csv), "the link cannot read a file back");
});

test("an incomplete form is not sent, and every missing answer is named at once", { skip }, async () => {
  const other = await invite({ clientName: "Half Done LLC", contactEmail: "" });
  const r = await pub("POST", other.body.token, "/submit", { answers: { company: { legalName: "Half Done LLC" } } });
  assert.equal(r.status, 422);
  assert.equal(r.code, "ONBOARDING_INCOMPLETE");
  const fields = r.data.details.issues.map((i) => i.field);
  for (const f of ["country", "phone", "baseCurrency", "admin.email", "goLiveDate"]) assert.ok(fields.includes(f), f);
  const row = await OnboardingRequest.findById(other.body.request.id).lean();
  assert.equal(row.status, "in_progress", "what they wrote is kept even though it could not be sent");
  assert.equal(row.answers.company.legalName, "Half Done LLC");
  S.half = { id: other.body.request.id, link: other.body.token };
});

test("a sent form is locked until the developer opens it again", { skip }, async () => {
  const sent = await pub("POST", S.link, "/submit", { answers: answers("a") });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal((await pub("PUT", S.link, "", { answers: answers("a") })).code, "ONBOARDING_SUBMITTED");
  assert.equal((await upload(S.link, "customers", "c.csv", Buffer.from("a,b\n"))).code, "ONBOARDING_SUBMITTED");
  assert.equal((await pub("POST", S.link, "/submit", {})).code, "ONBOARDING_SUBMITTED");
  assert.equal((await pub("GET", S.link)).body.status, "submitted", "but they can still read what they sent");
  assert.equal((await PlatformAudit.find({ action: "ONBOARDING_SUBMITTED" }).lean()).length, 1);

  const reopened = await plat("POST", `/onboarding/${S.id}/reopen`);
  assert.equal(reopened.body.status, "in_progress");
  assert.equal((await pub("PUT", S.link, "", { answers: answers("a") })).status, 200);
  assert.equal((await pub("POST", S.link, "/submit", {})).status, 200);
  assert.equal((await plat("POST", `/onboarding/${S.half.id}/reopen`)).code, "ONBOARDING_NOT_SUBMITTED");
});

test("a withdrawn link and an out-of-date link stop working, and a new link replaces the old", { skip }, async () => {
  const { id, link } = S.half;
  await plat("POST", `/onboarding/${id}/revoke`);
  assert.equal((await pub("GET", link)).code, "ONBOARDING_REVOKED");
  assert.equal((await pub("PUT", link, "", { answers: {} })).code, "ONBOARDING_REVOKED");

  const fresh = await plat("POST", `/onboarding/${id}/link`, { days: 10 });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
  assert.equal((await pub("GET", link)).code, "ONBOARDING_NOT_FOUND", "the old link opens nothing");
  assert.equal((await pub("GET", fresh.body.token)).status, 200);
  assert.equal((await pub("GET", fresh.body.token)).body.answers.company.legalName, "Half Done LLC", "nothing they wrote is lost");

  await OnboardingRequest.updateOne({ _id: id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await pub("GET", fresh.body.token)).code, "ONBOARDING_EXPIRED");
  assert.equal((await plat("GET", "/onboarding")).body.find((r) => r.id === id).state, "expired");
  await plat("POST", `/onboarding/${id}/extend`, { days: 5 });
  assert.equal((await pub("GET", fresh.body.token)).status, 200, "more time opens it again");
});

test("the organisation is made from the form, with the client's letterhead and tax identity written in", { skip }, async () => {
  const form = answers("a");
  const r = await plat("POST", "/organisations", orgBody(form, { onboardingId: S.id }));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const code = r.body.organisation.code;
  assert.equal(r.body.onboarding.applied.profile.state, "done", JSON.stringify(r.body.onboarding));
  assert.equal(r.body.onboarding.applied.settings.state, "done", JSON.stringify(r.body.onboarding));
  assert.ok(r.body.firstAdmin);

  const org = await Organisation.findOne({ code }).lean();
  assert.equal(org.tradeName, "Gulf Fresh", "the trade name the client gave comes too");
  const settings = await runUnscoped("test: read the new organisation's settings", () => CompanySettings.findOne({ companyId: code }).lean());
  assert.equal(settings.profile.trn, "100123456789012");
  assert.equal(settings.profile.vatRegistered, true);
  assert.equal(settings.profile.vatRegisteredFrom, "2024-01-01");
  assert.equal(settings.profile.emirate, "Dubai");
  assert.equal(settings.profile.addressLine1, "Warehouse 4, Al Quoz 3");
  assert.equal(settings.profile.bank.ibanNumber, "AE070331234567890123456");
  assert.equal(settings.fiscalYearStartMonth, 1);

  const row = await OnboardingRequest.findById(S.id).lean();
  assert.equal(row.status, "created");
  assert.equal(row.organisationCode, code);
  assert.equal(row.creatingAt, null);
  const opened = await pub("GET", S.link);
  assert.equal(opened.body.organisationReady, true, "the client is told their organisation is ready");
  assert.equal((await pub("PUT", S.link, "", { answers: form })).code, "ONBOARDING_DONE");
  assert.equal((await plat("POST", `/onboarding/${S.id}/revoke`)).code, "ONBOARDING_DONE");

  const before = await Organisation.countDocuments();
  const again = await plat("POST", "/organisations", orgBody(answers("z"), { legalName: "Second Try LLC", onboardingId: S.id }));
  assert.equal(again.code, "ONBOARDING_ALREADY_USED");
  assert.equal(await Organisation.countDocuments(), before, "one form, one organisation");
  const audit = await PlatformAudit.findOne({ action: "ORGANISATION_CREATED", organisation: code }).lean();
  assert.equal(audit.details.onboarding, S.id);
  S.code = code;
});

test("two developers pressing Create at once make one organisation", { skip }, async () => {
  const made = await invite({ clientName: "Race Co LLC", contactEmail: "" });
  const id = made.body.request.id;
  await pub("POST", made.body.token, "/submit", { answers: answers("r") });
  const before = await Organisation.countDocuments();
  const [one, two] = await Promise.all([
    plat("POST", "/organisations", orgBody(answers("r"), { legalName: "Race Co LLC", onboardingId: id })),
    plat("POST", "/organisations", orgBody(answers("s"), { legalName: "Race Co Two LLC", onboardingId: id })),
  ]);
  const statuses = [one.status, two.status].sort();
  assert.deepEqual(statuses, [201, 409], `${JSON.stringify(one.data)} / ${JSON.stringify(two.data)}`);
  assert.ok(["ONBOARDING_BUSY", "ONBOARDING_ALREADY_USED"].includes((one.status === 409 ? one : two).code));
  assert.equal(await Organisation.countDocuments(), before + 1);
});

test("a creation that fails gives the form back", { skip }, async () => {
  const made = await invite({ clientName: "Taken Code LLC", contactEmail: "" });
  const id = made.body.request.id;
  const r = await plat("POST", "/organisations", orgBody(answers("t"), { legalName: "Taken Code LLC", code: S.code, onboardingId: id }));
  assert.equal(r.code, "ORGANISATION_CODE_TAKEN");
  const row = await OnboardingRequest.findById(id).lean();
  assert.equal(row.creatingAt, null, "not left half claimed");
  assert.notEqual(row.status, "created");
  const second = await plat("POST", "/organisations", orgBody(answers("t"), { legalName: "Taken Code LLC", onboardingId: id }));
  assert.equal(second.status, 201, JSON.stringify(second.data));
});

test("the client's other people get their own accounts, each once, with a password shown once", { skip }, async () => {
  assert.equal((await plat("POST", `/onboarding/${S.half.id}/users`)).code, "ONBOARDING_NO_ORGANISATION");
  const r = await plat("POST", `/onboarding/${S.id}/users`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(r.headers.get("cache-control") || "", /no-store/);
  assert.deepEqual(r.body.failed, []);
  assert.deepEqual(r.body.created.map((u) => u.role).sort(), ["accountant", "van_salesman"]);
  for (const u of r.body.created) {
    assert.ok(u.password.length >= 12);
    const stored = await runUnscoped("test: read an account of the new organisation", () => Admin.findOne({ email: u.email }).lean());
    assert.equal(stored.companyId, S.code);
    assert.equal(stored.mustChangePassword, true, "they choose their own at first sign-in");
    const signIn = await call("POST", "/login", { body: { email: u.email, password: u.password } });
    assert.equal(signIn.status, 200, JSON.stringify(signIn.data));
  }
  const row = await OnboardingRequest.findById(S.id).lean();
  assert.equal(row.usersCreated.length, 2);
  assert.ok(!JSON.stringify(row).includes(r.body.created[0].password), "the password is kept nowhere");
  const again = await plat("POST", `/onboarding/${S.id}/users`);
  assert.equal(again.body.created.length, 0);
  assert.equal(again.body.skipped, 2, "nobody is made twice");
});
