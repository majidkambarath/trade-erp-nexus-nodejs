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
// ASK THE SET, NEVER THE WORD. A consumer asks "may this still be taken to the bank?" (PRESENTABLE),
// "is the money still in the air?" (LIVE), "does this hold its cheque number?" (OPEN) - never
// `status === "pending"`. That is what lets a new state widen every consumer at once instead of
// having to be added to a dozen scattered literals.
//
// Pure: no Mongoose, no I/O.

const PENDING = "pending";
const CLEARED = "cleared";
const BOUNCED = "bounced";
const CANCELLED = "cancelled";

const STATUSES = Object.freeze([PENDING, CLEARED, BOUNCED, CANCELLED]);

// The money is still in the air: recorded, not yet in the bank, not written off.
const LIVE = Object.freeze([PENDING]);

// It can still be presented, so a bank statement line may be the proof that it cleared
// (services/banking/reconciliationCore.js offers exactly these as match candidates).
const PRESENTABLE = Object.freeze([PENDING]);

// These hold their cheque number: the same number from the same bank cannot be recorded twice while
// one of them is in one of these states.
const OPEN = Object.freeze([...LIVE, CLEARED]);

// Finished with, whatever the reason. The cheque number is free again.
const CLOSED = Object.freeze(STATUSES.filter((s) => !OPEN.includes(s)));

// What each act may be done from, and what it leaves behind. Adding a state means adding it to the
// sets above; these tables then follow.
const FROM = Object.freeze({
  clear: PRESENTABLE,
  bounce: Object.freeze([...LIVE, CLEARED]),
  cancel: LIVE,
});
const RESULT = Object.freeze({ clear: CLEARED, bounce: BOUNCED, cancel: CANCELLED });
const ACTIONS = Object.freeze(Object.keys(FROM));

// May `action` be done to a cheque in `status`? -> { ok: true, to } or { ok: false, code, message }.
// The messages are the ones the service has always given, word for word.
function canTransition(status, action) {
  // own keys only: "constructor" or "__proto__" must be an unknown action, not Object's own members
  const allowed = Object.hasOwn(FROM, action) ? FROM[action] : null;
  if (!allowed) return { ok: false, code: "UNKNOWN_ACTION", message: `Unknown cheque action: ${action}` };
  if (allowed.includes(status)) return { ok: true, to: RESULT[action] };
  const message = action === "clear" ? `This cheque is already ${status}` : `A ${status} cheque cannot be marked ${RESULT[action]}`;
  return { ok: false, code: "CHEQUE_NOT_PENDING", message };
}

const isLive = (status) => LIVE.includes(status);
const isPresentable = (status) => PRESENTABLE.includes(status);

module.exports = {
  STATUSES, LIVE, PRESENTABLE, OPEN, CLOSED, ACTIONS,
  canTransition, isLive, isPresentable,
};
