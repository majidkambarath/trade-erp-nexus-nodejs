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

module.exports = { normalisePolicy, needsSecondApproval, limitOf, decide, standing, addApproval };
