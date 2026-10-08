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
