// Who may approve a document, and how many people must: a table of cases with no server and no database.
const test = require("node:test");
const assert = require("node:assert/strict");
const r = require("../approvalRules");
const p = require("../permissions");

const ME = { id: "u-me", limit: null };
const BOSS = { id: "u-boss", limit: null };
const CLERK = { id: "u-clerk", limit: 5000 };
const none = { separateApprover: false, secondApprovalAbove: null };

test("nothing set: anyone who may approve may approve anything, and one approval is final", () => {
  for (const amount of [0, 1, 999999.99]) {
    assert.deepEqual(r.decide({ policy: none, amount, preparedBy: "u-me", approver: ME }), { ok: true, final: true, step: 1, of: 1 });
  }
  assert.deepEqual(r.decide({ policy: undefined, amount: 10, preparedBy: "x", approver: ME }), { ok: true, final: true, step: 1, of: 1 }, "no policy at all reads as none");
});

test("a role's limit: at the limit is fine, a fils over is not, and no limit means no ceiling", () => {
  assert.equal(r.decide({ policy: none, amount: 5000, preparedBy: "x", approver: CLERK }).ok, true);
  const over = r.decide({ policy: none, amount: 5000.01, preparedBy: "x", approver: CLERK, currency: "AED" });
  assert.equal(over.ok, false);
  assert.equal(over.code, "APPROVAL_LIMIT_EXCEEDED");
  assert.deepEqual(over.details, { amount: 5000.01, limit: 5000 });
  assert.match(over.message, /5000\.01 AED/);
  assert.match(over.message, /limit is 5000\.00 AED/);
  assert.equal(r.decide({ policy: none, amount: 5e9, preparedBy: "x", approver: BOSS }).ok, true);
  assert.equal(r.decide({ policy: none, amount: 100, preparedBy: "x", approver: { id: "z", limit: 0 } }).ok, false, "a limit of 0 approves nothing");
  assert.equal(r.decide({ policy: none, amount: 0, preparedBy: "x", approver: { id: "z", limit: 0 } }).ok, true);
});

test("a limit that is not a number is read as no limit rather than as zero", () => {
  for (const junk of [undefined, null, "", "abc", -5, NaN]) assert.equal(r.limitOf(junk), null, String(junk));
  assert.equal(r.limitOf("2500.5"), 2500.5);
  assert.equal(r.limitOf("2500.554"), 2500.55, "kept to the fils");
  assert.equal(r.limitOf(0), 0);
});

test("the separate approver: whoever prepared a document may not approve it, anyone else may", () => {
  const policy = { ...none, separateApprover: true };
  const own = r.decide({ policy, amount: 10, preparedBy: "u-me", approver: ME });
  assert.equal(own.ok, false);
  assert.equal(own.code, "SELF_APPROVAL_NOT_ALLOWED");
  assert.equal(r.decide({ policy, amount: 10, preparedBy: "u-me", approver: BOSS }).ok, true);
  assert.equal(r.decide({ policy: none, amount: 10, preparedBy: "u-me", approver: ME }).ok, true, "and only when the organisation asks for it");
  assert.equal(r.decide({ policy, amount: 10, preparedBy: "system", approver: ME }).ok, true, "a document made by the system has no preparer to exclude");
  assert.equal(r.decide({ policy, amount: 10, preparedBy: undefined, approver: ME }).ok, true);
  assert.equal(r.decide({ policy, amount: 10, preparedBy: { toString: () => "u-me" }, approver: ME }).ok, false, "an ObjectId and its string are the same person");
});

test("a second approver above an amount: the first approval is recorded and not final; a different person finishes it", () => {
  const policy = { ...none, secondApprovalAbove: 10000 };
  assert.deepEqual(r.decide({ policy, amount: 10000, preparedBy: "x", approver: ME }), { ok: true, final: true, step: 1, of: 1 }, "exactly the amount is not above it");
  assert.deepEqual(r.decide({ policy, amount: 10000.01, preparedBy: "x", approver: ME }), { ok: true, final: false, step: 1, of: 2 });
  const second = r.decide({ policy, amount: 10000.01, preparedBy: "x", approver: BOSS, approvals: [{ by: "u-me" }] });
  assert.deepEqual(second, { ok: true, final: true, step: 2, of: 2 });
  const same = r.decide({ policy, amount: 20000, preparedBy: "x", approver: ME, approvals: [{ by: "u-me" }] });
  assert.equal(same.ok, false);
  assert.equal(same.code, "SECOND_APPROVER_REQUIRED");
  assert.equal(r.decide({ policy: { ...none, secondApprovalAbove: 0 }, amount: 0.01, preparedBy: "x", approver: ME }).final, false, "0 means two people for anything");
  assert.equal(r.decide({ policy: { ...none, secondApprovalAbove: 0 }, amount: 0, preparedBy: "x", approver: ME }).final, true, "but nothing is above 0 when the document is worth nothing");
});

test("limits are checked before anything is recorded, and each approver is judged on their own", () => {
  const policy = { ...none, secondApprovalAbove: 1000 };
  const tooBig = r.decide({ policy, amount: 8000, preparedBy: "x", approver: CLERK });
  assert.equal(tooBig.ok, false);
  assert.equal(tooBig.code, "APPROVAL_LIMIT_EXCEEDED", "8000 is over the clerk's 5000, so there is no first approval to record");
  const small = r.decide({ policy, amount: 3000, preparedBy: "x", approver: CLERK });
  assert.deepEqual([small.ok, small.final, small.step], [true, false, 1]);
  assert.equal(r.decide({ policy, amount: 3000, preparedBy: "x", approver: BOSS, approvals: [{ by: "u-clerk" }] }).final, true);
});

test("the separate approver and the second approver together: the preparer is out, and the two must differ", () => {
  const policy = { separateApprover: true, secondApprovalAbove: 100 };
  assert.equal(r.decide({ policy, amount: 500, preparedBy: "u-me", approver: ME }).code, "SELF_APPROVAL_NOT_ALLOWED", "refused before the second-approver question arises");
  const a = r.decide({ policy, amount: 500, preparedBy: "u-me", approver: { id: "a" } });
  assert.deepEqual([a.ok, a.final], [true, false]);
  assert.equal(r.decide({ policy, amount: 500, preparedBy: "u-me", approver: { id: "a" }, approvals: [{ by: "a" }] }).code, "SECOND_APPROVER_REQUIRED");
  assert.equal(r.decide({ policy, amount: 500, preparedBy: "u-me", approver: { id: "b" }, approvals: [{ by: "a" }] }).final, true);
  assert.equal(r.decide({ policy, amount: 500, preparedBy: "u-me", approver: ME, approvals: [{ by: "a" }] }).code, "SELF_APPROVAL_NOT_ALLOWED", "the preparer cannot be the second one either");
});

test("raising the threshold after a first approval lets that approval stand as the only one needed", () => {
  const d = r.decide({ policy: { ...none, secondApprovalAbove: 50000 }, amount: 20000, preparedBy: "x", approver: BOSS, approvals: [{ by: "u-me" }] });
  assert.deepEqual([d.ok, d.final], [true, true]);
});

test("the policy as stored is read safely, whatever was saved", () => {
  assert.deepEqual(r.normalisePolicy(undefined), none);
  assert.deepEqual(r.normalisePolicy({ separateApprover: "true", secondApprovalAbove: "abc" }), none, "only a real true switches it on; junk is never");
  assert.deepEqual(r.normalisePolicy({ separateApprover: true, secondApprovalAbove: "2500.5" }), { separateApprover: true, secondApprovalAbove: 2500.5 });
  assert.deepEqual(r.normalisePolicy({ secondApprovalAbove: -1 }), none, "a negative threshold is no threshold");
  assert.equal(r.needsSecondApproval({ secondApprovalAbove: 10 }, 10.01), true);
  assert.equal(r.needsSecondApproval({ secondApprovalAbove: 10 }, 10), false);
  assert.equal(r.needsSecondApproval(none, 1e12), false);
});

test("where a document stands, for a list", () => {
  const policy = { ...none, secondApprovalAbove: 100 };
  assert.deepEqual(r.standing({ policy, amount: 500, status: "DRAFT", approvals: [] }), { state: "none", given: 0 });
  assert.deepEqual(r.standing({ policy, amount: 500, status: "DRAFT", approvals: [{ by: "a" }] }), { state: "awaiting-second", given: 1 });
  assert.deepEqual(r.standing({ policy, amount: 500, status: "APPROVED", approvals: [{ by: "a" }, { by: "b" }] }), { state: "settled", given: 2 });
  assert.equal(r.standing({ policy, amount: 50, status: "pending", approvals: [{ by: "a" }] }).state, "approved-once", "under the threshold the one approval was enough");
});

// ---- a role's limit as a person may set it
test("a role's limit: any amount from 0, or empty; nobody hands out more than they have, or removes a ceiling they live under", () => {
  const owner = p.resolveRole("super_admin");
  const capped = { key: "c", rank: 50, permissions: p.expand(["sales.approve"]), isActive: true, approvalLimit: 10000 };
  assert.equal(p.validateApprovalLimit(5000, ["sales.approve"], owner), null);
  assert.equal(p.validateApprovalLimit("", ["sales.approve"], owner), null, "the owner may make a role with no ceiling");
  assert.equal(p.validateApprovalLimit(0, ["sales.approve"], owner), null);
  assert.match(p.validateApprovalLimit(-1, ["sales.approve"], owner), /0 or more/);
  assert.match(p.validateApprovalLimit("lots", ["sales.approve"], owner), /0 or more/);
  assert.equal(p.validateApprovalLimit(10000, ["sales.approve"], capped), null, "up to their own");
  assert.match(p.validateApprovalLimit(10000.01, ["sales.approve"], capped), /above your own \(10000\)/);
  assert.match(p.validateApprovalLimit(null, ["sales.approve"], capped), /Set a limit/, "no limit on a role that approves would sit above theirs");
  assert.equal(p.validateApprovalLimit(null, ["sales.create"], capped), null, "a role that approves nothing needs no limit");
});

test("roles carry their limit: built-in ones have none, and a custom one reports what was saved", () => {
  for (const k of p.BUILT_IN_KEYS) assert.equal(p.resolveRole(k).approvalLimit, null, k);
  assert.equal(p.resolveRole("junior", [{ key: "junior", name: "Junior", rank: 30, permissions: ["sales.approve"], approvalLimit: 2500 }]).approvalLimit, 2500);
  assert.equal(p.resolveRole("junior", [{ key: "junior", name: "Junior", rank: 30, permissions: ["sales.approve"] }]).approvalLimit, null, "a role saved before limits existed has none");
});
