// The company's letterhead belongs to the ORGANISATION: one copy that every person sees and every document prints, changed
// only by someone who may change settings. It used to be kept on each person's own record, so each had their own. Against a
// strict server with real sign-ins: the old per-person copy is adopted once, nobody's own copy matters afterwards, and one
// organisation never sees another's.
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

async function call(method, url, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode, details: data?.details, message: data?.message };
}
const as = (code, fn) => ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const api = (who, method, url, body) => call(method, url, { token: T[who], body: method === "GET" ? undefined : body });
const login = async (email) => (await call("POST", "/login", { body: { email, password: PASSWORD } })).body?.tokens?.accessToken;

async function person(org, who, type, extra = {}) {
  await as(org, () => new M.Admin({ name: who, email: `${who}@${org}.test`, password: PASSWORD, status: "active", isActive: true, type, ...extra }).save());
  T[who] = await login(`${who}@${org}.test`);
  assert.ok(T[who], `${who} signs in`);
}

const OLD_COPY = {
  companyName: "Alpha Foods LLC", addressLine1: "Warehouse 7, Al Quoz", addressLine2: "Dubai", city: "Dubai", state: "Dubai", country: "United Arab Emirates",
  postalCode: "12345", phoneNumber: "+971 4 555 0100", emailAddress: "accounts@alphafoods.com", website: "https://alphafoods.com", vatNumber: "100999888700003",
  companyLogo: { url: "https://cdn.test/alpha-logo.png", publicId: "alpha-logo" },
  bankDetails: { bankName: "Emirates NBD", accountName: "Alpha Foods LLC", accountNumber: "1234567890", ibanNumber: "AE070331234567890123456", swiftCode: "EBILAEAD", currency: "AED" },
};

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = { Admin: require("../../models/core/adminModel"), CompanySettings: require("../../models/modules/financial/companySettingsModel"), Activity: require("../../models/modules/financial/activityLogModel") };
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

test("two organisations; alpha's owner has the company's letterhead on their own record, as every person used to", { skip }, async () => {
  for (const code of ["alpha", "beta"]) {
    assert.equal((await Org.create({ legalName: `${code} Trading`, code, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" })).provisioning.complete, true);
  }
  await person("alpha", "aowner", "super_admin", { companyInfo: OLD_COPY });
  // a second person who typed their own, different, copy later
  await person("alpha", "amanager", "manager", { companyInfo: { companyName: "Second Person's Copy", addressLine1: "Somewhere else" } });
  await person("alpha", "aviewer", "viewer");
  await person("beta", "bowner", "super_admin");
  await as("alpha", () => M.CompanySettings.updateOne({ companyId: "alpha" }, { $set: { "profile.trn": "100999888700003" } }));
});

test("every person sees the organisation's one copy - the earliest owner's, adopted once - and not their own", { skip }, async () => {
  for (const who of ["aviewer", "amanager", "aowner"]) {
    const r = await api(who, "GET", "/company/profile");
    assert.equal(r.status, 200, `${who}: ${JSON.stringify(r.data)}`);
    assert.equal(r.body.companyName, "Alpha Foods LLC", `${who} sees the company's name, not a copy of their own`);
    assert.equal(r.body.addressLine1, "Warehouse 7, Al Quoz");
    assert.equal(r.body.state, "Dubai");
    assert.equal(r.body.phoneNumber, "+971 4 555 0100");
    assert.equal(r.body.emailAddress, "accounts@alphafoods.com");
    assert.equal(r.body.vatNumber, "100999888700003", "the tax number is the one in the tax identity");
    assert.equal(r.body.companyLogo.url, "https://cdn.test/alpha-logo.png");
    assert.deepEqual(r.body.bankDetails, { bankName: "Emirates NBD", accountName: "Alpha Foods LLC", accountNumber: "1234567890", ibanNumber: "AE070331234567890123456", swiftCode: "EBILAEAD", currency: "AED" });
  }
  const stored = await as("alpha", () => M.CompanySettings.findOne({ companyId: "alpha" }).lean());
  assert.ok(stored.profile.letterheadAdoptedAt, "it is marked as adopted");
});

test("adoption happens once: a person changing their own old copy afterwards changes nothing", { skip }, async () => {
  await as("alpha", () => M.Admin.updateOne({ email: "aowner@alpha.test" }, { $set: { "companyInfo.companyName": "Changed On The Person" } }));
  assert.equal((await api("aviewer", "GET", "/company/profile")).body.companyName, "Alpha Foods LLC");
});

test("a person's own profile can no longer carry a company copy, and the old logo route is gone", { skip }, async () => {
  const r = await api("aowner", "PUT", "/profile/me", { name: "Alpha Owner", companyInfo: { companyName: "Hijack LLC", addressLine1: "x" } });
  assert.ok(r.status < 500, JSON.stringify(r.data));
  assert.equal((await api("aviewer", "GET", "/company/profile")).body.companyName, "Alpha Foods LLC", "the letterhead did not move");
  const mine = await as("alpha", () => M.Admin.findOne({ email: "aowner@alpha.test" }).lean());
  assert.notEqual(mine.companyInfo?.companyName, "Hijack LLC", "and it was not written to the person either");
  const gone = await call("POST", "/profile/upload-logo", { token: T.aowner });
  assert.equal(gone.status, 404, "the per-person logo upload no longer exists");
});

test("only someone who may change settings changes the letterhead", { skip }, async () => {
  for (const who of ["aviewer", "amanager"]) {
    const r = await api(who, "PUT", "/company/profile", { companyInfo: { companyName: "Not Allowed LLC" } });
    assert.equal(r.status, 403, `${who}: ${JSON.stringify(r.data)}`);
    assert.equal(r.code, "PERMISSION_DENIED");
    assert.deepEqual(r.details.required, ["settings.manage"]);
  }
  assert.equal((await api("aviewer", "GET", "/company/profile")).body.companyName, "Alpha Foods LLC");

  const ok = await api("aowner", "PUT", "/company/profile", { companyInfo: { companyName: "Alpha Foods Trading LLC", phoneNumber: "+971 4 555 0199", bankDetails: { ibanNumber: "ae07 0331 2345 6789 0123 456", swiftCode: "ebilaead" } } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.body.companyName, "Alpha Foods Trading LLC");
  assert.equal(ok.body.phoneNumber, "+971 4 555 0199");
  const arabic = await api("aowner", "PUT", "/company/profile", { companyInfo: { companyNameArabic: "ألفا للأغذية" } });
  assert.equal(arabic.body.companyNameArabic, "ألفا للأغذية", "the organisation's letterhead can hold the Arabic name the old per-person copy never could");
  assert.equal(ok.body.bankDetails.ibanNumber, "AE070331234567890123456", "tidied: no spaces, upper case");
  assert.equal(ok.body.bankDetails.swiftCode, "EBILAEAD");
  assert.equal(ok.body.addressLine1, "Warehouse 7, Al Quoz", "what was not named is untouched");
  // everyone, at once, sees the same change
  assert.equal((await api("aviewer", "GET", "/company/profile")).body.companyName, "Alpha Foods Trading LLC");
  const row = await as("alpha", () => M.Activity.findOne({ action: "COMPANY_PROFILE_UPDATED" }).lean());
  assert.ok(row && row.username === "aowner@alpha.test" && /companyName/.test(row.summary), "who changed it is on the record");
});

test("the form may also send a multipart-style string for companyInfo, and a bad one is refused", { skip }, async () => {
  const ok = await api("aowner", "PUT", "/company/profile", { companyInfo: JSON.stringify({ city: "Sharjah" }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.body.city, "Sharjah");
  const bad = await api("aowner", "PUT", "/company/profile", { companyInfo: "{not json" });
  assert.equal(bad.status, 400);
  assert.equal(bad.code, "INVALID_COMPANY_INFO");
  await api("aowner", "PUT", "/company/profile", { companyInfo: { city: "Dubai" } });
});

test("what cannot be a letterhead is refused, in words, and nothing is saved", { skip }, async () => {
  const refuse = async (info, code) => {
    const r = await api("aowner", "PUT", "/company/profile", { companyInfo: info });
    assert.equal(r.status, 400, `${JSON.stringify(info)} -> ${r.status} ${JSON.stringify(r.data)}`);
    assert.equal(r.code, code);
  };
  await refuse({ companyName: "   " }, "COMPANY_NAME_REQUIRED");
  await refuse({ companyName: "x".repeat(101) }, "FIELD_TOO_LONG");
  await refuse({ postalCode: "1".repeat(21) }, "FIELD_TOO_LONG");
  await refuse({ emailAddress: "not-an-email" }, "INVALID_EMAIL");
  await refuse({ phoneNumber: "call me maybe" }, "INVALID_PHONE");
  await refuse({ website: "not a site" }, "INVALID_WEBSITE");
  await refuse({ bankDetails: { ibanNumber: "AE00 0000 0000 0000 0000 000" } }, "INVALID_IBAN");
  await refuse({ bankDetails: { swiftCode: "TOOSHORT1" } }, "INVALID_SWIFT");
  await refuse({ bankDetails: { bankName: "b".repeat(101) } }, "FIELD_TOO_LONG");
  assert.equal((await api("aviewer", "GET", "/company/profile")).body.companyName, "Alpha Foods Trading LLC", "unchanged");
});

test("blank values clear a field (an email can be removed), and the tax number is not edited here", { skip }, async () => {
  const r = await api("aowner", "PUT", "/company/profile", { companyInfo: { website: "", emailAddress: "", vatNumber: "100111222333444" } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.body.website, "");
  assert.equal(r.body.emailAddress, "");
  assert.equal(r.body.vatNumber, "100999888700003", "the tax number only changes under Business rules, so the letterhead and the VAT return cannot differ");
});

test("another organisation has its own letterhead, starting from its own name, and never sees alpha's", { skip }, async () => {
  const r = await api("bowner", "GET", "/company/profile");
  assert.equal(r.status, 200);
  assert.equal(r.body.companyName, "beta Trading", "a new organisation starts with its registered name");
  assert.equal(r.body.addressLine1, "");
  assert.equal(r.body.companyLogo, null);
  assert.equal(r.body.bankDetails.bankName, "");
  const set = await api("bowner", "PUT", "/company/profile", { companyInfo: { companyName: "Beta Wholesale" } });
  assert.equal(set.status, 200);
  assert.equal((await api("aviewer", "GET", "/company/profile")).body.companyName, "Alpha Foods Trading LLC", "alpha did not move");
});

test("nobody signed out can read it", { skip }, async () => {
  const r = await call("GET", "/company/profile");
  assert.equal(r.status, 401);
});
