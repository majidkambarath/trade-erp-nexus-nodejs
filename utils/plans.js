// Plans, optional features, limits and expiry: the rules that make this a controlled SaaS, as plain
// functions with no Mongoose and no request, so the whole table is tested without a server.
//
// What an organisation may use = its plan's defaults, then the developer's per-organisation overrides on
// top. Nothing here reads a clock: `now` is always passed in, so "what happens the day after it expires"
// is a test, not a wait.

// The person-level catalogue: which modules the product has and what each can do. An organisation is sold
// modules; a role inside it is given actions. Both are written in the same names so they can be compared.
const perms = require("./permissions");

// The optional add-ons that can be switched on or off per organisation. These are the EXTRAS; which whole
// modules an organisation has bought is the separate table below (MODULES), because a feature switched off
// hides one screen while a module switched off is a part of the product the customer did not buy.
const FEATURES = {
  quotations: { label: "Quotations", paths: ["/quotations"] },
  deliveryNotes: { label: "Delivery notes", paths: ["/delivery-notes"] },
  batches: { label: "Batches and expiry", paths: ["/batches"] },
  banking: { label: "Banks, cards and cheques", paths: ["/banking"] },
  reconciliation: { label: "Bank and card reconciliation", paths: ["/banking/reconciliation"] },
  currencies: { label: "Foreign currency", paths: ["/currencies"] },
  vatReturn: { label: "VAT return", paths: ["/vat-return"] },
  ifrsStatements: { label: "IFRS statements", paths: ["/ifrs"] },
  einvoicing: { label: "E-invoicing", paths: ["/einvoice"] },
  messaging: { label: "Send documents to customers", paths: ["/messaging"] },
  multiBranch: { label: "More than one branch", paths: [] },
  // Opt-in: in NO plan, not even "all features". Off is the normal state; the developer switches it on for an
  // organisation that makes products (a feature override), and only then does Inventory > Production exist.
  production: { label: "Production (materials and expenses into a product's cost)", paths: ["/productions"], optIn: true },
  // Deliberately NOT opt-in: it exists to cut OUR support load, so switching it off for a client
  // works against us. A per-organisation override is the kill switch for one client, not the way
  // it is sold. Every plan gets it, trial included.
  assistant: { label: "Zarvia AI assistant", paths: ["/assistant"] },
};
const FEATURE_KEYS = Object.keys(FEATURES);

// every feature but the opt-in ones, which an organisation only ever gets by an override
const ALL = Object.fromEntries(FEATURE_KEYS.map((k) => [k, !FEATURES[k].optIn]));
const only = (...keys) => Object.fromEntries(FEATURE_KEYS.map((k) => [k, keys.includes(k)]));

// ---- modules: the parts of the product an organisation has bought ------------------------------------------
//
// A module is one of the product's own modules, named exactly as a role is written (utils/permissions.js
// MODULES), so a plan reads the way the sidebar does. Its value says what the organisation holds there:
//   true             every action the module has
//   false            nothing: the screens are not offered and the API refuses with MODULE_NOT_IN_PLAN
//   ["view", ...]    only those actions - a module sold in part (Reports without the financial statements)
//
// This is NOT a permission. It is the CEILING that every role in the organisation is capped to, so not even
// its owner can hold what was never sold (the built-in Owner and Administrator roles are all permissions, in
// code). A person's own role then decides what they may do inside that ceiling, as it always did.
const MODULE_KEYS = perms.MODULE_KEYS;
const MODULE_ACTIONS = Object.fromEntries(MODULE_KEYS.map((m) => [m, Object.keys(perms.MODULES[m].actions)]));

// On whatever a plan or an override says: the pick lists every form fills itself from, the company settings
// printed on every document, and the dashboard the app lands on after signing in. Without these an
// organisation could be sold a product that cannot open a form, print a document or show a first screen.
const ALWAYS_ON = ["lookups.view", "settings.view", "reports.view"];

const ALL_MODULES = Object.fromEntries(MODULE_KEYS.map((m) => [m, true]));
/** Every module but the ones named, which are off; `detail` sells one in part ({ reports: ["view"] }). */
const modulesExcept = (off = [], detail = {}) => ({
  ...ALL_MODULES,
  ...Object.fromEntries(off.map((m) => [m, false])),
  ...detail,
});

/** Only the modules named are on; every other is off. `detail` sells one in part. For a plan that is one product, not the whole. */
const modulesOnly = (on = [], detail = {}) => ({
  ...Object.fromEntries(MODULE_KEYS.map((m) => [m, false])),
  ...Object.fromEntries(on.map((m) => [m, true])),
  ...detail,
});

// A limit of null means unlimited.
const PLANS = {
  trial: {
    name: "Trial",
    trialDays: 14,
    features: only("quotations", "deliveryNotes", "batches", "assistant"),
    modules: ALL_MODULES,
    limits: { users: 3, branches: 1, documentsPerMonth: 200 },
  },
  // CRM is the one module a plan has to be bought up to: the trade documents and the books are the product, the
  // pipeline in front of them is what Premium adds. An organisation on Standard that wants it gets a module override.
  standard: {
    name: "Standard",
    features: only("quotations", "deliveryNotes", "batches", "banking", "currencies", "vatReturn", "messaging", "assistant"),
    modules: modulesExcept(["crm"]),
    limits: { users: 10, branches: 3, documentsPerMonth: 2000 },
  },
  premium: {
    name: "Premium",
    features: ALL,
    modules: ALL_MODULES,
    limits: { users: 50, branches: 20, documentsPerMonth: 20000 },
  },
  // Buying and selling, with the stock behind it, and no books: the documents still post to the ledger (they
  // must, or stock has no cost and an invoice no entry) - this customer simply did not buy the screens that
  // read it. Add the modules back one at a time for a customer who grows into them.
  trading: {
    name: "Trade only",
    features: only("quotations", "deliveryNotes", "batches", "messaging", "assistant"),
    modules: modulesExcept(["finance", "banking", "accounts", "audit", "crm"], { reports: ["view"] }),
    limits: { users: 10, branches: 2, documentsPerMonth: 2000 },
  },
  // The CRM and nothing else: leads, deals, contacts, follow-ups, calendar and reports, plus the two things any organisation
  // needs to run it - its own people (users) and its own settings. No trade documents, no stock, no books.
  //
  // This is a WEAKER product than the CRM inside the ERP, and is sold as one: the pipeline in front of the paperwork moves
  // itself from quotations and invoices (utils/crm.js EVENTS), and an organisation with neither moves its deals by hand. The
  // automation is the reason to add the ERP. `documentsPerMonth: 0` says the plan holds no trade documents; moving up to a
  // plan that does is a change of plan, not a module override.
  crm: {
    name: "CRM only",
    features: only(),
    modules: modulesOnly(["crm", "users", "settings"], { reports: ["view"] }),
    limits: { users: 10, branches: 1, documentsPerMonth: 0 },
  },
  // For the organisation that existed before plans did, and for the developers' own testing.
  internal: {
    name: "Internal",
    features: ALL,
    modules: ALL_MODULES,
    limits: { users: null, branches: null, documentsPerMonth: null },
  },
};
const PLAN_CODES = Object.keys(PLANS);
const LIMIT_KEYS = ["users", "branches", "documentsPerMonth"];

const planOf = (org) => PLANS[org?.planCode] || null;

// One limit. null is a real answer (unlimited) and must not be mistaken for "not set": an unknown plan has no
// limits at all, which means none are allowed, and an override of null lifts the limit for one organisation.
function limitOf(plan, overrides, key) {
  if (Object.prototype.hasOwnProperty.call(overrides, key) && overrides[key] !== undefined) return overrides[key];
  if (!plan) return 0;
  return plan.limits[key] === undefined ? 0 : plan.limits[key];
}

// feature -> boolean for EVERY known feature. An unknown plan allows nothing: failing open on a typo in
// a plan code would hand out the whole product.
function effectiveFeatures(org) {
  const plan = planOf(org);
  const overrides = org?.featureOverrides || {};
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, typeof overrides[k] === "boolean" ? overrides[k] : Boolean(plan?.features?.[k])]));
}

const hasFeature = (org, key) => {
  if (!(key in FEATURES)) throw new Error(`Unknown feature "${key}"`); // a typo in a guard must crash, not allow
  return effectiveFeatures(org)[key];
};

// ---- modules: what one organisation holds

// The actions an organisation holds in one module: the plan's value, the organisation's own override on top,
// and then the floor (ALWAYS_ON). An unknown plan, a missing value or an override that is not a boolean or a
// list of that module's own actions holds NOTHING but the floor: failing open on a typo would hand out a part
// of the product nobody paid for. Read with hasOwnProperty, so a name every object inherits is not an override.
function moduleActions(org, key) {
  if (!MODULE_KEYS.includes(key)) throw new Error(`Unknown module "${key}"`);
  const plan = planOf(org);
  const overrides = org?.moduleOverrides;
  const own = overrides && typeof overrides === "object" && Object.prototype.hasOwnProperty.call(overrides, key) ? overrides[key] : undefined;
  const chosen = own === undefined ? plan?.modules?.[key] : own;
  const all = MODULE_ACTIONS[key];
  const granted = chosen === true ? all : Array.isArray(chosen) ? all.filter((a) => chosen.includes(a)) : [];
  const floor = ALWAYS_ON.filter((k) => k.startsWith(`${key}.`)).map((k) => k.slice(key.length + 1));
  return [...new Set([...granted, ...floor])].sort();
}

/** module -> { on, full, actions } for EVERY known module: what the console draws and the status sends. */
function effectiveModules(org) {
  return Object.fromEntries(
    MODULE_KEYS.map((m) => {
      const actions = moduleActions(org, m);
      return [m, { on: actions.length > 0, full: actions.length === MODULE_ACTIONS[m].length, actions }];
    })
  );
}

/** The ceiling as permission keys ("sales.approve"), sorted: what every role in the organisation is capped to. */
function entitledKeys(org) {
  return MODULE_KEYS.flatMap((m) => moduleActions(org, m).map((a) => `${m}.${a}`)).sort();
}

/** Does the organisation hold this one permission key at all? (It decides WHICH refusal a route gives.) */
function moduleAllows(org, key) {
  const name = String(key ?? "");
  const dot = name.indexOf(".");
  if (dot < 1) return false;
  const module = name.slice(0, dot);
  if (!MODULE_KEYS.includes(module)) return false;
  return moduleActions(org, module).includes(name.slice(dot + 1));
}

/** Why a per-organisation module override cannot be stored, or null when it can. Used by the model and the console. */
function moduleOverrideError(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Module overrides must be an object";
  for (const [key, v] of Object.entries(value)) {
    if (!MODULE_KEYS.includes(key)) return `Not a known module: ${key}`;
    if (typeof v === "boolean") continue;
    if (!Array.isArray(v) || v.some((a) => typeof a !== "string" || !MODULE_ACTIONS[key].includes(a))) {
      return `"${key}" must be true, false, or a list of its own actions (${MODULE_ACTIONS[key].join(", ")})`;
    }
  }
  return null;
}

// limit -> number | null (unlimited). An override of null means "unlimited for this organisation".
function effectiveLimits(org) {
  const plan = planOf(org);
  const overrides = org?.limitOverrides || {};
  const limits = Object.fromEntries(LIMIT_KEYS.map((k) => [k, limitOf(plan, overrides, k)]));
  // A limit must never offer room that a feature gate then refuses. BranchService.create asks for the
  // multiBranch feature BEFORE it asks for room, so without that feature the only branch an organisation can
  // ever have is the head office - whatever number the plan prints. The standard plan said three, so the
  // console showed two branches free while the API answered FEATURE_NOT_IN_PLAN. The feature decides; give a
  // client branches by switching multiBranch on for them and the plan's number applies again.
  if (!effectiveFeatures(org).multiBranch) {
    // narrowing only: unlimited becomes the head office alone, and an unknown plan (which allows nothing) stays 0
    limits.branches = limits.branches === null ? 1 : Math.min(limits.branches, 1);
  }
  return limits;
}

// How a limit reads when someone tries to use more: { ok, limit, used, remaining }.
function checkLimit(org, key, used, adding = 1) {
  if (!LIMIT_KEYS.includes(key)) throw new Error(`Unknown limit "${key}"`);
  const limit = effectiveLimits(org)[key];
  if (limit === null) return { ok: true, limit: null, used, remaining: null };
  return { ok: used + adding <= limit, limit, used, remaining: Math.max(limit - used, 0) };
}

const DAY = 24 * 3600 * 1000;

// Where an organisation stands against its subscription, at `now`.
//   state     active | grace | expired | suspended | closed
//   canRead   may sign in and look at its records
//   canWrite  may create and change records
//   blocked   may not use the system at all (it is shown an explanation instead)
function subscriptionState(org, now = new Date()) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  const sub = org?.subscription || {};
  const base = { endsAt: sub.endsAt || null, onExpiry: sub.onExpiry === "readonly" ? "readonly" : "block" };

  if (org?.status === "closed") return { ...base, state: "closed", canRead: false, canWrite: false, blocked: true, reason: "This organisation has been closed." };
  if (org?.status === "suspended") return { ...base, state: "suspended", canRead: false, canWrite: false, blocked: true, reason: "This organisation has been suspended." };
  if (!sub.endsAt) return { ...base, state: "active", canRead: true, canWrite: true, blocked: false, daysLeft: null };

  const ends = new Date(sub.endsAt).getTime();
  const graceEnds = ends + Math.max(Number(sub.graceDays) || 0, 0) * DAY;
  if (t <= ends) return { ...base, state: "active", canRead: true, canWrite: true, blocked: false, daysLeft: Math.ceil((ends - t) / DAY) };
  if (t <= graceEnds) return { ...base, state: "grace", canRead: true, canWrite: true, blocked: false, graceEndsAt: new Date(graceEnds), daysLeft: Math.ceil((graceEnds - t) / DAY) };

  const reason = `The subscription ended on ${new Date(ends).toISOString().slice(0, 10)}.`;
  if (base.onExpiry === "readonly") return { ...base, state: "expired", canRead: true, canWrite: false, blocked: false, reason };
  return { ...base, state: "expired", canRead: false, canWrite: false, blocked: true, reason };
}

// The end of a new subscription from a plan: a trial runs its trial days; a paid plan runs the period given.
function endsAtFor(planCode, startsAt, periodDays) {
  const plan = PLANS[planCode];
  const days = plan?.trialDays ?? periodDays;
  if (!days) return null;
  return new Date(new Date(startsAt).getTime() + days * DAY);
}

// The instant a calendar month began on the wall clock of `timezone`, which is where "this month" has to be
// counted: a document made at 01:00 on the 1st in Dubai belongs to the new month although it is still the 30th in UTC.
function monthStartIn(timezone, now = new Date()) {
  const zone = timezone || "UTC";
  const wall = (instant) => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(instant));
    const get = (type) => Number(p.find((x) => x.type === type).value);
    return { year: get("year"), month: get("month"), ms: Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) };
  };
  let here;
  try {
    here = wall(now instanceof Date ? now.getTime() : Number(now));
  } catch (_) {
    return monthStartIn("UTC", now); // an unknown zone name counts in UTC rather than refusing to count
  }
  // The wall clock reads the 1st at 00:00 at the instant guess - (zone offset then). The offset is read at the
  // guess and again at the answer, so a month that begins just after a clock change still lands on the right instant.
  const guess = Date.UTC(here.year, here.month - 1, 1);
  let t = guess - (wall(guess).ms - guess);
  t = guess - (wall(t).ms - t);
  return new Date(t);
}

module.exports = {
  FEATURES, FEATURE_KEYS, PLANS, PLAN_CODES, LIMIT_KEYS,
  MODULE_KEYS, MODULE_ACTIONS, ALWAYS_ON,
  effectiveFeatures, hasFeature, effectiveLimits, checkLimit, subscriptionState, endsAtFor, monthStartIn,
  moduleActions, effectiveModules, entitledKeys, moduleAllows, moduleOverrideError,
};
