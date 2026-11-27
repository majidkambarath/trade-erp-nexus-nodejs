// The pure rules of self-billing (utils/selfBilling.js).
//   node --test utils/__tests__/selfBilling.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanAgreement, refusal } = require("../selfBilling");

test("an agreement is not named, switched off, or agreed with its reference and starting day", () => {
  assert.equal(cleanAgreement(undefined), undefined);
  for (const off of [null, false, {}, { agreed: "true" }, { agreed: false, agreementRef: "x" }]) {
    assert.deepEqual(cleanAgreement(off), { value: { agreed: false } });
  }
  assert.deepEqual(cleanAgreement({ agreed: true, agreementRef: " SBA-1 ", from: "2026-02-28", extra: 1 }), { value: { agreed: true, agreementRef: "SBA-1", from: "2026-02-28" } });
  for (const bad of [
    "yes", [], 1,
    { agreed: true },
    { agreed: true, agreementRef: "A" },
    { agreed: true, from: "2026-01-01" },
    { agreed: true, agreementRef: "x".repeat(81), from: "2026-01-01" },
    { agreed: true, agreementRef: "A", from: "2026-02-30" },
    { agreed: true, agreementRef: "A", from: "01/01/2026" },
    { agreed: true, agreementRef: { a: 1 }, from: "2026-01-01" },
  ]) {
    assert.ok(cleanAgreement(bad).error, JSON.stringify(bad));
  }
});

test("every condition is checked, each with its own code", () => {
  const vendor = { vendorName: "Desert Farm", trn: "100555444300003", selfBilling: { agreed: true, agreementRef: "A", from: "2026-03-01" } };
  const base = { country: "AE", recipientTrn: "100123456700003", registered: true, vendor, day: "2026-03-01" };
  assert.equal(refusal(base), null);
  const code = (extra) => refusal({ ...base, ...extra })?.code;
  assert.equal(code({ country: "IN" }), "SELF_BILLING_UAE_ONLY");
  assert.equal(code({ vendor: null }), "SELF_BILLING_NO_SUPPLIER");
  assert.equal(code({ recipientTrn: "  " }), "SELF_BILLING_RECIPIENT_NOT_REGISTERED");
  assert.equal(code({ registered: false }), "SELF_BILLING_RECIPIENT_NOT_REGISTERED");
  assert.equal(code({ vendor: { ...vendor, selfBilling: undefined } }), "SELF_BILLING_NOT_AGREED");
  assert.equal(code({ vendor: { ...vendor, trn: "" } }), "SELF_BILLING_SUPPLIER_NOT_REGISTERED");
  assert.equal(code({ day: "2026-02-28" }), "SELF_BILLING_BEFORE_AGREEMENT");
});
