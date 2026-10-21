// Plans, optional features, limits and expiry: pure, so the whole table runs with no server or database
// and "what happens the day after it expires" is an assertion rather than a wait.
const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../plans");

const D = (s) => new Date(`${s}T12:00:00Z`);
// A subscription ends at the END of its last day, which is how a date picked in the console is stored.
const E = (s) => new Date(`${s}T23:59:59.999Z`);
const org = (over = {}) => ({ planCode: "standard", status: "active", subscription: { endsAt: E("2026-12-31"), graceDays: 0, onExpiry: "block" }, ...over });

test("every plan answers for every feature, and an unknown plan allows nothing", () => {
  for (const code of p.PLAN_CODES) {
    const f = p.effectiveFeatures({ planCode: code });
    assert.deepEqual(Object.keys(f).sort(), [...p.FEATURE_KEYS].sort(), code);
    assert.ok(Object.values(f).every((v) => typeof v === "boolean"));
  }
  const none = p.effectiveFeatures({ planCode: "typo" });
  assert.ok(Object.values(none).every((v) => v === false), "a mistyped plan code must not open the whole product");
  assert.ok(Object.values(p.effectiveFeatures(null)).every((v) => v === false));
});

test("a plan sets the defaults and the developer's per-organisation switch wins either way", () => {
  assert.equal(p.hasFeature({ planCode: "standard" }, "einvoicing"), false, "not in the plan");
  assert.equal(p.hasFeature({ planCode: "standard", featureOverrides: { einvoicing: true } }, "einvoicing"), true, "switched on for this one");
  assert.equal(p.hasFeature({ planCode: "standard" }, "banking"), true, "in the plan");
  assert.equal(p.hasFeature({ planCode: "standard", featureOverrides: { banking: false } }, "banking"), false, "switched off for this one");
  assert.equal(p.hasFeature({ planCode: "premium", featureOverrides: { banking: "yes" } }, "banking"), true, "an override that is not a real boolean is ignored");
});

test("asking about a feature that does not exist crashes, because a typo in a guard must never allow", () => {
  assert.throws(() => p.hasFeature({ planCode: "premium" }, "einvoicng"), /Unknown feature/);
});

test("limits come from the plan, an override replaces one, and null means unlimited", () => {
  assert.deepEqual(p.effectiveLimits({ planCode: "trial" }), { users: 3, branches: 1, documentsPerMonth: 200 });
  assert.equal(p.effectiveLimits({ planCode: "trial", limitOverrides: { users: 8 } }).users, 8);
  assert.equal(p.effectiveLimits({ planCode: "trial", limitOverrides: { users: 8 } }).branches, 1, "the others stay");
  assert.equal(p.effectiveLimits({ planCode: "trial", limitOverrides: { users: null } }).users, null, "an override of null is unlimited");
  assert.deepEqual(p.effectiveLimits({ planCode: "internal" }), { users: null, branches: null, documentsPerMonth: null });
  assert.deepEqual(p.effectiveLimits({ planCode: "typo" }), { users: 0, branches: 0, documentsPerMonth: 0 }, "an unknown plan allows none");
});

test("a limit is checked against what is already used", () => {
  const trial = { planCode: "trial" };
  assert.deepEqual(p.checkLimit(trial, "users", 2), { ok: true, limit: 3, used: 2, remaining: 1 });
  assert.equal(p.checkLimit(trial, "users", 3).ok, false, "the fourth user is refused");
  assert.equal(p.checkLimit(trial, "users", 1, 2).ok, true, "adding two to one is three");
  assert.equal(p.checkLimit(trial, "users", 2, 2).ok, false);
  assert.equal(p.checkLimit({ planCode: "internal" }, "users", 99999).ok, true);
  assert.throws(() => p.checkLimit(trial, "seats", 1), /Unknown limit/);
});

test("a subscription is active until its end date, then grace, then it expires", () => {
  const o = org({ subscription: { endsAt: E("2026-12-31"), graceDays: 7, onExpiry: "block" } });
  const at = (day) => p.subscriptionState(o, D(day));
  assert.equal(at("2026-10-08").state, "active");
  assert.equal(at("2026-12-31").state, "active", "the last day still counts");
  assert.equal(at("2027-01-01").state, "grace");
  assert.equal(at("2027-01-01").canWrite, true, "grace still works, so a late payment is not an outage");
  assert.equal(at("2027-01-07").state, "grace");
  assert.equal(at("2027-01-08").state, "expired");
});

test("after expiry the default is BLOCKED: no reading, no writing, and a reason to show", () => {
  const s = p.subscriptionState(org({ subscription: { endsAt: E("2026-12-31"), graceDays: 0 } }), D("2027-01-02"));
  assert.equal(s.state, "expired");
  assert.equal(s.blocked, true);
  assert.equal(s.canRead, false);
  assert.equal(s.canWrite, false);
  assert.match(s.reason, /ended on 2026-12-31/);
});

test("an organisation set to read-only keeps its records readable after expiry but cannot post", () => {
  const s = p.subscriptionState(org({ subscription: { endsAt: E("2026-12-31"), graceDays: 0, onExpiry: "readonly" } }), D("2027-03-01"));
  assert.equal(s.state, "expired");
  assert.equal(s.blocked, false);
  assert.equal(s.canRead, true, "a client is not locked out of its own tax records");
  assert.equal(s.canWrite, false);
});

test("suspended and closed organisations are blocked whatever the dates say", () => {
  for (const status of ["suspended", "closed"]) {
    const s = p.subscriptionState(org({ status, subscription: { endsAt: E("2030-01-01") } }), D("2026-10-08"));
    assert.equal(s.state, status);
    assert.equal(s.blocked, true);
    assert.equal(s.canWrite, false);
  }
});

test("no end date means no expiry", () => {
  const s = p.subscriptionState({ planCode: "internal", status: "active", subscription: {} }, D("2099-01-01"));
  assert.equal(s.state, "active");
  assert.equal(s.daysLeft, null);
  assert.equal(s.canWrite, true);
});

test("days left is counted up, so the last day reads one and never zero", () => {
  const o = org({ subscription: { endsAt: E("2026-10-10") } });
  // it ends at the end of the 10th, so on the 8th there are three days left: the 8th, 9th and 10th
  assert.equal(p.subscriptionState(o, D("2026-10-08")).daysLeft, 3);
  assert.equal(p.subscriptionState(o, D("2026-10-09")).daysLeft, 2);
  assert.equal(p.subscriptionState(o, D("2026-10-10")).daysLeft, 1, "the last day reads one, never zero");
});

test("a trial plan ends after its trial days; a paid plan after the period it is given", () => {
  const start = D("2026-10-08");
  assert.equal(p.endsAtFor("trial", start).toISOString().slice(0, 10), "2026-10-22");
  assert.equal(p.endsAtFor("standard", start, 365).toISOString().slice(0, 10), "2027-10-08");
  assert.equal(p.endsAtFor("internal", start), null, "no period given, no end");
});

// A plan that prints room a feature gate then refuses is a plan that lies: BranchService.create asks for the
// multiBranch feature before it asks for room, so the console showed "2 of 3 branches free" on the standard
// plan while the API answered FEATURE_NOT_IN_PLAN for every one of them.
test("the branches limit is 1 whenever multiBranch is off, whatever the plan or the override says", () => {
  const limits = (org) => p.effectiveLimits(org);
  assert.equal(p.effectiveFeatures({ planCode: "standard" }).multiBranch, false);
  assert.equal(limits({ planCode: "standard" }).branches, 1, "standard has no multiBranch, so only the head office");
  assert.equal(limits({ planCode: "trial" }).branches, 1);

  // an override cannot buy room the feature does not allow
  assert.equal(limits({ planCode: "standard", limitOverrides: { branches: 5 } }).branches, 1);
  assert.equal(limits({ planCode: "standard", limitOverrides: { branches: null } }).branches, 1, "not even unlimited");

  // switch the feature on and the plan's own number applies again
  assert.equal(limits({ planCode: "standard", featureOverrides: { multiBranch: true } }).branches, 3);
  assert.equal(limits({ planCode: "standard", featureOverrides: { multiBranch: true }, limitOverrides: { branches: 5 } }).branches, 5);

  // the plans that do include it are untouched
  assert.equal(limits({ planCode: "premium" }).branches, 20);
  assert.equal(limits({ planCode: "internal" }).branches, null, "unlimited");

  // and what checkLimit answers follows it, since that is what the refusal is built from
  assert.equal(limits({ planCode: "typo" }).branches, 0, "an unknown plan still allows nothing: the clamp narrows, never widens");

  // and what checkLimit answers follows it, since that is what the refusal is built from
  assert.deepEqual(p.checkLimit({ planCode: "standard" }, "branches", 1), { ok: false, limit: 1, used: 1, remaining: 0 });
});

test("'this month' is counted on the organisation's own calendar, not UTC's", () => {
  // 01:00 on 1 October in Dubai is still 21:00 on 30 September in UTC, and belongs to October.
  assert.equal(p.monthStartIn("Asia/Dubai", new Date("2026-09-30T21:00:00Z")).toISOString(), "2026-09-30T20:00:00.000Z");
  assert.equal(p.monthStartIn("Asia/Dubai", new Date("2026-10-15T10:00:00Z")).toISOString(), "2026-09-30T20:00:00.000Z");
  // ...and 23:30 on 30 September in Dubai is 19:30Z, still September.
  assert.equal(p.monthStartIn("Asia/Dubai", new Date("2026-09-30T19:30:00Z")).toISOString(), "2026-08-31T20:00:00.000Z");
  assert.equal(p.monthStartIn("UTC", new Date("2026-10-15T10:00:00Z")).toISOString(), "2026-10-01T00:00:00.000Z");
  // a zone with daylight saving: the offset in force on the 1st, not the one in force today
  assert.equal(p.monthStartIn("America/New_York", new Date("2026-03-20T10:00:00Z")).toISOString(), "2026-03-01T05:00:00.000Z");
  assert.equal(p.monthStartIn("America/New_York", new Date("2026-04-02T10:00:00Z")).toISOString(), "2026-04-01T04:00:00.000Z");
  // no zone, or a zone name that does not exist, counts in UTC rather than failing
  assert.equal(p.monthStartIn(undefined, new Date("2026-10-15T10:00:00Z")).toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(p.monthStartIn("Not/AZone", new Date("2026-10-15T10:00:00Z")).toISOString(), "2026-10-01T00:00:00.000Z");
});

// ---- modules: the parts of the product an organisation was sold ----------------------------------------------

test("a module is the organisation's ceiling: the plan's set, its own overrides, and a floor nothing can remove", () => {
  const perms = require("../permissions");
  const actionsOf = (org, m) => p.moduleActions(org, m);

  // every full plan holds every module whole
  for (const code of ["trial", "premium", "internal"]) {
    const org = { planCode: code };
    for (const m of p.MODULE_KEYS) assert.deepEqual(actionsOf(org, m), [...p.MODULE_ACTIONS[m]].sort(), `${code} holds all of ${m}`);
    assert.deepEqual(p.entitledKeys(org), perms.KEYS.slice().sort(), `${code} holds every permission key`);
  }

  // Standard is everything the trade and the books need, and CRM is the one module it does not include: it is sold
  // up to Premium, or switched on for one organisation with a module override.
  const standard = { planCode: "standard" };
  assert.deepEqual(actionsOf(standard, "crm"), [], "Standard does not include CRM");
  for (const m of p.MODULE_KEYS.filter((x) => x !== "crm")) assert.deepEqual(actionsOf(standard, m), [...p.MODULE_ACTIONS[m]].sort(), `standard holds all of ${m}`);
  assert.deepEqual(p.entitledKeys(standard), perms.KEYS.filter((k) => !k.startsWith("crm.")).sort(), "standard holds every key but CRM's");
  assert.deepEqual(actionsOf({ planCode: "standard", moduleOverrides: { crm: true } }, "crm"), [...p.MODULE_ACTIONS.crm].sort(), "and an override sells it");

  // the trade-only plan: no books, and Reports only as far as looking
  const trade = { planCode: "trading" };
  assert.deepEqual(actionsOf(trade, "finance"), []);
  assert.deepEqual(actionsOf(trade, "accounts"), []);
  assert.deepEqual(actionsOf(trade, "banking"), []);
  assert.deepEqual(actionsOf(trade, "crm"), []);
  assert.deepEqual(actionsOf(trade, "reports"), ["view"], "it may look, not read the statements");
  assert.deepEqual(actionsOf(trade, "sales"), [...p.MODULE_ACTIONS.sales].sort());
  assert.equal(p.moduleAllows(trade, "reports.financial"), false);
  assert.equal(p.moduleAllows(trade, "reports.view"), true);
  assert.equal(p.moduleAllows(trade, "finance.create"), false);

  // the floor: the pick lists a form fills itself from, the settings printed on a document, the first screen
  const nothing = { planCode: "trading", moduleOverrides: Object.fromEntries(p.MODULE_KEYS.map((m) => [m, false])) };
  // named here, not read from ALWAYS_ON: the point is WHICH three, and comparing the list to itself proves nothing
  const FLOOR = ["lookups.view", "reports.view", "settings.view"];
  assert.deepEqual(p.entitledKeys(nothing), FLOOR, "everything switched off still leaves the pick lists, the settings and the first screen");
  for (const key of FLOOR) assert.equal(p.moduleAllows(nothing, key), true, `${key} cannot be switched off`);
  assert.deepEqual([...p.ALWAYS_ON].sort(), FLOOR, "and the floor is exactly those three");

  // an override wins over the plan, both ways, and may sell a module in part
  assert.deepEqual(actionsOf({ planCode: "trading", moduleOverrides: { finance: true } }, "finance"), [...p.MODULE_ACTIONS.finance].sort());
  assert.deepEqual(actionsOf({ planCode: "premium", moduleOverrides: { finance: ["view", "create"] } }, "finance"), ["create", "view"]);
  assert.deepEqual(actionsOf({ planCode: "premium", moduleOverrides: { audit: false } }, "audit"), []);

  // an unknown plan, a junk override and a name every object inherits all hold NOTHING beyond the floor
  assert.deepEqual(p.entitledKeys({ planCode: "typo" }), [...p.ALWAYS_ON].sort());
  assert.deepEqual(actionsOf({ planCode: "premium", moduleOverrides: { sales: "yes" } }, "sales"), [], "a value that is not true, false or a list grants nothing");
  assert.deepEqual(actionsOf({ planCode: "premium", moduleOverrides: { sales: ["approve", "fly"] } }, "sales"), ["approve"], "an action the module does not have is dropped");
  assert.deepEqual(actionsOf({ planCode: "trading", moduleOverrides: Object.create({ finance: true }) }, "finance"), [], "an inherited name is not this organisation's override");
  assert.throws(() => actionsOf({ planCode: "premium" }, "nonsense"), /Unknown module/);

  // effectiveModules is what the console and the status read
  const shown = p.effectiveModules(trade);
  assert.deepEqual(shown.finance, { on: false, full: false, actions: [] });
  assert.deepEqual(shown.reports, { on: true, full: false, actions: ["view"] });
  assert.equal(shown.sales.full, true);
});

test("a module override is refused unless it is true, false or a list of that module's own actions", () => {
  assert.equal(p.moduleOverrideError({}), null);
  assert.equal(p.moduleOverrideError({ finance: false, reports: ["view", "financial"] }), null);
  assert.match(p.moduleOverrideError({ ledger: true }), /Not a known module: ledger/);
  assert.match(p.moduleOverrideError({ reports: ["view", "bogus"] }), /must be true, false, or a list/);
  assert.match(p.moduleOverrideError({ sales: "on" }), /must be true, false, or a list/);
  assert.match(p.moduleOverrideError({ sales: [1] }), /must be true, false, or a list/);
  assert.match(p.moduleOverrideError(null), /must be an object/);
  assert.match(p.moduleOverrideError([]), /must be an object/);
});

test("the ceiling caps a role, and not even the owner escapes it", () => {
  const perms = require("../permissions");
  const owner = perms.grantsOf(perms.resolveRole("super_admin"));
  const trade = { planCode: "trading" };

  const capped = perms.capTo(owner, p.entitledKeys(trade));
  assert.equal(capped.includes("sales.approve"), true, "what was sold is untouched");
  assert.equal(capped.includes("finance.create"), false, "what was not sold is gone, although the role holds it");
  assert.equal(capped.includes("accounts.manage"), false);
  assert.equal(capped.includes("reports.financial"), false, "a module sold in part is capped at the action");
  assert.equal(capped.includes("reports.view"), true);
  assert.equal(capped.includes("lookups.view"), true, "the pick lists survive, so every form still opens");
  assert.ok(capped.every((k) => owner.includes(k)), "a ceiling can only take away");

  // an implication cannot smuggle a module in: a sales approver in an organisation without Inventory does not
  // receive inventory.view (the item pick lists it needs are reached with lookups.view)
  const noStock = { planCode: "premium", moduleOverrides: { inventory: false } };
  const seller = perms.capTo(perms.expand(["sales.approve"]), p.entitledKeys(noStock));
  assert.equal(seller.includes("sales.approve"), true);
  assert.equal(seller.includes("inventory.view"), false);
  assert.equal(seller.includes("lookups.view"), true);

  // no ceiling supplied caps nothing; an empty one is a real ceiling and leaves nothing
  assert.deepEqual(perms.capTo(owner, null), owner);
  assert.deepEqual(perms.capTo(owner, undefined), owner);
  assert.deepEqual(perms.capTo(owner, []), []);
  assert.deepEqual(perms.capTo(owner, new Set(["sales.view"])), ["sales.view"], "a Set is taken as it is");
});

test("the role editor is drawn without what the organisation cannot hold", () => {
  const perms = require("../permissions");
  const whole = perms.catalogue();
  const trade = perms.catalogue(p.entitledKeys({ planCode: "trading" }));
  assert.ok(whole.some((m) => m.key === "finance"));
  assert.equal(trade.some((m) => m.key === "finance"), false, "a module with no action left is not drawn at all");
  assert.deepEqual(trade.find((m) => m.key === "reports").actions.map((a) => a.action), ["view"]);
  assert.deepEqual(whole.find((m) => m.key === "reports").actions.map((a) => a.action), ["view", "financial", "vat"]);
  assert.deepEqual(perms.catalogue(null), whole, "no ceiling is the whole catalogue, as it was before modules");
});

// ---- the CRM-only plan -------------------------------------------------------------------------------------------

test("the CRM-only plan sells the CRM, its own people and its own settings - and not one trade module", () => {
  const crmOnly = { planCode: "crm" };
  const m = p.effectiveModules(crmOnly);
  for (const on of ["crm", "users", "settings"]) assert.equal(m[on].full, true, `${on} is sold whole`);
  assert.deepEqual(m.reports.actions, ["view"], "the dashboard the app lands on, and nothing of the statements");
  assert.deepEqual(m.lookups.actions, ["view"], "the pick lists every form fills itself from");
  for (const off of ["sales", "purchase", "inventory", "finance", "banking", "accounts", "staff", "audit"]) {
    assert.equal(m[off].on, false, `${off} was never sold, and not even the owner can hold it`);
  }
});

test("a CRM-only organisation can add customers through the CRM but holds no Sales key to do it with", () => {
  const crmOnly = { planCode: "crm" };
  assert.equal(p.moduleAllows(crmOnly, "sales.create"), false);
  assert.equal(p.moduleAllows(crmOnly, "crm.create"), true);
  assert.equal(p.moduleAllows(crmOnly, "users.manage"), true, "its owner can add the colleagues who will use it");
  assert.equal(p.moduleAllows(crmOnly, "finance.view"), false);
  assert.equal(p.moduleAllows(crmOnly, "crm.manage"), true);
  assert.ok(!p.entitledKeys(crmOnly).some((k) => /^(sales|purchase|inventory|finance|banking|accounts)\./.test(k)), "the ceiling lists no trade key");
});

test("the CRM-only plan holds no trade documents and no optional feature, and one branch", () => {
  assert.deepEqual(p.effectiveLimits({ planCode: "crm" }), { users: 10, branches: 1, documentsPerMonth: 0 });
  // No add-on the customer BUYS comes with it. The assistant is the one exception, and it is not an
  // add-on: it answers how the product works and exists to cut our own support load, so the plan a
  // customer is on has no bearing on it. It is on for every plan, this one included.
  const crmFeatures = p.effectiveFeatures({ planCode: "crm" });
  assert.ok(Object.entries(crmFeatures).every(([k, v]) => v === false || k === "assistant"), "no add-on comes with it");
  assert.equal(crmFeatures.assistant, true, "a CRM-only client still gets help with the product");
  assert.equal(p.checkLimit({ planCode: "crm" }, "documentsPerMonth", 0).ok, false, "the first trade document is refused");
});

test("the plans that already existed still answer exactly as they did", () => {
  // The CRM-only plan was added beside them; none of these may have moved.
  assert.equal(p.effectiveModules({ planCode: "standard" }).crm.on, false);
  assert.equal(p.effectiveModules({ planCode: "trading" }).crm.on, false);
  assert.equal(p.effectiveModules({ planCode: "premium" }).crm.full, true);
  assert.equal(p.effectiveModules({ planCode: "premium" }).sales.full, true);
  assert.equal(p.effectiveModules({ planCode: "standard" }).sales.full, true);
  assert.deepEqual(p.PLAN_CODES, ["trial", "standard", "premium", "trading", "crm", "internal"]);
});

test("the developer can add a module to a CRM-only organisation, and its plan does not change", () => {
  const withSales = { planCode: "crm", moduleOverrides: { sales: ["view", "create"] } };
  assert.equal(p.moduleAllows(withSales, "sales.create"), true);
  assert.equal(p.moduleAllows(withSales, "sales.approve"), false, "only the actions that were sold");
  assert.equal(p.moduleAllows({ planCode: "crm" }, "sales.create"), false, "and another organisation on the plan is untouched");
});
