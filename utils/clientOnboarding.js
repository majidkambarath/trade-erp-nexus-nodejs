// The new-client onboarding form: what a client fills in, at a private link, before their organisation is made.
// Pure: no database, no request. The service (services/platform/clientOnboardingService.js) stores what this cleans and
// refuses a submit this finds incomplete; the browser has a twin (trade erp/src/lib/clientOnboarding.js) that says the same
// things before anything is sent, but the server is the authority.
//
// Two different jobs, kept apart on purpose:
//   - normaliseAnswers: what may be STORED. Generous: a draft is half typed, so a malformed email is kept as typed (the
//     client fixes it later), but anything that is not text is dropped, every text is cut to its length, and a list or
//     choice outside its set is dropped. Nothing the client sends reaches the database except through here.
//   - issuesOf: what stops a SUBMIT. Strict, and phrased for the client.
const { EMIRATES } = require("./partyAddress");
const { isStateCode, stateCodeOfGstin } = require("./gstStates");
const { normalizeIban, isValidIban } = require("./iban");
const { normalizeTrn, isValidTrn, taxIdRule } = require("./partyMaster");

// What the client may ask for. Not the console's module keys: these are the parts of the product in the client's own
// words, and the console turns them into modules and features (trade erp/src/lib/clientOnboarding.js draftFromOnboarding).
const MODULE_CHOICES = ["sales", "purchase", "inventory", "accounts", "banking", "crm", "vansales", "garage", "hr", "production", "einvoicing", "currencies"];
// The ready-made roles a client may give their other people (never the Owner: that is the first administrator).
const ROLE_CHOICES = ["admin", "manager", "accountant", "sales", "purchase", "storekeeper", "operator", "viewer", "van_salesman"];
const BUSINESS_TYPES = ["trading", "distribution", "retail", "manufacturing", "services", "workshop", "other"];
const SELLS = ["goods", "services", "both"];

const SHEETS = [".csv", ".xlsx", ".xls"];
const DOCS = [".pdf", ".png", ".jpg", ".jpeg"];
// Each upload slot and what it accepts. The bytes are checked too (AttachmentService.validate), not only the ending.
const FILE_KINDS = {
  customers: [...SHEETS],
  vendors: [...SHEETS],
  items: [...SHEETS],
  trialBalance: [...SHEETS, ".pdf"],
  openInvoices: [...SHEETS, ".pdf"],
  openBills: [...SHEETS, ".pdf"],
  openingStock: [...SHEETS, ".pdf"],
  tradeLicence: [...DOCS],
  taxCertificate: [...DOCS],
  logo: [".png", ".jpg", ".jpeg", ".webp"],
  other: [...SHEETS, ...DOCS, ".docx", ".doc"],
};

const LIMITS = { users: 50, branches: 20, files: 15, fileBytes: 5 * 1024 * 1024, totalBytes: 25 * 1024 * 1024 };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[\d\s()-]{7,20}$/;
const WEBSITE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i;
const SWIFT = /^[A-Z0-9]{8}([A-Z0-9]{3})?$/;

// ---- cleaning

// Text, and only text: a number becomes its digits, anything else (an object, a list, a boolean) is nothing. String() on
// an object is "[object Object]", and an object with its own toString can throw.
const text = (value, max) => {
  if (typeof value === "string") return value.trim().slice(0, max);
  if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, max);
  return "";
};
const choice = (value, allowed) => {
  const v = text(value, 40).toLowerCase();
  return allowed.includes(v) ? v : "";
};
const whole = (value, max = 10_000_000) => {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
};
const isDay = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};
const day = (value) => {
  const v = text(value, 10);
  return isDay(v) ? v : "";
};
const objectOf = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const listOf = (value, max) => (Array.isArray(value) ? value.slice(0, max) : []);

const emirateOf = (value) => {
  const v = text(value, 50).toLowerCase();
  return EMIRATES.find((e) => e.toLowerCase() === v) || "";
};
const stateOf = (value) => {
  const v = text(value, 4);
  const padded = /^\d{1,2}$/.test(v) ? v.padStart(2, "0") : v;
  return isStateCode(padded) ? padded : "";
};

/** The answers as they may be stored: known keys only, every value its own type and length. */
function normaliseAnswers(input) {
  const a = objectOf(input);
  const c = objectOf(a.company);
  const b = objectOf(a.business);
  const p = objectOf(a.people);
  const admin = objectOf(p.admin);
  const g = objectOf(a.goLive);
  const country = text(c.country, 2).toUpperCase();
  const company = {
    legalName: text(c.legalName, 100),
    tradeName: text(c.tradeName, 100),
    legalNameArabic: text(c.legalNameArabic, 100),
    country: /^[A-Z]{2}$/.test(country) ? country : "",
    emirate: emirateOf(c.emirate),
    stateCode: stateOf(c.stateCode),
    addressLine1: text(c.addressLine1, 100),
    addressLine2: text(c.addressLine2, 100),
    city: text(c.city, 50),
    postalCode: text(c.postalCode, 20),
    phone: text(c.phone, 25),
    email: text(c.email, 254).toLowerCase(),
    website: text(c.website, 200),
    taxRegistered: choice(c.taxRegistered, ["yes", "no"]),
    taxNumber: text(c.taxNumber, 20),
    taxRegisteredFrom: day(c.taxRegisteredFrom),
    bankName: text(c.bankName, 100),
    bankAccountName: text(c.bankAccountName, 100),
    bankAccountNumber: text(c.bankAccountNumber, 50),
    iban: text(c.iban, 42),
    swift: text(c.swift, 14),
    bankBranch: text(c.bankBranch, 100),
  };
  const fy = whole(b.fiscalYearStart, 12);
  // judged whole, never cut first: "dirham" cut to three letters would be stored as a currency called DIR
  const currency = text(b.baseCurrency, 10);
  const business = {
    baseCurrency: /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : "",
    fiscalYearStart: fy && fy >= 1 ? fy : null,
    businessType: choice(b.businessType, BUSINESS_TYPES),
    sells: choice(b.sells, SELLS),
    modules: [...new Set(listOf(b.modules, MODULE_CHOICES.length * 2).map((m) => choice(m, MODULE_CHOICES)).filter(Boolean))],
    branches: listOf(b.branches, LIMITS.branches).map((r) => ({ name: text(objectOf(r).name, 80), city: text(objectOf(r).city, 50) })),
    previousSoftware: text(b.previousSoftware, 100),
    notes: text(b.notes, 1000),
  };
  const people = {
    admin: { name: text(admin.name, 80), email: text(admin.email, 254).toLowerCase(), mobile: text(admin.mobile, 25), jobTitle: text(admin.jobTitle, 80) },
    users: listOf(p.users, LIMITS.users).map((r) => {
      const u = objectOf(r);
      return { name: text(u.name, 80), email: text(u.email, 254).toLowerCase(), mobile: text(u.mobile, 25), role: choice(u.role, ROLE_CHOICES) };
    }),
  };
  const goLive = {
    goLiveDate: day(g.goLiveDate),
    customersCount: whole(g.customersCount),
    vendorsCount: whole(g.vendorsCount),
    itemsCount: whole(g.itemsCount),
    notes: text(g.notes, 1000),
  };
  return { company, business, people, goLive };
}

// ---- what stops a submit

/**
 * [{ section, field, message }] for everything still missing or wrong. Empty means the form can be sent.
 * `currencies` (optional) is the list of currency codes the books can be kept in; without it any three letters pass.
 */
function issuesOf(input, { currencies = null } = {}) {
  const a = normaliseAnswers(input);
  const out = [];
  const add = (section, field, message) => out.push({ section, field, message });
  const { company: c, business: b, people: p, goLive: g } = a;

  if (c.legalName.length < 2) add("company", "legalName", "Enter the company's legal name, as on the trade licence");
  if (!c.country) add("company", "country", "Choose the country the company is registered in");
  if (c.country === "AE" && !c.emirate) add("company", "emirate", "Choose the emirate");
  if (c.country === "IN" && !c.stateCode) add("company", "stateCode", "Choose the state the company is registered in");
  if (!c.addressLine1) add("company", "addressLine1", "Enter the company's address");
  if (!c.city) add("company", "city", "Enter the city");
  if (!PHONE.test(c.phone)) add("company", "phone", c.phone ? "That phone number does not look right" : "Enter the company's phone number");
  if (!EMAIL.test(c.email)) add("company", "email", c.email ? "That email address does not look right" : "Enter the company's email address");
  if (c.website && !WEBSITE.test(c.website)) add("company", "website", "That website address does not look right");
  if (!c.taxRegistered) add("company", "taxRegistered", "Say whether the company is registered for tax");
  if (c.taxRegistered === "yes") {
    const rule = taxIdRule(c.country || "AE");
    if (!c.taxNumber) add("company", "taxNumber", `Enter the company's ${rule.label}`);
    else if (!isValidTrn(normalizeTrn(c.taxNumber), c.country || "AE")) add("company", "taxNumber", rule.message);
    if (!c.taxRegisteredFrom) add("company", "taxRegisteredFrom", "Enter the date the registration started");
  }
  if (c.iban && !isValidIban(normalizeIban(c.iban))) add("company", "iban", "That IBAN does not pass its check digits. Please check it.");
  if (c.swift && !SWIFT.test(c.swift.replace(/\s+/g, "").toUpperCase())) add("company", "swift", "A SWIFT / BIC code is 8 or 11 letters and digits");

  if (!b.baseCurrency) add("business", "baseCurrency", "Choose the currency the books are kept in");
  else if (Array.isArray(currencies) && !currencies.includes(b.baseCurrency)) add("business", "baseCurrency", "Choose one of the listed currencies");
  if (!b.fiscalYearStart) add("business", "fiscalYearStart", "Choose the month the financial year starts");
  if (!b.sells) add("business", "sells", "Say whether the company sells goods, services or both");
  if (!b.modules.length) add("business", "modules", "Choose at least one part of the system you need");
  b.branches.forEach((r, i) => {
    if (!r.name) add("business", `branches.${i}.name`, `Branch ${i + 1} needs a name`);
  });

  if (!p.admin.name) add("people", "admin.name", "Enter the name of the person who will run the system");
  if (!EMAIL.test(p.admin.email)) add("people", "admin.email", p.admin.email ? "That email address does not look right" : "Enter their email address: they sign in with it");
  if (!PHONE.test(p.admin.mobile)) add("people", "admin.mobile", p.admin.mobile ? "That mobile number does not look right" : "Enter their mobile number");
  const seen = new Set([p.admin.email].filter(Boolean));
  p.users.forEach((u, i) => {
    const n = i + 1;
    if (!u.name) add("people", `users.${i}.name`, `Person ${n} needs a name`);
    if (!EMAIL.test(u.email)) add("people", `users.${i}.email`, u.email ? `Person ${n}'s email address does not look right` : `Person ${n} needs an email address`);
    else if (seen.has(u.email)) add("people", `users.${i}.email`, `Person ${n}'s email is already used above: each person signs in with their own`);
    if (u.email) seen.add(u.email);
    if (!u.role) add("people", `users.${i}.role`, `Choose what person ${n} will do`);
    if (u.role === "van_salesman" && !b.modules.includes("vansales")) add("people", `users.${i}.role`, `Person ${n} is a van salesman: add Van sales to the parts you need, or choose another role`);
  });

  if (!g.goLiveDate) add("goLive", "goLiveDate", "Choose the day you want to start using the system");
  return out;
}

// ---- how far along the client is (for the console's list)

/** { filled, total, percent }: the required answers given, whether or not each is yet right. */
function progressOf(input) {
  const a = normaliseAnswers(input);
  const { company: c, business: b, people: p, goLive: g } = a;
  const checks = [c.legalName, c.country, c.addressLine1, c.city, c.phone, c.email, c.taxRegistered, b.baseCurrency, b.fiscalYearStart, b.sells, b.modules.length, p.admin.name, p.admin.email, p.admin.mobile, g.goLiveDate];
  if (c.country === "AE") checks.push(c.emirate);
  if (c.country === "IN") checks.push(c.stateCode);
  if (c.taxRegistered === "yes") checks.push(c.taxNumber, c.taxRegisteredFrom);
  const filled = checks.filter(Boolean).length;
  return { filled, total: checks.length, percent: Math.round((filled / checks.length) * 100) };
}

// ---- what is applied to the organisation once it is made

/** The letterhead, in CompanyProfileService.update's shape (it checks each field again). */
function toProfilePatch(input) {
  const { company: c, business: b } = normaliseAnswers(input);
  const patch = {};
  const put = (key, value) => {
    if (value) patch[key] = value;
  };
  put("companyName", c.legalName);
  put("companyNameArabic", c.legalNameArabic);
  put("addressLine1", c.addressLine1);
  put("addressLine2", c.addressLine2);
  put("city", c.city);
  if (c.country === "AE") put("state", c.emirate);
  put("postalCode", c.postalCode);
  put("phoneNumber", c.phone);
  put("emailAddress", c.email);
  put("website", c.website);
  const bank = {};
  if (c.bankName) bank.bankName = c.bankName;
  if (c.bankAccountName) bank.accountName = c.bankAccountName;
  if (c.bankAccountNumber) bank.accountNumber = c.bankAccountNumber;
  if (c.iban) bank.ibanNumber = c.iban;
  if (c.swift) bank.swiftCode = c.swift.replace(/\s+/g, "").toUpperCase();
  if (Object.keys(bank).length) {
    if (b.baseCurrency) bank.currency = b.baseCurrency;
    patch.bankDetails = bank;
  }
  if (c.bankBranch) patch.branch = c.bankBranch;
  return patch;
}

/** The tax identity and the year's first month, in AccountConfigService.updateSettings' shape, or null when nothing to say. */
function toSettingsPatch(input) {
  const { company: c, business: b } = normaliseAnswers(input);
  const profile = {};
  if (c.country === "IN") {
    const fromGstin = c.taxRegistered === "yes" ? stateCodeOfGstin(normalizeTrn(c.taxNumber)) : null;
    if (c.stateCode || fromGstin) profile.stateCode = c.stateCode || fromGstin;
  }
  if (c.country === "AE" && c.emirate) profile.emirate = c.emirate;
  if (c.taxRegistered === "no") profile.vatRegistered = false;
  if (c.taxRegistered === "yes" && c.taxNumber) {
    profile.trn = normalizeTrn(c.taxNumber);
    profile.vatRegistered = true;
    if (c.taxRegisteredFrom) profile.vatRegisteredFrom = c.taxRegisteredFrom;
  }
  const out = {};
  if (Object.keys(profile).length) out.profile = profile;
  if (b.fiscalYearStart) out.fiscalYearStartMonth = b.fiscalYearStart;
  return Object.keys(out).length ? out : null;
}

/** May this file go in this slot? -> the ending, lower-case, or null. Shape only: the bytes are checked by the caller. */
function fileAllowed(kind, name) {
  const allowed = FILE_KINDS[kind];
  if (!allowed) return null;
  const m = /\.[A-Za-z0-9]{1,5}$/.exec(String(name || ""));
  const ext = m ? m[0].toLowerCase() : "";
  return allowed.includes(ext) ? ext : null;
}

module.exports = {
  MODULE_CHOICES,
  ROLE_CHOICES,
  BUSINESS_TYPES,
  SELLS,
  FILE_KINDS,
  LIMITS,
  normaliseAnswers,
  issuesOf,
  progressOf,
  toProfilePatch,
  toSettingsPatch,
  fileAllowed,
  isDay,
};
