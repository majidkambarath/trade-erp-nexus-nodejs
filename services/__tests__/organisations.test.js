// Creating organisations and their branches, against a throwaway database. What matters: a new
// organisation gets its OWN masters in the base currency the developer chose, a head-office branch is
// made with it, nothing leaks into the organisation that already exists, the rules that cannot change
// are enforced, and a half-finished set-up is visible and can be finished.
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
    Branch: require("../core/branchService"),
    O: require("../../models/core/organisationModel"),
    B: require("../../models/core/branchModel"),
    Settings: require("../../models/modules/financial/companySettingsModel"),
    FiscalYear: require("../../models/modules/financial/fiscalYearModel"),
    TaxCode: require("../../models/modules/financial/taxCodeModel"),
    cur: require("../../models/modules/financial/currencyModels"),
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

const input = (over = {}) => ({ legalName: "Harbour Trading LLC", country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "standard", ...over });
const inOrg = (code, fn) => svc.ctx.runWithTenant({ companyId: code, branchId: "main" }, fn);
const rejectsWith = (p, code) => assert.rejects(p, (e) => e.code === code || e.errorCode === code, `expected ${code}`);

test("a new organisation gets a code, a head-office branch and its own masters in the chosen base currency", { skip }, async () => {
  const made = await svc.Org.create(input({ legalName: "Al Noor Foods LLC", baseCurrency: "SAR", country: "SA" }), { by: "dev1" });
  const org = made.organisation;
  assert.equal(org.code, "al-noor-foods-llc");
  assert.equal(org.baseCurrency, "SAR");
  assert.equal(org.createdBy, "dev1");

  assert.equal(made.headOffice.code, "main");
  assert.equal(made.headOffice.isHeadOffice, true);
  assert.equal(made.headOffice.name, "Head Office");
  assert.equal(made.headOffice.companyId, org.code);

  const settings = await inOrg(org.code, () => svc.Settings.findOne({ companyId: org.code }).lean());
  assert.equal(settings.baseCurrency, "SAR", "its books are in the currency chosen");
  assert.equal(settings.profile.legalName, "Al Noor Foods LLC");
  assert.equal(settings.profile.countryCode, "SA");
  assert.ok(settings.accountConfiguration.length > 0, "the posting map is seeded");

  const currencies = await inOrg(org.code, () => svc.cur.Currency.find({ companyId: org.code }).lean());
  assert.deepEqual(currencies.map((c) => [c.code, c.isBase, c.decimals]), [["SAR", true, 2]]);
  assert.equal(await inOrg(org.code, () => svc.FiscalYear.countDocuments()), 1);
});

test("provisioning says plainly what is done, what was skipped and what is waiting", { skip }, async () => {
  const org = await svc.Org.get("al-noor-foods-llc");
  const { steps, complete } = org.provisioning;
  assert.equal(steps.settings.state, "done");
  assert.equal(steps.currency.state, "done");
  assert.equal(steps.fiscalYear.state, "done");
  assert.equal(steps.taxCodes.state, "skipped", "there is no starter tax set for Saudi Arabia");
  assert.match(steps.taxCodes.reason, /SA/);
  assert.equal(steps.chart.state, "done", "the chart is provisioned now that the ledger is separated by organisation");
  assert.equal(complete, true, "every step is done or knowingly skipped, so the organisation is complete");
  assert.equal(await inOrg(org.code, () => svc.TaxCode.countDocuments()), 0, "skipped tax codes stay skipped: nothing was invented");
  const accounts = await inOrg(org.code, () => mongoose.models.LedgerAccount.countDocuments());
  assert.ok(accounts > 10, "it has a chart of its own");
  assert.equal(await inOrg("default", () => mongoose.models.LedgerAccount.countDocuments()), 0, "and the original organisation was not touched by it");
});

test("a UAE organisation gets the UAE VAT starter codes; a second one's masters never mix with the first's", { skip }, async () => {
  const a = (await svc.Org.create(input({ legalName: "Dubai Spice Traders" }))).organisation;
  const b = (await svc.Org.create(input({ legalName: "Sharjah Dates Co", baseCurrency: "USD" }))).organisation;
  const codesA = await inOrg(a.code, () => svc.TaxCode.find().lean());
  assert.ok(codesA.length > 0, "UAE starter tax codes");
  assert.ok(codesA.every((t) => t.companyId === a.code));
  assert.equal((await inOrg(b.code, () => svc.cur.Currency.find().lean())).map((c) => c.code).join(), "USD");
  assert.equal((await inOrg(a.code, () => svc.cur.Currency.find().lean())).map((c) => c.code).join(), "AED");
  assert.equal(await inOrg(a.code, () => svc.Settings.countDocuments()), 1, "one settings row each");
  assert.equal(await svc.ctx.runUnscoped("a test counting every organisation's settings rows", () => svc.Settings.countDocuments()), 3, "three organisations so far");
});

test("provisioning can be run again and creates nothing twice", { skip }, async () => {
  const code = "dubai-spice-traders";
  const before = await inOrg(code, async () => [await svc.FiscalYear.countDocuments(), await svc.TaxCode.countDocuments(), await svc.cur.Currency.countDocuments()]);
  const again = await svc.Org.provision(code);
  const after = await inOrg(code, async () => [await svc.FiscalYear.countDocuments(), await svc.TaxCode.countDocuments(), await svc.cur.Currency.countDocuments()]);
  assert.deepEqual(after, before);
  assert.equal(again.steps.settings.state, "done");
});

test("a three-decimal or unknown base currency is refused with the reason", { skip }, async () => {
  for (const code of ["KWD", "bhd", "OMR"]) {
    await assert.rejects(() => svc.Org.create(input({ legalName: `Gulf ${code}`, baseCurrency: code })), (e) => e.code === "CURRENCY_NOT_SUPPORTED" && /three decimal/.test(e.message), code);
  }
  await rejectsWith(svc.Org.create(input({ baseCurrency: "XYZ" })), "CURRENCY_NOT_SUPPORTED");
  await rejectsWith(svc.Org.create(input({ baseCurrency: "" })), "CURRENCY_NOT_SUPPORTED");
  assert.equal(await svc.O.countDocuments({ legalName: /^Gulf / }), 0, "nothing was half-created");
});

test("a bad organisation is refused before anything is made", { skip }, async () => {
  const before = await svc.O.countDocuments();
  await rejectsWith(svc.Org.create(input({ legalName: "" })), "LEGAL_NAME_REQUIRED");
  await rejectsWith(svc.Org.create(input({ country: "UAE" })), "COUNTRY_REQUIRED");
  await rejectsWith(svc.Org.create(input({ timezone: "Mars/Olympus" })), "TIMEZONE_INVALID");
  await rejectsWith(svc.Org.create(input({ planCode: "gold" })), "PLAN_INVALID");
  await rejectsWith(svc.Org.create(input({ subscription: { graceDays: 200 } })), "GRACE_INVALID");
  await rejectsWith(svc.Org.create(input({ subscription: { onExpiry: "delete" } })), "ON_EXPIRY_INVALID");
  await rejectsWith(svc.Org.create(input({ subscription: { endsAt: "not a date" } })), "ENDS_AT_INVALID");
  await assert.rejects(() => svc.Org.create(input({ code: "-bad-" })), /lower-case letters/);
  await assert.rejects(() => svc.Org.create(input({ code: "platform" })), /reserved/);
  await assert.rejects(() => svc.Org.create(input({ featureOverrides: { teleportation: true } })), /known features/);
  await assert.rejects(() => svc.Org.create(input({ limitOverrides: { users: -1 } })), /known limits/);
  assert.equal(await svc.O.countDocuments(), before, "no organisation was created by any of those");
});

test("a code is generated from the name, made unique, and cannot be taken twice", { skip }, async () => {
  const one = (await svc.Org.create(input({ legalName: "Twin Name Ltd" }))).organisation;
  const two = (await svc.Org.create(input({ legalName: "Twin Name Ltd" }))).organisation;
  assert.equal(one.code, "twin-name-ltd");
  assert.equal(two.code, "twin-name-ltd-2");
  await rejectsWith(svc.Org.create(input({ legalName: "Anyone", code: "twin-name-ltd" })), "ORGANISATION_CODE_TAKEN");
  assert.equal((await svc.Org.create(input({ legalName: "Custom", code: "MyCo" }))).organisation.code, "myco", "a chosen code is lower-cased");
});

test("every organisation has exactly one head office, enforced by the database", { skip }, async () => {
  const code = "twin-name-ltd";
  const heads = await inOrg(code, () => svc.B.find({ isHeadOffice: true }).lean());
  assert.equal(heads.length, 1);
  await assert.rejects(() => inOrg(code, () => svc.B.create({ code: "second-ho", name: "Another head office", isHeadOffice: true })), (e) => e.code === 11000, "a second head office is refused by the index");
  await assert.rejects(() => inOrg(code, () => svc.Branch.update("main", { isActive: false })), (e) => e.code === "HEAD_OFFICE_REQUIRED");
  await assert.rejects(() => inOrg(code, () => svc.Branch.update("main", { isHeadOffice: false })), (e) => e.code === "HEAD_OFFICE_LOCKED");
});

test("a further branch needs the feature and room under the limit", { skip }, async () => {
  const trial = (await svc.Org.create(input({ legalName: "Trial Co", planCode: "trial" }))).organisation;
  await assert.rejects(() => inOrg(trial.code, () => svc.Branch.create({ code: "dxb", name: "Dubai" }, {})), (e) => e.code === "FEATURE_NOT_IN_PLAN" && e.details.feature === "multiBranch");

  await svc.Org.update(trial.code, { featureOverrides: { multiBranch: true } });
  await assert.rejects(() => inOrg(trial.code, () => svc.Branch.create({ code: "dxb", name: "Dubai" }, {})), (e) => e.code === "LIMIT_REACHED", "the trial allows one branch, which the head office already is");

  await svc.Org.update(trial.code, { limitOverrides: { branches: 3 } });
  const dxb = await inOrg(trial.code, () => svc.Branch.create({ code: "DXB", name: "Dubai", city: "Dubai" }, {}));
  assert.equal(dxb.code, "dxb");
  assert.equal(dxb.isHeadOffice, false);
  assert.equal(dxb.companyId, trial.code);
  await inOrg(trial.code, () => svc.Branch.create({ code: "shj", name: "Sharjah" }, {}));
  await assert.rejects(() => inOrg(trial.code, () => svc.Branch.create({ code: "ajm", name: "Ajman" }, {})), (e) => e.code === "LIMIT_REACHED", "the third is the last");
  await assert.rejects(() => inOrg(trial.code, () => svc.Branch.create({ code: "dxb", name: "Again" }, {})), (e) => e.code === "LIMIT_REACHED" || e.code === "BRANCH_CODE_TAKEN");
});

test("an organisation sees only its own branches, and a switched-off branch frees its place", { skip }, async () => {
  assert.deepEqual((await inOrg("trial-co", () => svc.Branch.list())).map((b) => b.code), ["main", "dxb", "shj"], "head office first");
  assert.deepEqual((await inOrg("twin-name-ltd", () => svc.Branch.list())).map((b) => b.code), ["main"], "another organisation's branches are invisible");
  await assert.rejects(() => inOrg("twin-name-ltd", () => svc.Branch.get("dxb")), (e) => e.code === "BRANCH_NOT_FOUND");
  await inOrg("trial-co", () => svc.Branch.update("shj", { isActive: false }));
  const ajm = await inOrg("trial-co", () => svc.Branch.create({ code: "ajm", name: "Ajman" }, {}));
  assert.equal(ajm.code, "ajm", "switching one off made room");
});

test("what cannot change once the books exist is refused, with the reason", { skip }, async () => {
  const code = "al-noor-foods-llc";
  await assert.rejects(() => svc.Org.update(code, { baseCurrency: "USD" }), (e) => e.code === "BASE_CURRENCY_LOCKED" && e.statusCode === 409);
  await assert.rejects(() => svc.Org.update(code, { country: "AE" }), (e) => e.code === "COUNTRY_LOCKED");
  await assert.rejects(() => svc.Org.update(code, { code: "renamed" }), (e) => e.code === "CODE_LOCKED");
  assert.equal((await svc.Org.update(code, { baseCurrency: "sar", country: "sa", code: code })).baseCurrency, "SAR", "saying the same thing again is harmless");
});

test("the developer edits an organisation's own data, and a mistake changes nothing", { skip }, async () => {
  const code = "al-noor-foods-llc";
  const edited = await svc.Org.update(code, { legalName: "Al Noor Foods Trading LLC", tradeName: "Al Noor", timezone: "Asia/Riyadh", planCode: "premium", notes: "Signed 8 Oct" });
  assert.equal(edited.legalName, "Al Noor Foods Trading LLC");
  assert.equal(edited.planCode, "premium");
  assert.equal(edited.timezone, "Asia/Riyadh");
  await assert.rejects(() => svc.Org.update(code, { planCode: "gold" }), (e) => e.code === "PLAN_INVALID");
  await assert.rejects(() => svc.Org.update(code, { timezone: "Nowhere/Land" }), (e) => e.code === "TIMEZONE_INVALID");
  await assert.rejects(() => svc.Org.update(code, { status: "deleted" }), (e) => e.code === "STATUS_INVALID");
  assert.equal((await svc.Org.get(code)).planCode, "premium", "the refused edits left it as it was");
});

test("features and limits are overridden per organisation, merged, reset, and null means unlimited", { skip }, async () => {
  const plans = require("../../utils/plans");
  const code = "dubai-spice-traders"; // a standard plan
  let org = await svc.Org.update(code, { featureOverrides: { einvoicing: true }, limitOverrides: { users: 25 } });
  assert.equal(plans.hasFeature(org, "einvoicing"), true, "switched on over the plan");
  org = await svc.Org.update(code, { featureOverrides: { banking: false } });
  assert.equal(plans.hasFeature(org, "einvoicing"), true, "the earlier one is kept: overrides merge");
  assert.equal(plans.hasFeature(org, "banking"), false, "and the new one applies");
  org = await svc.Org.update(code, { limitOverrides: { branches: null } });
  assert.equal(plans.effectiveLimits(org).branches, null, "null is unlimited");
  assert.equal(plans.effectiveLimits(org).users, 25);
  org = await svc.Org.update(code, { resetFeatures: ["banking"], resetLimits: ["branches"] });
  assert.equal(plans.hasFeature(org, "banking"), true, "back to the plan's setting");
  assert.equal(plans.effectiveLimits(org).branches, 3, "the plan's branch limit returns");
  await assert.rejects(() => svc.Org.update(code, { featureOverrides: { banking: "maybe" } }), /known features/);
});

test("a subscription ends at the end of the chosen day, and extending never shortens what is paid for", { skip }, async () => {
  const code = "dubai-spice-traders";
  let org = await svc.Org.update(code, { subscription: { endsAt: "2027-03-31", graceDays: 14, onExpiry: "readonly" } });
  assert.equal(org.subscription.endsAt.toISOString(), "2027-03-31T23:59:59.999Z", "through the whole last day");
  assert.equal(org.subscription.graceDays, 14);
  assert.equal(org.subscription.onExpiry, "readonly");

  org = await svc.Org.extend(code, { days: 30 });
  assert.equal(org.subscription.endsAt.toISOString().slice(0, 10), "2027-04-30", "added to the current end, which is still ahead");

  await svc.Org.update(code, { subscription: { endsAt: "2020-01-01" } });
  org = await svc.Org.extend(code, { days: 10 });
  const days = (org.subscription.endsAt - Date.now()) / 86400000;
  assert.ok(days > 9 && days < 11.5, `an expired one restarts from today, not from 2020 (${days.toFixed(1)} days ahead)`);
  await assert.rejects(() => svc.Org.extend(code, { days: 0 }), (e) => e.code === "DAYS_INVALID");
  org = await svc.Org.update(code, { subscription: { endsAt: null } });
  assert.equal(org.subscription.endsAt, null, "no end date: never expires");
});

test("extending a suspended organisation brings it back", { skip }, async () => {
  const code = "trial-co";
  await svc.Org.update(code, { status: "suspended" });
  const org = await svc.Org.extend(code, { days: 14 });
  assert.equal(org.status, "trial", "a trial plan returns to trial");
});

test("the developer can correct a customer's company details, for that organisation only", { skip }, async () => {
  const code = "dubai-spice-traders";
  const after = await svc.Org.updateCompanyProfile(code, { trn: "100123456700003", addressLine1: "Al Quoz, Dubai", city: "Dubai", vatRegistered: true });
  assert.equal(after.profile.trn, "100123456700003");
  assert.equal(after.profile.city, "Dubai");
  const other = await inOrg("sharjah-dates-co", () => svc.Settings.findOne({ companyId: "sharjah-dates-co" }).lean());
  assert.notEqual(other.profile?.trn, "100123456700003", "another organisation was not touched");
  await assert.rejects(() => svc.Org.updateCompanyProfile(code, {}), (e) => e.code === "NOTHING_TO_UPDATE");
});

test("the organisation that existed before organisations did is adopted once, with its head office", { skip }, async () => {
  assert.equal(await svc.O.exists({ code: "default" }), null);
  await inOrg("default", () => svc.Settings.create({ companyId: "default", baseCurrency: "AED", profile: { legalName: "Original Co LLC", countryCode: "AE" } }));
  const adopted = await svc.Org.ensureDefault();
  assert.equal(adopted.code, "default");
  assert.equal(adopted.planCode, "internal");
  assert.equal(adopted.legalName, "Original Co LLC", "named from its own company settings");
  assert.equal(adopted.provisioning.complete, true);
  const heads = await inOrg("default", () => svc.B.find({ isHeadOffice: true }).lean());
  assert.equal(heads.length, 1);
  assert.equal(await svc.Org.ensureDefault(), null, "a second call does nothing");
  assert.equal(await svc.B.countDocuments({ companyId: "default" }), 1);
  const plans = require("../../utils/plans");
  assert.equal(plans.hasFeature(adopted, "einvoicing"), true, "the original organisation keeps every feature");
  assert.equal(plans.effectiveLimits(adopted).users, null, "and has no limits");
  assert.equal(plans.subscriptionState(adopted).state, "active");
});

test("organisations can be listed and searched", { skip }, async () => {
  const all = await svc.Org.list({ limit: 100 });
  assert.ok(all.total >= 8);
  assert.deepEqual((await svc.Org.list({ search: "al noor" })).rows.map((o) => o.code), ["al-noor-foods-llc"], "found by its legal name, whatever the case");
  assert.deepEqual((await svc.Org.list({ search: "al-noor" })).rows.map((o) => o.code), ["al-noor-foods-llc"], "and by its code");
  assert.deepEqual((await svc.Org.list({ search: "nobody-has-this-name" })).rows, []);
  assert.equal((await svc.Org.list({ search: "(" })).total, 0, "a stray bracket is searched for, not run as a pattern");
  assert.ok((await svc.Org.list({ status: "suspended" })).rows.every((o) => o.status === "suspended"));
});
