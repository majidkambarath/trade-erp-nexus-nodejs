const test = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../chequeRules");

// Stage 0 of the PDC lifecycle: the four statuses the register has always had, now asked about through sets.
// These tests pin the behaviour the service had BEFORE the sets existed, so replacing the literals changed nothing.

test("the register still has exactly the four statuses it always had", () => {
  assert.deepEqual([...rules.STATUSES], ["pending", "cleared", "bounced", "cancelled"]);
});

test("every status is in exactly one of OPEN or CLOSED, and LIVE is inside OPEN", () => {
  for (const s of rules.STATUSES) {
    assert.equal(rules.OPEN.includes(s) !== rules.CLOSED.includes(s), true, `${s} must be OPEN xor CLOSED`);
  }
  for (const s of rules.LIVE) assert.ok(rules.OPEN.includes(s), `LIVE ${s} must hold its cheque number`);
  assert.deepEqual([...rules.OPEN].sort(), ["cleared", "pending"], "the duplicate guard has always been pending + cleared");
  assert.deepEqual([...rules.CLOSED].sort(), ["bounced", "cancelled"]);
});

test("only a pending cheque is live and presentable, as before", () => {
  assert.deepEqual([...rules.LIVE], ["pending"]);
  assert.deepEqual([...rules.PRESENTABLE], ["pending"]);
  assert.equal(rules.isLive("pending"), true);
  assert.equal(rules.isLive("cleared"), false);
  assert.equal(rules.isPresentable("pending"), true);
  assert.equal(rules.isPresentable("bounced"), false);
});

test("the sets are frozen: a consumer cannot widen one by accident", () => {
  for (const set of [rules.STATUSES, rules.LIVE, rules.PRESENTABLE, rules.OPEN, rules.CLOSED]) {
    assert.ok(Object.isFrozen(set));
    assert.throws(() => set.push("x"), TypeError);
  }
});

test("clear: allowed only from pending, with the service's original refusal", () => {
  assert.deepEqual(rules.canTransition("pending", "clear"), { ok: true, to: "cleared" });
  for (const from of ["cleared", "bounced", "cancelled"]) {
    const r = rules.canTransition(from, "clear");
    assert.equal(r.ok, false);
    assert.equal(r.code, "CHEQUE_NOT_PENDING");
    assert.equal(r.message, `This cheque is already ${from}`);
  }
});

test("bounce: allowed from pending AND cleared (a cleared cheque can come back), refused from the closed states", () => {
  assert.deepEqual(rules.canTransition("pending", "bounce"), { ok: true, to: "bounced" });
  assert.deepEqual(rules.canTransition("cleared", "bounce"), { ok: true, to: "bounced" });
  for (const from of ["bounced", "cancelled"]) {
    const r = rules.canTransition(from, "bounce");
    assert.equal(r.ok, false);
    assert.equal(r.code, "CHEQUE_NOT_PENDING");
    assert.equal(r.message, `A ${from} cheque cannot be marked bounced`);
  }
});

test("cancel: pending only - a cleared cheque is bounced, never cancelled", () => {
  assert.deepEqual(rules.canTransition("pending", "cancel"), { ok: true, to: "cancelled" });
  for (const from of ["cleared", "bounced", "cancelled"]) {
    const r = rules.canTransition(from, "cancel");
    assert.equal(r.ok, false);
    assert.equal(r.code, "CHEQUE_NOT_PENDING");
    assert.equal(r.message, `A ${from} cheque cannot be marked cancelled`);
  }
});

test("an unknown action or status is refused, never allowed by default", () => {
  assert.equal(rules.canTransition("pending", "teleport").ok, false);
  assert.equal(rules.canTransition("pending", "teleport").code, "UNKNOWN_ACTION");
  assert.equal(rules.canTransition("nonsense", "clear").ok, false);
  assert.equal(rules.canTransition(undefined, "bounce").ok, false);
  assert.equal(rules.canTransition(null, "cancel").ok, false);
  // prototype keys must not be mistaken for actions
  for (const a of ["constructor", "__proto__", "toString", "hasOwnProperty"]) assert.equal(rules.canTransition("pending", a).ok, false, a);
});

test("every legal transition lands on a status the register knows", () => {
  for (const from of rules.STATUSES) for (const action of rules.ACTIONS) {
    const r = rules.canTransition(from, action);
    if (r.ok) assert.ok(rules.STATUSES.includes(r.to), `${from} -${action}-> ${r.to}`);
  }
});

test("the Cheque model takes its statuses from here, so the two cannot drift", () => {
  const { CHEQUE_STATUSES } = require("../../models/modules/banking/bankingModels");
  assert.deepEqual([...CHEQUE_STATUSES], [...rules.STATUSES]);
});
