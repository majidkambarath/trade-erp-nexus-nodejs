// Creating and running organisations: the developer's side of the product.
//
// Creating one makes the registry row and its head-office branch together (one transaction), then
// provisions what it needs to transact: company settings, its base-currency master, a fiscal year, the
// tax codes that country uses, and its chart of accounts. Every provisioning step is recorded on the
// organisation, so one that stopped half way is visible and can be run again - each step is idempotent.
const mongoose = require("mongoose");
const Organisation = require("../../models/core/organisationModel");
const Branch = require("../../models/core/branchModel");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const { Currency } = require("../../models/modules/financial/currencyModels");
const FiscalYearService = require("./fiscalYearService");
const TaxCodeService = require("../financial/taxCodeService");
const AccountConfigService = require("../financial/accountConfigService");
const AppError = require("../../utils/AppError");
const { DEFAULT_TENANT, runWithTenant } = require("../../utils/tenantContext");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const plans = require("../../utils/plans");
const currencies = require("../../utils/currencyCatalog");
const { isValidTrn } = require("../../utils/partyMaster");

const HEAD_OFFICE = "main"; // the branchId every existing document already carries
const DEFAULT_CODE = DEFAULT_TENANT.companyId;

const bad = (message, code, details) => new AppError(message, 400, code, details);

// MongoDB refuses a transaction's FIRST write to a collection that was created a moment ago ("Unable to write
// to collection ... due to catalog changes; please retry"). On a brand-new database Mongoose is still
// building these collections' indexes when the first organisation is written, so wait for them to exist
// before opening the transaction, and retry a transient failure rather than failing the first start.
const ready = () => Promise.all([Organisation.init(), Branch.init()]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function retryTransient(fn, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const transient = error?.hasErrorLabel?.("TransientTransactionError") || /due to catalog changes/.test(String(error?.message));
      if (!transient || attempt >= attempts) throw error;
      await sleep(150 * attempt);
    }
  }
}

const validTimezone = (tz) => {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch (_) { return false; }
};

// "Harbour Trading LLC" -> "harbour-trading-llc"
const slug = (name) => String(name || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28).replace(/-+$/g, "");

// Make a typed search safe to use inside a regular expression. The escape character is built, not typed,
// so there is no backslash in this source to get mangled on the way in.
const BACKSLASH = String.fromCharCode(92);
const SPECIAL = ".*+?^${}()|[]" + BACKSLASH;
const escapeRegex = (text) => String(text).split("").map((ch) => (SPECIAL.includes(ch) ? BACKSLASH + ch : ch)).join("");

// Validate and tidy what the developer typed. Everything is checked here so a bad organisation is refused
// with a reason, not half-created.
function clean(input = {}) {
  const out = {};
  out.legalName = String(input.legalName || "").trim();
  if (out.legalName.length < 2) throw bad("The organisation needs a legal name", "LEGAL_NAME_REQUIRED");
  out.tradeName = input.tradeName ? String(input.tradeName).trim() : undefined;

  out.country = String(input.country || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(out.country)) throw bad("Choose the country, as a two-letter code such as AE", "COUNTRY_REQUIRED");

  out.baseCurrency = String(input.baseCurrency || "").trim().toUpperCase();
  if (currencies.isThreeDecimal(out.baseCurrency)) {
    throw bad(`${out.baseCurrency} uses three decimal places, and this system rounds money to two, so its books would be rounded wrong. It is not supported as a base currency yet.`, "CURRENCY_NOT_SUPPORTED");
  }
  if (!currencies.isSupportedBase(out.baseCurrency)) throw bad(`${out.baseCurrency || "That currency"} is not one of the supported base currencies`, "CURRENCY_NOT_SUPPORTED", { supported: Object.keys(currencies.SUPPORTED) });

  out.timezone = String(input.timezone || "").trim();
  if (!validTimezone(out.timezone) || !out.timezone) throw bad("Choose a valid timezone, for example Asia/Dubai", "TIMEZONE_INVALID");

  out.planCode = String(input.planCode || "").trim();
  if (!plans.PLAN_CODES.includes(out.planCode)) throw bad(`Choose a plan: ${plans.PLAN_CODES.join(", ")}`, "PLAN_INVALID");

  if (input.code !== undefined && input.code !== null && String(input.code).trim()) out.code = String(input.code).trim().toLowerCase();
  out.featureOverrides = input.featureOverrides || {};
  out.limitOverrides = input.limitOverrides || {};
  out.notes = input.notes ? String(input.notes).trim() : undefined;

  const sub = input.subscription || {};
  out.graceDays = sub.graceDays === undefined ? 0 : Number(sub.graceDays);
  if (!Number.isInteger(out.graceDays) || out.graceDays < 0 || out.graceDays > 90) throw bad("Grace days must be a whole number from 0 to 90", "GRACE_INVALID");
  out.onExpiry = sub.onExpiry === undefined ? "block" : sub.onExpiry;
  if (!["block", "readonly"].includes(out.onExpiry)) throw bad("What happens at expiry must be block or readonly", "ON_EXPIRY_INVALID");
  out.endsAt = sub.endsAt === undefined ? undefined : sub.endsAt === null ? null : new Date(sub.endsAt);
  if (out.endsAt && Number.isNaN(out.endsAt.getTime())) throw bad("The subscription end date is not a valid date", "ENDS_AT_INVALID");
  out.periodDays = sub.periodDays === undefined ? undefined : Number(sub.periodDays);
  return out;
}

// A date picked in the console means "through the end of that day".
const endOfDay = (d) => (d ? new Date(new Date(d).setUTCHours(23, 59, 59, 999)) : d);

class OrganisationService {
  static HEAD_OFFICE = HEAD_OFFICE;
  static DEFAULT_CODE = DEFAULT_CODE;
  static clean = clean;
  static slug = slug;

  static async uniqueCode(legalName) {
    const base = slug(legalName) || "organisation";
    for (let i = 0; i < 50; i += 1) {
      const candidate = i === 0 ? base : `${base.slice(0, 25)}-${i + 1}`;
      if (!(await Organisation.exists({ code: candidate }))) return candidate;
    }
    throw new AppError("Could not find a free organisation code; choose one", 409, "ORGANISATION_CODE_TAKEN");
  }

  static async get(code) {
    const org = await Organisation.findOne({ code: String(code || "").toLowerCase() });
    if (!org) throw new AppError("That organisation was not found", 404, "ORGANISATION_NOT_FOUND");
    return org;
  }

  static async list({ status, search, page = 1, limit = 25 } = {}) {
    const q = {};
    if (status) q.status = status;
    if (search) {
      const rx = new RegExp(escapeRegex(search), "i");
      q.$or = [{ legalName: rx }, { code: rx }, { tradeName: rx }];
    }
    const [rows, total] = await Promise.all([
      Organisation.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Organisation.countDocuments(q),
    ]);
    return { rows, total, page, limit };
  }

  // Run `fn(code)` once for every organisation that is live, each inside its own scope, so a job that has no
  // request (start-up checks, timers) still knows whose data it is touching. One organisation failing never
  // stops the others: its error is logged and returned.
  static async forEach(fn, { label = "job" } = {}) {
    const orgs = await Organisation.find({ status: { $in: ["trial", "active"] } }).select("code").lean();
    const out = [];
    for (const { code } of orgs) {
      try {
        out.push({ code, result: await runWithTenant({ companyId: code, branchId: HEAD_OFFICE }, () => fn(code)) });
      } catch (error) {
        console.error(`[${label}] ${code}:`, error.message);
        out.push({ code, error: error.message });
      }
    }
    return out;
  }

  // ---- create

  // The developer's "new organisation". Returns { organisation, headOffice, provisioning }.
  static async create(input, { by = null } = {}) {
    const c = clean(input);
    const code = c.code || (await this.uniqueCode(c.legalName));
    if (await Organisation.exists({ code })) throw new AppError("That organisation code is already taken", 409, "ORGANISATION_CODE_TAKEN");

    await ready();
    const startsAt = new Date();
    const endsAt = c.endsAt === undefined ? plans.endsAtFor(c.planCode, startsAt, c.periodDays) : endOfDay(c.endsAt);

    // The registry row and the head office go in together: an organisation with no head office, or a head
    // office with no organisation, must never exist.
    const made = await retryTransient(() => withTransactionSession(async (session) => {
      const [organisation] = await Organisation.create(
        [{
          code, legalName: c.legalName, tradeName: c.tradeName, country: c.country, baseCurrency: c.baseCurrency, timezone: c.timezone,
          status: c.planCode === "trial" ? "trial" : "active", planCode: c.planCode,
          featureOverrides: c.featureOverrides, limitOverrides: c.limitOverrides,
          subscription: { startsAt, endsAt: endsAt || null, graceDays: c.graceDays, onExpiry: c.onExpiry },
          provisioning: {}, createdBy: by, notes: c.notes,
        }],
        { session }
      );
      const [headOffice] = await runWithTenant({ companyId: code, branchId: HEAD_OFFICE }, () =>
        Branch.create([{ companyId: code, code: HEAD_OFFICE, name: "Head Office", isHeadOffice: true, address: { country: c.country }, createdBy: by }], { session })
      );
      return { organisation, headOffice };
    })());

    const provisioning = await this.provision(code);
    return { organisation: await this.get(code), headOffice: made.headOffice, provisioning };
  }

  // The chart of accounts can only be set up for a second organisation once its collection is scoped by
  // the tenant plugin; until then provisioning it would reassign another organisation's accounts. This
  // reads the schema, so the day LedgerAccount is tenanted the same code starts doing the work.
  static chartIsSafeToProvision() {
    return Boolean(mongoose.models.LedgerAccount?.schema.options.tenantScoped);
  }

  // Set up everything an organisation needs to transact. Idempotent: it can be run again to finish what
  // stopped, and a step that already holds its data is left alone. The outcome of each step is stored.
  static async provision(code) {
    const org = await this.get(code);
    const steps = {};
    const run = async (name, fn) => {
      try {
        const result = await fn();
        steps[name] = result && result.state ? result : { state: "done" };
      } catch (error) {
        steps[name] = { state: "failed", error: error.message };
      }
    };

    await runWithTenant({ companyId: org.code, branchId: HEAD_OFFICE }, async () => {
      await run("settings", async () => {
        await AccountConfigService.ensureSettings(org.code); // creates the row with the posting map seeded
        await CompanySettings.updateOne(
          { companyId: org.code },
          { $set: { baseCurrency: org.baseCurrency, "profile.legalName": org.legalName, "profile.countryCode": org.country } }
        );
      });
      await run("currency", async () => {
        const row = currencies.baseCurrencyRow(org.baseCurrency);
        await Currency.updateOne({ companyId: org.code, code: row.code }, { $setOnInsert: row }, { upsert: true });
      });
      await run("fiscalYear", async () => {
        await FiscalYearService.ensureDefault(new Date(), org.code);
      });
      await run("taxCodes", async () => {
        if (org.country !== "AE") return { state: "skipped", reason: `There is no starter tax-code set for ${org.country}; add the tax codes in Accounting setup.` };
        await TaxCodeService.ensureStarter(org.code);
      });
      await run("chart", async () => {
        if (org.code === DEFAULT_CODE) return { state: "done", note: "the original organisation already has its chart" };
        if (!this.chartIsSafeToProvision()) {
          return { state: "pending", reason: "The chart of accounts for a further organisation needs the ledger to be separated by organisation first." };
        }
        const DefaultChartService = require("../financial/defaultChartService");
        await DefaultChartService.onOpen({});
      });
    });

    const complete = Object.values(steps).every((s) => s.state === "done" || s.state === "skipped");
    await Organisation.updateOne({ _id: org._id }, { $set: { provisioning: { steps, complete, at: new Date() } } });
    return { steps, complete };
  }

  // The organisation that existed before organisations did. Idempotent; run at start-up.
  static async ensureDefault() {
    await ready();
    if (await Organisation.exists({ code: DEFAULT_CODE })) return null;
    const settings = await runWithTenant({ companyId: DEFAULT_CODE }, () => CompanySettings.findOne({ companyId: DEFAULT_CODE }).lean());
    // Another server starting at the same moment may adopt it first: that is the same outcome, not a failure.
    const org = await retryTransient(() => withTransactionSession(async (session) => {
      const [organisation] = await Organisation.create(
        [{
          code: DEFAULT_CODE, legalName: settings?.profile?.legalName || "Default organisation", country: settings?.profile?.countryCode || "AE",
          baseCurrency: settings?.baseCurrency || "AED", timezone: "Asia/Dubai", status: "active", planCode: "internal",
          subscription: { startsAt: new Date(), endsAt: null, graceDays: 0, onExpiry: "block" },
          provisioning: { steps: {}, complete: true, at: new Date(), note: "existed before organisations did" },
        }],
        { session }
      );
      await runWithTenant({ companyId: DEFAULT_CODE, branchId: HEAD_OFFICE }, async () => {
        if (!(await Branch.exists({ code: HEAD_OFFICE }))) {
          await Branch.create([{ companyId: DEFAULT_CODE, code: HEAD_OFFICE, name: "Head Office", isHeadOffice: true }], { session });
        }
      });
      return organisation;
    })()).catch((error) => {
      if (error?.code === 11000) return null;
      throw error;
    });
    return org;
  }

  // ---- the developer edits an organisation

  // What cannot change once the books exist: the code (it is stamped on every record), the base currency
  // (the ledger is kept in it) and the country (it decides the tax set and e-invoicing rules).
  static async update(code, patch = {}) {
    const org = await this.get(code);
    const locked = (field, current, message, errorCode) => {
      if (patch[field] !== undefined && String(patch[field]).trim().toUpperCase() !== String(current).toUpperCase()) throw new AppError(message, 409, errorCode);
    };
    locked("code", org.code, "The organisation code cannot be changed: it is stamped on every record", "CODE_LOCKED");
    locked("baseCurrency", org.baseCurrency, "The base currency cannot be changed once the organisation is set up: its ledger is kept in it", "BASE_CURRENCY_LOCKED");
    locked("country", org.country, "The country cannot be changed once the organisation is set up: it decides the tax set", "COUNTRY_LOCKED");

    if (patch.legalName !== undefined) {
      const v = String(patch.legalName).trim();
      if (v.length < 2) throw bad("The organisation needs a legal name", "LEGAL_NAME_REQUIRED");
      org.legalName = v;
    }
    if (patch.tradeName !== undefined) org.tradeName = String(patch.tradeName).trim();
    if (patch.notes !== undefined) org.notes = String(patch.notes).trim();
    if (patch.timezone !== undefined) {
      if (!validTimezone(String(patch.timezone))) throw bad("Choose a valid timezone, for example Asia/Dubai", "TIMEZONE_INVALID");
      org.timezone = String(patch.timezone).trim();
    }
    if (patch.planCode !== undefined) {
      if (!plans.PLAN_CODES.includes(patch.planCode)) throw bad(`Choose a plan: ${plans.PLAN_CODES.join(", ")}`, "PLAN_INVALID");
      org.planCode = patch.planCode;
    }
    if (patch.status !== undefined) {
      if (!["trial", "active", "suspended", "closed"].includes(patch.status)) throw bad("Status must be trial, active, suspended or closed", "STATUS_INVALID");
      org.status = patch.status;
    }

    // Overrides merge into what is there. To remove one (go back to the plan's setting) name it in reset*.
    // They are separate because null is a real limit value: "unlimited".
    const features = { ...(org.featureOverrides || {}), ...(patch.featureOverrides || {}) };
    for (const k of patch.resetFeatures || []) delete features[k];
    const limits = { ...(org.limitOverrides || {}), ...(patch.limitOverrides || {}) };
    for (const k of patch.resetLimits || []) delete limits[k];
    org.featureOverrides = features;
    org.limitOverrides = limits;
    org.markModified("featureOverrides");
    org.markModified("limitOverrides");

    const sub = patch.subscription || {};
    if (sub.endsAt !== undefined) {
      const d = sub.endsAt === null ? null : endOfDay(new Date(sub.endsAt));
      if (d && Number.isNaN(d.getTime())) throw bad("The subscription end date is not a valid date", "ENDS_AT_INVALID");
      org.subscription.endsAt = d;
    }
    if (sub.graceDays !== undefined) org.subscription.graceDays = Number(sub.graceDays);
    if (sub.onExpiry !== undefined) org.subscription.onExpiry = sub.onExpiry;
    if (sub.startsAt !== undefined) org.subscription.startsAt = new Date(sub.startsAt);

    await org.save(); // runs the model's validators on every override and enum
    return org;
  }

  // Add time to a subscription: from its current end if that is still ahead, otherwise from today. A paid
  // renewal must never shorten what the customer already paid for.
  static async extend(code, { days, endsAt } = {}) {
    const org = await this.get(code);
    let next;
    if (endsAt) next = endOfDay(new Date(endsAt));
    else {
      const n = Number(days);
      if (!Number.isInteger(n) || n < 1 || n > 3660) throw bad("Extend by a whole number of days, from 1 to 3660", "DAYS_INVALID");
      const current = org.subscription?.endsAt ? new Date(org.subscription.endsAt) : null;
      const from = current && current > new Date() ? current : new Date();
      next = endOfDay(new Date(from.getTime() + n * 24 * 3600 * 1000));
    }
    if (Number.isNaN(next.getTime())) throw bad("The new end date is not a valid date", "ENDS_AT_INVALID");
    org.subscription.endsAt = next;
    if (org.status === "suspended" || org.status === "trial") org.status = org.planCode === "trial" ? "trial" : "active";
    await org.save();
    return org;
  }

  // The customer's own company details (letterhead, TRN, address), which the developer may correct for them.
  static async updateCompanyProfile(code, profile = {}) {
    const org = await this.get(code);
    const ALLOWED = ["legalName", "trn", "addressLine1", "city", "emirate", "email", "phone"];
    const $set = {};
    for (const k of ALLOWED) if (profile[k] !== undefined) $set[`profile.${k}`] = String(profile[k]).trim();
    if (profile.vatRegistered !== undefined) $set["profile.vatRegistered"] = Boolean(profile.vatRegistered);
    // A UAE tax registration number is exactly 15 digits. Other countries have their own shapes, which are not checked here.
    if (org.country === "AE" && $set["profile.trn"] && !isValidTrn($set["profile.trn"])) throw bad("A UAE TRN is exactly 15 digits", "INVALID_TRN");
    if (!Object.keys($set).length) throw bad("Nothing to change", "NOTHING_TO_UPDATE");
    await runWithTenant({ companyId: org.code, branchId: HEAD_OFFICE }, () => CompanySettings.updateOne({ companyId: org.code }, { $set }));
    return runWithTenant({ companyId: org.code }, () => CompanySettings.findOne({ companyId: org.code }).select("profile baseCurrency").lean());
  }
}

module.exports = OrganisationService;
