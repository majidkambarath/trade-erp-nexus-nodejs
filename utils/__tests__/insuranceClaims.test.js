// Pure rules of an insurance claim (utils/insuranceClaims.js): validation, the survey and approval checks,
// and the money split between the insurer and the customer.
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../insuranceClaims");

const I = "a".repeat(24), J = "b".repeat(24);

test("validateClaim: an insurer, the job card it is for, and a policy number", () => {
  const codes = (i) => C.validateClaim(i).map((e) => e.code);
  assert.deepEqual(codes({ insurerId: I, jobCardId: J, policyNo: "POL-1" }), []);
  assert.deepEqual(codes({}), ["INSURER_REQUIRED", "JOB_CARD_REQUIRED", "POLICY_REQUIRED"]);
});

test("checkSurvey: the surveyor's name is required", () => {
  assert.equal(C.checkSurvey({ surveyorName: "Ahmed" }), null);
  assert.equal(C.checkSurvey({}).code, "SURVEYOR_REQUIRED");
});

test("checkApproval: a rejection needs no LPO; an approval does, and a real amount", () => {
  assert.equal(C.checkApproval({ status: "REJECTED" }), null);
  assert.equal(C.checkApproval({ status: "APPROVED" }).code, "LPO_REQUIRED");
  assert.equal(C.checkApproval({ status: "APPROVED", lpoNo: "LPO-99112" }).code, "INVALID_AMOUNT");
  assert.equal(C.checkApproval({ status: "APPROVED", lpoNo: "LPO-99112", approvedAmount: 5000 }), null);
  assert.equal(C.checkApproval({ status: "PARTLY_APPROVED", lpoNo: "LPO-1", approvedAmount: 3000 }), null);
  assert.equal(C.checkApproval({ status: "whatever" }).code, "INVALID_DECISION");
  assert.equal(C.checkApproval({ status: "APPROVED", lpoNo: "LPO-1", approvedAmount: 100, deductions: { partsDepreciationPct: 150 } }).code, "INVALID_PERCENT");
});

test("splitBill: the insurer pays what it approved, less the excess and the depreciation on parts; the customer pays the rest", () => {
  // A full repair worth 10,000, fully approved, excess 500, 2,000 of parts depreciated 10% (200).
  const s = C.splitBill(10000, { approvedAmount: 10000, excess: 500, depreciationPct: 10, depreciablePartsAmount: 2000 });
  assert.deepEqual(s, { total: 10000, approved: 10000, depreciationAmount: 200, notApproved: 0, insurerAmount: 9300, customerAmount: 700 });
  // The two halves always add back to the job's full value - the whole point of a split.
  assert.equal(s.insurerAmount + s.customerAmount, s.total);
});

test("splitBill: a partly approved claim leaves the unapproved part on the customer too", () => {
  const s = C.splitBill(10000, { approvedAmount: 8000, excess: 500, depreciationPct: 0, depreciablePartsAmount: 0 });
  assert.deepEqual(s, { total: 10000, approved: 8000, depreciationAmount: 0, notApproved: 2000, insurerAmount: 7500, customerAmount: 2500 });
  assert.equal(s.insurerAmount + s.customerAmount, s.total);
});

test("splitBill: the insurer's share never goes negative - a small approval under a large excess is the customer's bill in full", () => {
  const s = C.splitBill(1000, { approvedAmount: 300, excess: 500, depreciationPct: 0, depreciablePartsAmount: 0 });
  assert.equal(s.insurerAmount, 0);
  assert.equal(s.customerAmount, 1000);
  assert.equal(s.insurerAmount + s.customerAmount, s.total);
});

test("splitBill: nothing approved at all - the whole job falls to the customer", () => {
  const s = C.splitBill(5000, { approvedAmount: 0 });
  assert.deepEqual(s, { total: 5000, approved: 0, depreciationAmount: 0, notApproved: 5000, insurerAmount: 0, customerAmount: 5000 });
});

test("claimAgeing: open claims are bucketed by days since submission; invoiced and rejected ones are not aged", () => {
  const dayOf = (v) => v;
  const claims = [
    { claimNo: "CLM-1", status: "SUBMITTED", submittedAt: "2026-10-20", insurer: { name: "Orient" } },
    { claimNo: "CLM-2", status: "SURVEYED", submittedAt: "2026-10-05", insurer: { name: "Sukoon" } },
    { claimNo: "CLM-3", status: "INVOICED", submittedAt: "2026-09-01", insurer: { name: "AXA" } },
    { claimNo: "CLM-4", status: "REJECTED", submittedAt: "2026-09-01", insurer: { name: "AXA" } },
  ];
  const buckets = C.claimAgeing(claims, { today: "2026-10-26", dayOf });
  assert.deepEqual(buckets["0-7"].map((c) => c.claimNo), ["CLM-1"]);
  assert.deepEqual(buckets["15-30"].map((c) => c.claimNo), ["CLM-2"]);
  assert.equal(buckets["30+"].length, 0, "the invoiced and rejected claims are not aged at all");
});
