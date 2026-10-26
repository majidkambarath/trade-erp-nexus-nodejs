// Pure rules of an insurance claim (no Mongoose, no clock): the UAE accident-repair flow a job card forks
// into (utils/garage.js §1.2 "the flow forks") - estimate goes to the insurer, a surveyor inspects the car,
// the insurer approves an amount, and the bill splits in two: the insurer pays what it approved less the
// excess and any parts depreciation, which the customer pays instead. Service:
// services/garage/insuranceClaimService.js.
//
// DRAFT -> SUBMITTED -> SURVEYED -> APPROVED | PARTLY_APPROVED | REJECTED -> INVOICED. There is no stored
// "SETTLED": whether the insurer has actually paid is read off the invoice's own outstandingAmount, the same
// rule the rest of the product follows (CLAUDE.md "never overwrite Transaction.status with a payment state").
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (v === "" || v === null || v === undefined ? NaN : Number(v));
const text = (v, max) => String(v ?? "").trim().slice(0, max);
const idOf = (v) => (v && typeof v === "object" && v._id ? String(v._id) : v == null ? "" : String(v));

const CLAIM_STATUS = ["DRAFT", "SUBMITTED", "SURVEYED", "APPROVED", "PARTLY_APPROVED", "REJECTED", "INVOICED"];
const LIVE_STATUS = new Set(["DRAFT", "SUBMITTED", "SURVEYED", "APPROVED", "PARTLY_APPROVED"]);
const DECIDED = new Set(["APPROVED", "PARTLY_APPROVED", "REJECTED"]);

function validateClaim(input = {}) {
  const errors = [];
  const add = (field, code, message) => errors.push({ field, code, message });
  if (!idOf(input.insurerId)) add("insurerId", "INSURER_REQUIRED", "Choose the insurer");
  if (!idOf(input.jobCardId)) add("jobCardId", "JOB_CARD_REQUIRED", "Choose the job card this claim is for");
  if (!text(input.policyNo, 60)) add("policyNo", "POLICY_REQUIRED", "Enter the policy number");
  return errors;
}

function checkSurvey(input = {}) {
  if (!text(input.surveyorName, 100)) return { code: "SURVEYOR_REQUIRED", message: "Enter the surveyor's name" };
  return null;
}

// The insurer's decision: approved in whole or in part, or rejected. An LPO number is the evidence the
// insurer authorised the work (CGST-style numbering elsewhere in the product makes the same point: a number
// that stands for an authorisation is never left blank), so it is required of an approval, never a rejection.
function checkApproval(input = {}) {
  if (!DECIDED.has(input.status)) return { code: "INVALID_DECISION", message: "The decision is approved, partly approved, or rejected" };
  if (input.status === "REJECTED") return null;
  if (!text(input.lpoNo, 60)) return { field: "lpoNo", code: "LPO_REQUIRED", message: "Enter the LPO or approval number the insurer gave" };
  if (!(num(input.approvedAmount) >= 0)) return { field: "approvedAmount", code: "INVALID_AMOUNT", message: "Enter the amount the insurer approved" };
  const pct = input.deductions?.partsDepreciationPct;
  if (pct !== undefined && pct !== "" && !(num(pct) >= 0 && num(pct) <= 100)) {
    return { field: "partsDepreciationPct", code: "INVALID_PERCENT", message: "Depreciation is a percentage from 0 to 100" };
  }
  return null;
}

// The money: what the insurer pays, and what is collected from the customer instead. `approvedAmount` can
// be less than the job's full value (some lines were not approved); that shortfall is also the customer's,
// alongside the excess and the depreciation on parts replaced. `insurerAmount` is clamped at 0 - a small
// approved amount with a large excess is not a NEGATIVE bill to the insurer, it is a bill the customer pays
// in full and the insurer contributes nothing to.
function splitBill(jobTotal, { approvedAmount, excess = 0, depreciationPct = 0, depreciablePartsAmount = 0 } = {}) {
  const total = round2(num(jobTotal) || 0);
  const approved = Math.min(round2(num(approvedAmount)) || 0, total);
  const depreciationAmount = round2(((num(depreciablePartsAmount) || 0) * (num(depreciationPct) || 0)) / 100);
  const notApproved = round2(Math.max(0, total - approved));
  const insurerAmount = round2(Math.max(0, approved - (num(excess) || 0) - depreciationAmount));
  const customerAmount = round2(total - insurerAmount);
  return { total, approved, depreciationAmount, notApproved, insurerAmount, customerAmount };
}

// How long a claim has been open, for the claims register - only claims still being chased (not yet
// invoiced, not rejected) are aged; a rejected or invoiced claim is settled one way or the other.
function claimAgeing(claims = [], { today, dayOf } = {}) {
  const open = claims.filter((c) => LIVE_STATUS.has(c.status));
  const days = (c) => {
    const since = c.submittedAt || c.createdAt;
    if (!since) return 0;
    return Math.max(0, Math.round((new Date(today) - new Date(dayOf ? dayOf(since) : since)) / 86400000));
  };
  const bucket = (c) => {
    const d = days(c);
    return d <= 7 ? "0-7" : d <= 14 ? "8-14" : d <= 30 ? "15-30" : "30+";
  };
  const buckets = { "0-7": [], "8-14": [], "15-30": [], "30+": [] };
  for (const c of open) buckets[bucket(c)].push({ claimNo: c.claimNo, insurer: c.insurer?.name, days: days(c) });
  return buckets;
}

module.exports = {
  CLAIM_STATUS, LIVE_STATUS, DECIDED,
  round2, num, text, idOf,
  validateClaim, checkSurvey, checkApproval, splitBill, claimAgeing,
};
