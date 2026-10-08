// Plans, optional features, limits and expiry: the rules that make this a controlled SaaS, as plain
// functions with no Mongoose and no request, so the whole table is tested without a server.
//
// What an organisation may use = its plan's defaults, then the developer's per-organisation overrides on
// top. Nothing here reads a clock: `now` is always passed in, so "what happens the day after it expires"
// is a test, not a wait.

// The things that can be switched on or off per organisation. Core trading (sales, purchases, stock,
// ledger, reports) is deliberately NOT listed: an organisation without them has no product.
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
};
const FEATURE_KEYS = Object.keys(FEATURES);

const ALL = Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));
const only = (...keys) => Object.fromEntries(FEATURE_KEYS.map((k) => [k, keys.includes(k)]));

// A limit of null means unlimited.
const PLANS = {
  trial: {
    name: "Trial",
    trialDays: 14,
    features: only("quotations", "deliveryNotes", "batches"),
    limits: { users: 3, branches: 1, documentsPerMonth: 200 },
  },
  standard: {
    name: "Standard",
    features: only("quotations", "deliveryNotes", "batches", "banking", "currencies", "vatReturn", "messaging"),
    limits: { users: 10, branches: 3, documentsPerMonth: 2000 },
  },
  premium: {
    name: "Premium",
    features: ALL,
    limits: { users: 50, branches: 20, documentsPerMonth: 20000 },
  },
  // For the organisation that existed before plans did, and for the developers' own testing.
  internal: {
    name: "Internal",
    features: ALL,
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

// limit -> number | null (unlimited). An override of null means "unlimited for this organisation".
function effectiveLimits(org) {
  const plan = planOf(org);
  const overrides = org?.limitOverrides || {};
  return Object.fromEntries(LIMIT_KEYS.map((k) => [k, limitOf(plan, overrides, k)]));
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

module.exports = {
  FEATURES, FEATURE_KEYS, PLANS, PLAN_CODES, LIMIT_KEYS,
  effectiveFeatures, hasFeature, effectiveLimits, checkLimit, subscriptionState, endsAtFor,
};
