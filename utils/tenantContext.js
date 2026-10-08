// Which organisation a piece of code is working for, carried ALONGSIDE the call instead of being passed
// down it. Node's AsyncLocalStorage keeps one value per request that follows every `await`, timer and
// promise chain started inside it, so a service three layers below the route knows its organisation
// without anyone threading `req` through. That is the point: there are dozens of services with no request
// in scope, and a scope that depends on every one of them remembering a parameter is a data leak waiting
// for the first one that forgets.
//
// It FAILS CLOSED. Reading the scope when there is none is an error, not a quiet default - a query that
// escapes its scope must crash a test, never return another customer's rows.
//
// One exception, named so it can be found and removed: TENANT_LEGACY_DEFAULT=1 makes "no scope" mean "the
// single default organisation". It is OFF by default, so the running server fails closed. It exists for the
// older test suites, which exercise services directly as one company and have no request to open a scope:
// utils/testSetup.js (loaded by npm test) switches it on for them.
const { AsyncLocalStorage } = require("async_hooks");

const DEFAULT_TENANT = Object.freeze({
  companyId: process.env.COMPANY_ID || "default",
  branchId: process.env.BRANCH_ID || "main",
});

const store = new AsyncLocalStorage();

class TenantScopeError extends Error {
  constructor(message, code = "TENANT_SCOPE") {
    super(message);
    this.name = "TenantScopeError";
    this.code = code;
    this.statusCode = 500; // never the client's fault, never an "operational" message to show them
    this.isOperational = false;
  }
}

const legacyDefaultEnabled = () => /^(1|true|on|yes)$/i.test(String(process.env.TENANT_LEGACY_DEFAULT ?? "").trim());

// A Mongoose query (or aggregate) is LAZY: it does not run until something awaits it. A callback that
// returns one, as in runWithTenant(t, () => Model.find()), would hand back the un-run query and the scope
// would be gone by the time it executed - a query with no organisation, or worse, the wrong one. So a
// returned query is run here, inside the scope. (An async callback that awaits its own queries is
// unaffected; this only rescues the one-liner.)
const settle = (result) =>
  result && typeof result.exec === "function" && typeof result.then === "function" ? result.exec() : result;

const clean = (tenant) => {
  const companyId = typeof tenant?.companyId === "string" ? tenant.companyId.trim() : "";
  if (!companyId) throw new TenantScopeError("A tenant scope needs a companyId", "TENANT_INVALID");
  const branchId = typeof tenant.branchId === "string" && tenant.branchId.trim() ? tenant.branchId.trim() : DEFAULT_TENANT.branchId;
  return Object.freeze({ companyId, branchId });
};

// Run `fn` for one organisation. Everything it starts - awaited or not - inherits the scope.
const runWithTenant = (tenant, fn) => store.run({ tenant: clean(tenant), unscoped: false }, () => settle(fn()));

// The loud escape hatch: run `fn` with NO organisation filter. It exists for the few jobs that really
// span organisations (the developer console, a migration, the public link reader, which finds its row by
// a secret and reads the organisation FROM the row). Every use names its reason, and the uses are counted
// so a review can see exactly where the protection is deliberately off.
const unscopedUses = new Map();
const runUnscoped = (reason, fn) => {
  if (typeof reason !== "string" || reason.trim().length < 8) {
    throw new TenantScopeError("runUnscoped needs a reason of at least a few words, so a review can judge it", "UNSCOPED_NEEDS_REASON");
  }
  unscopedUses.set(reason, (unscopedUses.get(reason) || 0) + 1);
  return store.run({ tenant: null, unscoped: true, reason }, () => settle(fn()));
};
const unscopedStats = () => Object.fromEntries(unscopedUses);

const currentScope = () => store.getStore();
const isUnscoped = () => Boolean(store.getStore()?.unscoped);
const ambientTenant = () => store.getStore()?.tenant || null;

// What a QUERY or WRITE on a tenanted model should be limited to.
//   null          -> deliberately unscoped, do not filter
//   { companyId } -> filter and stamp with this
//   throws        -> there is no scope and the default is switched off
const tenantForQuery = () => {
  const scope = store.getStore();
  if (scope?.unscoped) return null;
  if (scope?.tenant) return scope.tenant;
  if (legacyDefaultEnabled()) return DEFAULT_TENANT;
  throw new TenantScopeError(
    "No organisation is in scope. A query on tenanted data must run inside runWithTenant() (a signed-in request does this) or, for a job that truly spans organisations, runUnscoped(reason, fn). (Running a test file directly? Use npm test, or set TENANT_LEGACY_DEFAULT=1.)",
    "NO_TENANT_SCOPE"
  );
};

module.exports = {
  DEFAULT_TENANT, TenantScopeError, runWithTenant, runUnscoped, unscopedStats,
  currentScope, isUnscoped, ambientTenant, tenantForQuery, legacyDefaultEnabled,
};
