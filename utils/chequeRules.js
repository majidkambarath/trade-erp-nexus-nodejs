// Post-dated cheques: the rules that need no database.
//
// A cheque is not money until it clears. The amount waits in a post-dated-cheques account (posting
// keys `pdc-receipt` / `pdc-issue`), the cheque itself is a row in the register, and it moves to the
// bank only when it clears.
//
// EVERY STATE BELOW IS A STATE OF THE REGISTER. The accounting is always one of four things that
// already exist: the voucher's own postings, a `cheque_clearance` pair, a full reversal of the
// voucher, or an ordinary expense / debit-note voucher. There is deliberately no new posting key and
// no new voucherType, because services/reports/ledgerReportsService.js `voucherRow` zeroes
// `cheque_clearance` BY NAME - a new PDC voucher type sharing the voucher's id would be counted as a
// second receipt, and a cleared 300 cheque would read as a 600 receipt in the day book.
//
//                 hold <--resume-- ... --hold--> (from pending)
//   pending --deposit--> deposited --clear--> cleared --bounce--> bounced
//   pending ------------clear---------------^
//   pending, hold --cancel--> cancelled          pending, hold, deposited --bounce--> bounced
//
// "Deposited" and "hold" post NOTHING: the money is still in the one post-dated-cheques account.
//
// ASK THE SET, NEVER THE WORD. A consumer asks "may this still be taken to the bank?" (PRESENTABLE),
// "is the money still in the air?" (LIVE), "does this hold its cheque number?" (OPEN) - never
// `status === "pending"`. That is what lets a new state widen every consumer at once instead of
// having to be added to a dozen scattered literals.
//
// Pure: no Mongoose, no I/O.

const PENDING = "pending";
const HOLD = "hold";
const DEPOSITED = "deposited";
const CLEARED = "cleared";
const BOUNCED = "bounced";
const CANCELLED = "cancelled";

const STATUSES = Object.freeze([PENDING, HOLD, DEPOSITED, CLEARED, BOUNCED, CANCELLED]);

// The money is still in the air: recorded, not yet in the bank, not written off.
const LIVE = Object.freeze([PENDING, HOLD, DEPOSITED]);

// It can be taken to the bank, or is already there, so a bank statement line may be the proof that it
// cleared (services/banking/reconciliationCore.js offers exactly these as match candidates). A cheque
// ON HOLD is deliberately not here: it is in the drawer on purpose.
const PRESENTABLE = Object.freeze([PENDING, DEPOSITED]);

// These hold their cheque number: the same number from the same bank cannot be recorded twice while
// one of them is in one of these states.
const OPEN = Object.freeze([...LIVE, CLEARED]);

// Finished with, whatever the reason. The cheque number is free again.
const CLOSED = Object.freeze(STATUSES.filter((s) => !OPEN.includes(s)));

// What each act may be done from and what it leaves behind. A new state is added to the sets above
// and to this table; every consumer then follows.
const TABLE = Object.freeze({
  clear: { from: PRESENTABLE, to: CLEARED },
  deposit: { from: Object.freeze([PENDING]), to: DEPOSITED },
  hold: { from: Object.freeze([PENDING]), to: HOLD },
  resume: { from: Object.freeze([HOLD]), to: PENDING },
  bounce: { from: Object.freeze([...LIVE, CLEARED]), to: BOUNCED },
  cancel: { from: Object.freeze([PENDING, HOLD]), to: CANCELLED },
});
const ACTIONS = Object.freeze(Object.keys(TABLE));

// Bulk acts: one transaction per cheque, never one for all (a bad cheque must not undo the good ones).
// Bounce is NOT bulk: it needs a reason and a return memo for each cheque.
const BULK_ACTIONS = Object.freeze(["deposit", "clear", "hold", "resume"]);
const MAX_BULK = 200;

// The words used when an act is refused for a reason that has no special case.
const PLAIN = Object.freeze({
  clear: (s) => `This cheque is already ${s}`,
  deposit: (s) => `This cheque is already ${s}`,
  hold: (s) => `A ${s} cheque cannot be put on hold`,
  resume: (s) => `Only a cheque on hold can be resumed; this one is ${s}`,
  bounce: (s) => `A ${s} cheque cannot be marked bounced`,
  cancel: (s) => `A ${s} cheque cannot be marked cancelled`,
});

// May `action` be done to a cheque in `status`? -> { ok: true, to } or { ok: false, code, message }.
// The messages for the original four statuses are the ones the service has always given, word for word.
function canTransition(status, action) {
  // own keys only: "constructor" or "__proto__" must be an unknown action, not Object's own members
  const rule = Object.hasOwn(TABLE, action) ? TABLE[action] : null;
  if (!rule) return { ok: false, code: "UNKNOWN_ACTION", message: `Unknown cheque action: ${action}` };
  if (rule.from.includes(status)) return { ok: true, to: rule.to };
  // The special cases, said in words a person can act on.
  if (status === HOLD && (action === "clear" || action === "deposit")) {
    return { ok: false, code: "CHEQUE_ON_HOLD", message: "This cheque is on hold. Resume it first, then try again." };
  }
  if (status === DEPOSITED && action === "cancel") {
    return { ok: false, code: "CHEQUE_WITH_BANK", message: "This cheque is at the bank and cannot be withdrawn. If it comes back, mark it bounced." };
  }
  if (action === "resume") return { ok: false, code: "CHEQUE_NOT_HELD", message: PLAIN.resume(status) };
  return { ok: false, code: "CHEQUE_NOT_PENDING", message: PLAIN[action](status) };
}

const isLive = (status) => LIVE.includes(status);
const isPresentable = (status) => PRESENTABLE.includes(status);

module.exports = {
  STATUSES, LIVE, PRESENTABLE, OPEN, CLOSED, ACTIONS, BULK_ACTIONS, MAX_BULK,
  canTransition, isLive, isPresentable,
};
