// What a request may do at each point of a subscription: pure, so "the day after it ended" is an assertion.
const test = require("node:test");
const assert = require("node:assert/strict");
const gate = require("../subscriptionGate");

const E = (s) => new Date(`${s}T23:59:59.999Z`);
const D = (s) => new Date(`${s}T12:00:00Z`);
const org = (over = {}) => ({ code: "acme", legalName: "Acme Trading LLC", planCode: "standard", status: "active", subscription: { endsAt: E("2026-10-10"), graceDays: 0, onExpiry: "block" }, ...over });

test("while the subscription runs, everything is allowed", () => {
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) assert.equal(gate.requestRefusal(org(), method, D("2026-10-10")), null, method);
  assert.equal(gate.signInRefusal(org(), D("2026-10-10")), null);
  assert.equal(gate.requestRefusal(org({ subscription: {} }), "POST", D("2030-01-01")), null, "no end date: it does not expire");
});

test("the day after it ends, a blocked organisation is refused with the date and the reason", () => {
  const e = gate.requestRefusal(org(), "GET", D("2026-10-11"));
  assert.equal(e.statusCode, 403);
  assert.equal(e.code, "ORGANISATION_EXPIRED");
  assert.equal(e.details.state, "expired");
  assert.equal(new Date(e.details.endsAt).toISOString().slice(0, 10), "2026-10-10");
  assert.match(e.message, /ended on 2026-10-10/);
  assert.equal(gate.signInRefusal(org(), D("2026-10-11")).code, "ORGANISATION_EXPIRED", "and it cannot sign in either");
});

test("the grace period keeps everything working, and then it ends", () => {
  const graced = org({ subscription: { endsAt: E("2026-10-10"), graceDays: 3, onExpiry: "block" } });
  assert.equal(gate.requestRefusal(graced, "POST", D("2026-10-12")), null);
  assert.equal(gate.requestRefusal(graced, "POST", D("2026-10-14")).code, "ORGANISATION_EXPIRED");
});

test("a read-only organisation can read and sign in but cannot change anything", () => {
  const ro = org({ subscription: { endsAt: E("2026-10-10"), graceDays: 0, onExpiry: "readonly" } });
  const after = D("2026-10-11");
  for (const method of ["GET", "HEAD", "OPTIONS"]) assert.equal(gate.requestRefusal(ro, method, after), null, method);
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
    const e = gate.requestRefusal(ro, method, after);
    assert.equal(e.code, "ORGANISATION_READ_ONLY", method);
    assert.equal(e.statusCode, 403);
    assert.equal(e.details.onExpiry, "readonly");
  }
  assert.equal(gate.signInRefusal(ro, after), null, "it may sign in to look at its records");
});

test("suspended and closed organisations are refused whatever the dates say", () => {
  const s = gate.requestRefusal(org({ status: "suspended" }), "GET", D("2026-10-01"));
  assert.equal(s.code, "ORGANISATION_SUSPENDED");
  assert.equal(gate.requestRefusal(org({ status: "closed" }), "GET", D("2026-10-01")).code, "ORGANISATION_CLOSED");
  assert.equal(gate.signInRefusal(org({ status: "suspended" }), D("2026-10-01")).code, "ORGANISATION_SUSPENDED");
  const ro = org({ status: "suspended", subscription: { endsAt: E("2026-12-31"), onExpiry: "readonly" } });
  assert.equal(gate.requestRefusal(ro, "GET", D("2026-10-01")).code, "ORGANISATION_SUSPENDED", "read-only is for an expired subscription, not a suspension");
});

test("the refusal names who to contact only when the operator has said so", () => {
  const saved = [process.env.SUPPORT_CONTACT, process.env.SUPPORT_EMAIL];
  try {
    delete process.env.SUPPORT_CONTACT; delete process.env.SUPPORT_EMAIL;
    const none = gate.requestRefusal(org(), "GET", D("2026-10-11"));
    assert.equal(none.details.contact, null);
    assert.doesNotMatch(none.message, /\(/);
    process.env.SUPPORT_CONTACT = "help@zarvia.example";
    const named = gate.requestRefusal(org(), "GET", D("2026-10-11"));
    assert.equal(named.details.contact, "help@zarvia.example");
    assert.match(named.message, /help@zarvia\.example/);
  } finally {
    if (saved[0] === undefined) delete process.env.SUPPORT_CONTACT; else process.env.SUPPORT_CONTACT = saved[0];
    if (saved[1] === undefined) delete process.env.SUPPORT_EMAIL; else process.env.SUPPORT_EMAIL = saved[1];
  }
});

test("a warning goes out in the grace period and in the last fortnight, and not before", () => {
  assert.deepEqual(gate.warningHeaders(org(), D("2026-09-01")), {}, "plenty of time: no header");
  const soon = gate.warningHeaders(org(), D("2026-10-05"));
  assert.equal(soon["X-Subscription-State"], "active");
  assert.equal(soon["X-Subscription-Days-Left"], "6");
  assert.equal(new Date(soon["X-Subscription-Ends"]).toISOString().slice(0, 10), "2026-10-10");
  const graced = gate.warningHeaders(org({ subscription: { endsAt: E("2026-10-10"), graceDays: 5, onExpiry: "block" } }), D("2026-10-12"));
  assert.equal(graced["X-Subscription-State"], "grace");
  assert.deepEqual(gate.warningHeaders(org({ subscription: {} }), D("2026-10-12")), {}, "no end date: never a warning");
});
