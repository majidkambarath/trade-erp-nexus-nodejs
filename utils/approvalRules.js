// Who may approve a document, and how many people must. Pure - no Mongoose, no request - so every rule is a table in a
// test, like utils/permissions.js and utils/plans.js beside it.
//
// Three controls, each off until an organisation (or a role) sets it, so nothing changes for anyone who has not:
//
//   a role's APPROVAL LIMIT       the largest document a person in that role may approve (empty = no limit)
//   SEPARATE APPROVER             the person who prepared a document may not approve it
//   SECOND APPROVAL ABOVE AMOUNT  a document above this amount needs two different people to approve it: the first approval
//                                 is recorded and the document stays where it is; the second one makes it approved
//
// Holding the `approve` permission is still the first test (permissionGate). This answers the next question: may THIS person
// approve THIS document, given its amount, who made it, and who has already approved it.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n, currency) => `${round2(n).toFixed(2)}${currency ? ` ${currency}` : ""}`;
const sameId = (a, b) => a !== undefined && a !== null && b !== undefined && b !== null && String(a) === String(b);

/** The policy an organisation has set, with every missing or nonsensical value read as "not set". */
function normalisePolicy(raw) {
  const above = raw?.secondApprovalAbove;
  const n = above === null || above === undefined || above === "" ? null : Number(above);
  return {
    separateApprover: raw?.separateApprover === true,
    secondApprovalAbove: n !== null && Number.isFinite(n) && n >= 0 ? round2(n) : null,
  };
}

/** Does a document of this amount need two approvers under this policy? */
const needsSecondApproval = (policy, amount) => {
  const p = normalisePolicy(policy);
  return p.secondApprovalAbove !== null && round2(amount) > p.secondApprovalAbove;
};

/** A role's limit as stored (a number, or empty for none) -> a number, or null for no limit. */
const limitOf = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? round2(n) : null;
};

/**
 * May `approver` approve a document? -> { ok:true, final, step, of } or { ok:false, code, message, details }.
 *
 *   policy      { separateApprover, secondApprovalAbove }
 *   amount      the document's total in the organisation's base currency
 *   preparedBy  the id of whoever made the document
 *   approver    { id, limit }  (limit: the approver's role limit, null for none)
 *   approvals   those already given: [{ by }]
 *
 * `final: false` means "recorded, but a second person still has to approve": the document must not move yet.
 */
function decide({ policy, amount, preparedBy, approver, approvals = [], currency = "" }) {
  const pol = normalisePolicy(policy);
  const total = round2(amount);
  const limit = limitOf(approver?.limit);

  if (pol.separateApprover && sameId(preparedBy, approver?.id)) {
    return { ok: false, code: "SELF_APPROVAL_NOT_ALLOWED", message: "You prepared this document, so someone else has to approve it.", details: {} };
  }
  if (limit !== null && total > limit) {
    return {
      ok: false,
      code: "APPROVAL_LIMIT_EXCEEDED",
      message: `This document is ${money(total, currency)} and your approval limit is ${money(limit, currency)}. Ask someone with a higher limit to approve it.`,
      details: { amount: total, limit },
    };
  }
  if (!needsSecondApproval(pol, total)) return { ok: true, final: true, step: 1, of: 1 };

  const given = (approvals || []).filter((a) => a && a.by !== undefined && a.by !== null);
  if (given.some((a) => sameId(a.by, approver?.id))) {
    return { ok: false, code: "SECOND_APPROVER_REQUIRED", message: "You have already given the first approval. A different person has to give the second.", details: {} };
  }
  if (given.length === 0) return { ok: true, final: false, step: 1, of: 2 };
  return { ok: true, final: true, step: 2, of: 2 };
}

/**
 * Must a document that would take effect the moment it is SAVED (a journal, a contra, a ledger expense, a note, a receipt, a
 * payment) wait for an approver instead? It must when the person saving it has an approval limit the amount is above (they
 * could not approve it themselves, so they cannot just post it), or when the organisation asks for a second approver at this
 * amount (one person cannot post what two must approve). Below both, and for a person with no limit, it posts at once as
 * before. -> null | { reason: "limit", amount, limit } | { reason: "second", amount, above }
 *
 *   maker  { limit }   the person saving it (limit: their role's approval limit, null for none)
 */
function holdOnSave({ policy, amount, maker }) {
  const pol = normalisePolicy(policy);
  const total = round2(amount);
  const limit = limitOf(maker?.limit);
  if (limit !== null && total > limit) return { reason: "limit", amount: total, limit };
  if (needsSecondApproval(pol, total)) return { reason: "second", amount: total, above: pol.secondApprovalAbove };
  return null;
}

/** The sentence for a hold, in the words a person saving the voucher reads. */
function holdMessage(hold, currency = "") {
  if (!hold) return "";
  if (hold.reason === "limit") {
    return `This is ${money(hold.amount, currency)}, above your approval limit of ${money(hold.limit, currency)}, so it has been saved but not posted. Someone with a higher limit has to approve it.`;
  }
  return `This is ${money(hold.amount, currency)}, above ${money(hold.above, currency)}, so it needs two approvers. It has been saved but not posted.`;
}

/**
 * May `approver` change the posted figures of a voucher that is already approved? Changing them takes the old postings back and
 * posts new ones, which is a deletion plus an approval, so it is judged as BOTH: the holder of deletePosted (checked by the
 * caller) and an approval of the NEW amount that stands on its own. It stands on its own only when no second approver is needed:
 * an edit is one person's act, so an amount that needs two is refused (delete the voucher and enter a new one, which waits
 * for both). The people who approved the old figures do not count towards the new ones.
 * -> the verdict of decide(), with `final: false` turned into a refusal.
 */
function decideRepost({ policy, amount, preparedBy, approver, currency = "" }) {
  const verdict = decide({ policy, amount, preparedBy, approver, approvals: [], currency });
  if (verdict.ok && !verdict.final) {
    return {
      ok: false,
      code: "SECOND_APPROVER_REQUIRED",
      message: `This voucher is ${money(amount, currency)}, so a change to it needs two approvers, and an edit is one person's act. Delete the voucher and enter it again; the new one will wait for both approvals.`,
      details: { amount: round2(amount) },
    };
  }
  return verdict;
}

/** Where a document stands, for a list or a badge: nothing given, or the first of two given and the second awaited. */
function standing({ policy, amount, status, approvals = [] }) {
  const given = (approvals || []).length;
  if (status && !["DRAFT", "draft", "pending"].includes(status)) return { state: "settled", given };
  if (given > 0 && needsSecondApproval(policy, amount)) return { state: "awaiting-second", given };
  return { state: given > 0 ? "approved-once" : "none", given };
}

/** The approvals with this one added - unless that person is already on the list (the threshold may have been raised after their first). */
const addApproval = (list, approval) => {
  const have = (list || []).slice();
  if (approval && !have.some((a) => sameId(a.by, approval.by))) have.push(approval);
  return have;
};

module.exports = { normalisePolicy, needsSecondApproval, limitOf, decide, decideRepost, holdOnSave, holdMessage, standing, addApproval };
