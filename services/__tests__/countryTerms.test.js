// An Indian organisation's books and screens in its own words, against a throwaway database: its starter accounts are
// "Input GST" / "Output GST" (a UAE one keeps "Input VAT"), an account made under the UAE name before is renamed in place
// by the chart top-up and never made twice, and the UAE-only features are refused to it with their own reason.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    Org: require("../core/organisationService"),
    Usage: require("../core/usageService"),
    Chart: require("../financial/defaultChartService"),
    Config: require("../financial/accountConfigService"),
    Ifrs: require("../reports/ifrsReportsService"),
    O: require("../../models/core/organisationModel"),
    LedgerAccount: require("../../models/modules/financial/financialModels").LedgerAccount,
    ctx: require("../../utils/tenantContext"),
  };
  await mongoose.connection.syncIndexes();
});
test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const inOrg = (code, fn) => svc.ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const names = (code) => inOrg(code, () => svc.LedgerAccount.find({ accountName: /VAT|GST/ }).select("accountName").lean()).then((r) => r.map((a) => a.accountName).sort());

test("an Indian organisation's tax accounts say GST; a UAE one's say VAT", { skip }, async () => {
  await svc.Org.create({ legalName: "Brivox Test", code: "intest", country: "IN", baseCurrency: "INR", timezone: "Asia/Kolkata", planCode: "premium" }, { by: "dev" });
  await svc.Org.create({ legalName: "Harbour Test", code: "aetest", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" }, { by: "dev" });
  assert.deepEqual(await names("intest"), ["Input GST", "Output GST", "Reverse-charge GST"]);
  assert.deepEqual(await names("aetest"), ["Input VAT", "Output VAT", "Reverse-charge VAT"]);
  const key = await inOrg("intest", () => svc.Config.resolveAccount("vat-purchase"));
  assert.equal((await inOrg("intest", () => svc.LedgerAccount.findById(key).lean())).accountName, "Input GST", "the posting map points at it");
});

test("an account made under the UAE name before is renamed in place by the chart top-up, never made twice", { skip }, async () => {
  const input = await inOrg("intest", () => svc.LedgerAccount.findOne({ accountName: "Input GST" }).lean());
  await inOrg("intest", () => svc.LedgerAccount.updateOne({ _id: input._id }, { accountName: "Input VAT" })); // as an organisation made before this
  const done = await inOrg("intest", () => svc.Chart.provision());
  assert.equal(done.renamed, 1);
  assert.equal(done.accounts, 0, "nothing new was made");
  assert.deepEqual(await names("intest"), ["Input GST", "Output GST", "Reverse-charge GST"]);
  assert.equal(String(await inOrg("intest", () => svc.Config.resolveAccount("vat-purchase"))), String(input._id), "the same account, the same posting key");
});

test("the UAE VAT return and e-invoicing are refused to an Indian organisation with their own reason", { skip }, async () => {
  const org = await svc.O.findOne({ code: "intest" }).lean();
  await assert.rejects(() => svc.Usage.assertFeature("vatReturn", org), { code: "FEATURE_NOT_FOR_COUNTRY", message: /organisations in the UAE/ });
  await assert.rejects(() => svc.Usage.assertFeature("einvoicing", org), { code: "FEATURE_NOT_FOR_COUNTRY" });
  assert.ok(await svc.Usage.assertFeature("banking", org), "the rest of the plan is untouched");
  const ae = await svc.O.findOne({ code: "aetest" }).lean();
  assert.ok(await svc.Usage.assertFeature("vatReturn", ae));
  assert.equal((await svc.Usage.liveCodes({ feature: "einvoicing" })).has("intest"), false, "no e-invoicing job runs for it");
  assert.equal((await svc.Usage.liveCodes({ feature: "einvoicing" })).has("aetest"), true);
});

// The IFRS notes are the longest piece of prose the product prints, and they used to be written for the UAE alone: an
// Indian company read "Value added tax", "net of VAT" and "the Federal Tax Authority" over a table whose own rows said
// "Output GST payable".
test("the IFRS notes are written in the organisation's own tax words", { skip }, async () => {
  const notes = (code) => inOrg(code, () => svc.Ifrs.notes({ asAt: "2026-10-24" }));
  const india = await notes("intest");
  const policy = (d, key) => d.policies.find((p) => p.key === key);

  assert.equal(policy(india, "vat").title, "Goods and services tax");
  assert.equal(india.tables.vat.title, "Goods and services tax", "the heading agrees with the rows under it");
  assert.deepEqual(india.tables.vat.rows.map((r) => r.label), ["Output GST payable", "Input GST recoverable"]);
  for (const key of ["vat", "revenue"]) {
    assert.match(policy(india, key).text, /\bGST\b/);
    assert.doesNotMatch(policy(india, key).text, /\bVAT\b/, `${key} must not say VAT in India`);
  }
  assert.doesNotMatch(policy(india, "vat").text, /Federal Tax Authority/, "that is the UAE's authority, not India's");
  assert.match(policy(india, "vat").text, /the tax authority/);

  const uae = await notes("aetest");
  assert.equal(policy(uae, "vat").title, "Value added tax");
  assert.equal(uae.tables.vat.title, "Value added tax");
  assert.deepEqual(uae.tables.vat.rows.map((r) => r.label), ["Output VAT payable", "Input VAT recoverable"]);
  assert.match(policy(uae, "vat").text, /Federal Tax Authority/, "a UAE company is still told who it owes");
  assert.match(policy(uae, "revenue").text, /net of VAT/);
});
