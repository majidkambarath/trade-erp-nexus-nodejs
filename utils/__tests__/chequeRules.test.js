const test = require("node:test");
const assert = require("node:assert/strict");
const rules = require("../chequeRules");

const OLD = ["pending", "cleared", "bounced", "cancelled"]; // the register's original four

test("the seven statuses: the original four are kept verbatim, hold, deposited and returned are added", () => {
  assert.deepEqual([...rules.STATUSES], ["pending", "hold", "deposited", "cleared", "bounced", "returned", "cancelled"]);
  for (const s of OLD) assert.ok(rules.STATUSES.includes(s), `${s} must survive: no status migration`);
});

test("every status is in exactly one of OPEN or CLOSED, and LIVE is inside OPEN", () => {
  for (const s of rules.STATUSES) assert.equal(rules.OPEN.includes(s) !== rules.CLOSED.includes(s), true, `${s} must be OPEN xor CLOSED`);
  for (const s of rules.LIVE) assert.ok(rules.OPEN.includes(s), `LIVE ${s} must hold its cheque number`);
  assert.deepEqual([...rules.CLOSED].sort(), ["bounced", "cancelled", "returned"]);
  assert.ok(rules.OPEN.includes("cleared"), "a cleared cheque still holds its number");
});

test("LIVE is the money in the air; PRESENTABLE leaves out a cheque kept in the drawer on purpose", () => {
  assert.deepEqual([...rules.LIVE].sort(), ["deposited", "hold", "pending"]);
  assert.deepEqual([...rules.PRESENTABLE].sort(), ["deposited", "pending"]);
  assert.equal(rules.isPresentable("hold"), false, "a held cheque is not a bank-reconciliation candidate");
  assert.equal(rules.isPresentable("deposited"), true, "a deposited cheque still must be: it is at the bank, waiting to be matched");
  assert.equal(rules.isLive("cleared"), false);
});

test("the sets are frozen: a consumer cannot widen one by accident", () => {
  for (const set of [rules.STATUSES, rules.LIVE, rules.PRESENTABLE, rules.OPEN, rules.CLOSED, rules.BULK_ACTIONS]) {
    assert.ok(Object.isFrozen(set));
    assert.throws(() => set.push("x"), TypeError);
  }
});

// ---- the original four statuses behave exactly as the service always did, word for word ----
test("clear from the original statuses: only pending, with the original refusal", () => {
  assert.deepEqual(rules.canTransition("pending", "clear"), { ok: true, to: "cleared" });
  for (const from of ["cleared", "bounced", "cancelled"]) {
    const r = rules.canTransition(from, "clear");
    assert.deepEqual([r.ok, r.code, r.message], [false, "CHEQUE_NOT_PENDING", `This cheque is already ${from}`]);
  }
});

test("bounce: allowed from pending AND cleared, refused from bounced and cancelled with the original words", () => {
  assert.equal(rules.canTransition("pending", "bounce").to, "bounced");
  assert.equal(rules.canTransition("cleared", "bounce").to, "bounced");
  for (const from of ["bounced", "cancelled"]) {
    const r = rules.canTransition(from, "bounce");
    assert.deepEqual([r.ok, r.code, r.message], [false, "CHEQUE_NOT_PENDING", `A ${from} cheque cannot be marked bounced`]);
  }
});

test("cancel: a cleared cheque is bounced, never cancelled; the original words are kept", () => {
  assert.equal(rules.canTransition("pending", "cancel").to, "cancelled");
  for (const from of ["cleared", "bounced", "cancelled"]) {
    const r = rules.canTransition(from, "cancel");
    assert.deepEqual([r.ok, r.code, r.message], [false, "CHEQUE_NOT_PENDING", `A ${from} cheque cannot be marked cancelled`]);
  }
});

// ---- the new states ----
test("deposit: from pending only; a held cheque must be resumed first", () => {
  assert.deepEqual(rules.canTransition("pending", "deposit"), { ok: true, to: "deposited" });
  assert.equal(rules.canTransition("hold", "deposit").code, "CHEQUE_ON_HOLD");
  for (const from of ["deposited", "cleared", "bounced", "cancelled"]) {
    assert.equal(rules.canTransition(from, "deposit").code, "CHEQUE_NOT_PENDING", from);
  }
});

test("clear: from pending or deposited; a held cheque is refused with a way forward, not a bare refusal", () => {
  assert.equal(rules.canTransition("deposited", "clear").to, "cleared");
  const held = rules.canTransition("hold", "clear");
  assert.equal(held.code, "CHEQUE_ON_HOLD");
  assert.match(held.message, /Resume it first/);
});

test("hold and resume are a pair: only pending goes on hold, only a held cheque is resumed", () => {
  assert.equal(rules.canTransition("pending", "hold").to, "hold");
  assert.equal(rules.canTransition("hold", "resume").to, "pending");
  for (const from of ["hold", "deposited", "cleared", "bounced", "cancelled"]) assert.equal(rules.canTransition(from, "hold").ok, false, `hold from ${from}`);
  for (const from of ["pending", "deposited", "cleared", "bounced", "cancelled"]) assert.equal(rules.canTransition(from, "resume").code, "CHEQUE_NOT_HELD", `resume from ${from}`);
});

test("a cheque at the bank cannot be withdrawn: cancel is refused from deposited, but it can still bounce", () => {
  const r = rules.canTransition("deposited", "cancel");
  assert.deepEqual([r.ok, r.code], [false, "CHEQUE_WITH_BANK"]);
  assert.equal(rules.canTransition("deposited", "bounce").to, "bounced");
  assert.equal(rules.canTransition("hold", "cancel").to, "cancelled", "a held cheque is still in hand, so it can be withdrawn");
  assert.equal(rules.canTransition("hold", "bounce").to, "bounced");
});

test("return: handed back to the party only before it was presented - never from the bank, never once cleared", () => {
  assert.deepEqual(rules.canTransition("pending", "return"), { ok: true, to: "returned" });
  assert.equal(rules.canTransition("hold", "return").to, "returned");
  const atBank = rules.canTransition("deposited", "return");
  assert.deepEqual([atBank.ok, atBank.code], [false, "CHEQUE_WITH_BANK"]);
  assert.match(atBank.message, /handed back/);
  for (const from of ["cleared", "bounced", "cancelled", "returned"]) assert.equal(rules.canTransition(from, "return").code, "CHEQUE_NOT_PENDING", from);
});

test("an unknown action or status is refused, never allowed by default", () => {
  assert.equal(rules.canTransition("pending", "teleport").code, "UNKNOWN_ACTION");
  assert.equal(rules.canTransition("nonsense", "clear").ok, false);
  assert.equal(rules.canTransition(undefined, "bounce").ok, false);
  assert.equal(rules.canTransition(null, "cancel").ok, false);
  for (const a of ["constructor", "__proto__", "toString", "hasOwnProperty"]) assert.equal(rules.canTransition("pending", a).code, "UNKNOWN_ACTION", a);
});

test("every legal transition lands on a known status, and the full matrix has no surprises", () => {
  const legal = [];
  for (const from of rules.STATUSES) for (const action of rules.ACTIONS) {
    const r = rules.canTransition(from, action);
    if (r.ok) { assert.ok(rules.STATUSES.includes(r.to)); legal.push(`${from}>${action}>${r.to}`); }
  }
  // pinned in full: a change to the machine must be a deliberate edit of this list
  assert.deepEqual(legal.sort(), [
    "cleared>bounce>bounced", "deposited>bounce>bounced", "deposited>clear>cleared", "hold>bounce>bounced",
    "hold>cancel>cancelled", "hold>resume>pending", "hold>return>returned", "pending>bounce>bounced", "pending>cancel>cancelled",
    "pending>clear>cleared", "pending>deposit>deposited", "pending>hold>hold", "pending>return>returned",
  ]);
});

test("a closed cheque never comes back through this table (re-presentation is a NEW cheque)", () => {
  for (const from of rules.CLOSED) for (const action of rules.ACTIONS) assert.equal(rules.canTransition(from, action).ok, false, `${from} ${action}`);
});

test("bulk: deposit, clear, hold and resume - but never bounce, which needs a reason for each", () => {
  assert.deepEqual([...rules.BULK_ACTIONS].sort(), ["clear", "deposit", "hold", "resume"]);
  assert.equal(rules.BULK_ACTIONS.includes("bounce"), false);
  assert.equal(rules.MAX_BULK, 200);
});

test("the Cheque model takes its statuses from here, so the two cannot drift", () => {
  const { CHEQUE_STATUSES } = require("../../models/modules/banking/bankingModels");
  assert.deepEqual([...CHEQUE_STATUSES], [...rules.STATUSES]);
});
