// Organisations in different countries keep different books: their own base currency and their own calendar. Until now the
// whole system assumed AED and Dubai time whatever the organisation said. Against a strict server with real sign-ins, three
// organisations - Dubai, Mumbai (a half-hour zone) and London (clocks change) - read their own currency and their own days.
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

let child, M, Org, ctx, tz, L;
let logs = "";
const T = {};

async function call(method, url, { body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, code: data?.errorCode, message: data?.message };
}
const as = (code, fn) => ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const api = (who, method, url, body) => call(method, url, { token: T[who], body: method === "GET" ? undefined : body });
const login = async (email) => (await call("POST", "/login", { body: { email, password: PASSWORD } })).body?.tokens?.accessToken;

const ORGS = [
  { code: "dxb", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai" },
  { code: "mum", country: "IN", baseCurrency: "INR", timezone: "Asia/Kolkata" },
  { code: "lon", country: "GB", baseCurrency: "GBP", timezone: "Europe/London" },
];

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = { Admin: require("../../models/core/adminModel"), FiscalYear: require("../../models/modules/financial/fiscalYearModel"), Settings: require("../../models/modules/financial/companySettingsModel") };
  Org = require("../core/organisationService");
  ctx = require("../../utils/tenantContext");
  tz = require("../../utils/tz");
  L = require("../../utils/orgLocale");
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

test("a time zone west of UTC is refused with the reason, and a made-up one with its own message", { skip }, async () => {
  const make = (timezone) => Org.create({ legalName: "West Trading", code: "west", country: "AE", baseCurrency: "AED", timezone, planCode: "premium" });
  await assert.rejects(() => make("America/New_York"), (e) => e.code === "TIMEZONE_UNSUPPORTED" && /west of UTC/.test(e.message));
  await assert.rejects(() => make("Mars/Phobos"), (e) => e.code === "TIMEZONE_INVALID");
  assert.equal(await mongoose.connection.collection("organisations").countDocuments({ code: "west" }), 0, "nothing half-made");
});

test("three organisations, each with an owner, in Dubai, Mumbai and London", { skip }, async () => {
  for (const o of ORGS) {
    const made = await Org.create({ legalName: `${o.code} Trading`, planCode: "premium", ...o });
    assert.equal(made.provisioning.complete, true, `${o.code}: ${JSON.stringify(made.provisioning.steps)}`);
    await as(o.code, () => new M.Admin({ name: `${o.code}-owner`, email: `${o.code}-owner@test.com`, password: PASSWORD, status: "active", isActive: true, type: "super_admin" }).save());
    T[o.code] = await login(`${o.code}-owner@test.com`);
    assert.ok(T[o.code], `${o.code} signs in`);
  }
});

test("each organisation's locale is what it was made with, read inside its own scope", { skip }, async () => {
  for (const o of ORGS) {
    as(o.code, () => assert.deepEqual(L.current(), { baseCurrency: o.baseCurrency, timezone: o.timezone, country: o.country }));
  }
  assert.equal(L.baseCurrency(), "AED", "outside any scope it is still the original default");
});

test("the first fiscal year begins at 1 January on the organisation's own wall clock", { skip }, async () => {
  for (const o of ORGS) {
    const year = tz.yearOf(new Date(), o.timezone);
    const fy = await as(o.code, () => M.FiscalYear.findOne({ companyId: o.code }).lean());
    assert.ok(fy, `${o.code} has a fiscal year`);
    assert.equal(fy.code, String(year));
    assert.equal(fy.startDate.toISOString(), tz.dayStart(`${year}-01-01`, o.timezone).toISOString(), `${o.code}: starts at its own midnight`);
    assert.equal(fy.endDate.getTime(), tz.dayStart(`${year + 1}-01-01`, o.timezone).getTime() - 1, `${o.code}: ends a millisecond before the next one`);
  }
  // spelled out for the three, so the arithmetic is visible
  const year = new Date().getUTCFullYear();
  const start = async (code) => (await as(code, () => M.FiscalYear.findOne({ companyId: code }).lean())).startDate.toISOString();
  assert.equal(await start("dxb"), `${year - 1}-12-31T20:00:00.000Z`);
  assert.equal(await start("mum"), `${year - 1}-12-31T18:30:00.000Z`);
  assert.equal(await start("lon"), `${year}-01-01T00:00:00.000Z`);
});

test("the day an instant belongs to, and the edges of a day, follow the organisation", { skip }, async () => {
  const instant = new Date("2026-10-08T19:00:00Z"); // 23:00 on the 8th in Dubai, 00:30 on the 9th in Mumbai, 20:00 on the 8th in London
  const LedgerReports = require("../reports/ledgerReportsService");
  assert.equal(as("dxb", () => L.dayOf(instant)), "2026-10-08");
  assert.equal(as("mum", () => L.dayOf(instant)), "2026-10-09");
  assert.equal(as("lon", () => L.dayOf(instant)), "2026-10-08");
  assert.equal(as("mum", () => LedgerReports.dayStart("2026-10-09")).toISOString(), "2026-10-08T18:30:00.000Z");
  assert.equal(as("mum", () => LedgerReports.dayEnd("2026-10-09")).toISOString(), "2026-10-09T18:29:59.999Z");
  assert.equal(as("dxb", () => LedgerReports.dayStart("2026-10-09")).toISOString(), "2026-10-08T20:00:00.000Z");
  assert.equal(as("lon", () => LedgerReports.dayStart("2026-10-09")).toISOString(), "2026-10-08T23:00:00.000Z", "London is on summer time on 9 October");
  assert.equal(as("lon", () => LedgerReports.dayStart("2026-12-09")).toISOString(), "2026-12-09T00:00:00.000Z", "and on winter time in December");
});

test("each organisation's reports speak its own currency", { skip }, async () => {
  for (const o of ORGS) {
    const r = await api(o.code, "GET", "/dashboard-summary");
    assert.equal(r.status, 200, `${o.code}: ${JSON.stringify(r.data).slice(0, 200)}`);
    assert.equal(r.body.currency, o.baseCurrency, `${o.code}'s dashboard is in ${o.baseCurrency}`);
    const list = await api(o.code, "GET", "/currencies");
    assert.equal(list.body.find((c) => c.isBase)?.code, o.baseCurrency, `${o.code}'s currency master has its own base`);
  }
});

test("a change of time zone is picked up, and refused if it would go west", { skip }, async () => {
  assert.equal((await Org.update("lon", { timezone: "Europe/Berlin" })).timezone, "Europe/Berlin");
  as("lon", () => assert.equal(L.timezone(), "Europe/Berlin", "the next read already uses it"));
  await assert.rejects(() => Org.update("lon", { timezone: "America/Chicago" }), (e) => e.code === "TIMEZONE_UNSUPPORTED");
  assert.equal((await Org.get("lon")).timezone, "Europe/Berlin", "unchanged by the refusal");
});

test("the invoice email dates and money use the organisation's own zone and currency", { skip }, async () => {
  const templates = require("../../utils/emailTemplates");
  const subject = (code) => as(code, () => templates.subjectFor({ docType: "statement", documentNo: "ST-1", company: { companyName: "Co" }, period: { from: "2026-10-08T19:00:00Z", to: "2026-10-31T00:00:00Z" } }));
  assert.match(subject("dxb"), /8 Oct 2026/, "23:00 on the 8th in Dubai");
  assert.match(subject("mum"), /9 Oct 2026/, "00:30 on the 9th in Mumbai");
});
