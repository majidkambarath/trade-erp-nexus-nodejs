const test = require("node:test");
const assert = require("node:assert/strict");
const d = require("../chequeDishonour");

const NOW = new Date("2026-10-26T10:00:00Z");
const RECEIPT = { amount: 1000, direction: "receipt", partyIsCustomer: true, now: NOW };
const ACC = "a".repeat(24);
const bad = (input, ctx = RECEIPT) => d.normaliseBounce(input, ctx);

test("the reason list is fixed, each code unique and labelled, and the objects are frozen", () => {
  const codes = d.RETURN_REASONS.map((r) => r.code);
  assert.equal(new Set(codes).size, codes.length);
  assert.deepEqual(codes, ["insufficient_funds", "account_closed", "signature_mismatch", "stop_payment", "amount_mismatch", "post_dated", "stale", "technical", "other"]);
  for (const r of d.RETURN_REASONS) { assert.ok(r.label); assert.ok(Object.isFrozen(r)); }
  assert.equal(d.isReturnReason("insufficient_funds"), true);
  for (const x of ["", "nope", null, undefined, 5, "constructor", "__proto__"]) assert.equal(d.isReturnReason(x), false, String(x));
});

test("a bounce needs a reason: words, or a pick from the list - and a legacy {reason} alone still works", () => {
  assert.equal(bad({}).code, "REASON_REQUIRED");
  assert.equal(bad({ reason: "   " }).code, "REASON_REQUIRED");
  assert.equal(bad({ reasonCode: "other" }).code, "REASON_REQUIRED", "'other' says nothing, so it needs words");
  assert.equal(bad({ reasonCode: "nope" }).code, "RETURN_REASON_INVALID");
  assert.equal(bad({ reason: "x".repeat(251) }).code, "REASON_TOO_LONG");
  assert.equal(bad({ reason: "Insufficient funds" }).value.reason, "Insufficient funds");
  const picked = bad({ reasonCode: "account_closed" }).value;
  assert.equal(picked.reason, "Account closed", "a code alone is worded from the list");
  assert.deepEqual(picked.returnMemo, { reasonCode: "account_closed", reasonText: "Account closed" });
  const both = bad({ reasonCode: "technical", reason: "Smudged MICR line" }).value;
  assert.equal(both.reason, "Smudged MICR line", "the person's own words win");
  assert.equal(both.returnMemo.reasonCode, "technical");
});

test("the bank's return memo: a date that is not in the future, and references that are trimmed and capped", () => {
  const ok = bad({ reason: "r", memoDate: "2026-10-25", memoRef: "  RM-77 ", certificateRef: " CERT-1 " }).value;
  assert.equal(ok.returnMemo.memoRef, "RM-77");
  assert.equal(ok.certificateRef, "CERT-1");
  assert.equal(ok.returnMemo.memoDate.toISOString().slice(0, 10), "2026-10-25");
  assert.equal(bad({ reason: "r", memoDate: "garbage" }).code, "INVALID_DATE");
  assert.equal(bad({ reason: "r", memoDate: "2026-12-01" }).code, "INVALID_DATE", "the bank cannot have returned it next month");
  assert.equal(bad({ reason: "r", memoRef: "x".repeat(200) }).value.returnMemo.memoRef.length, 60);
});

test("part paid is a fact, and must be a real part: above zero and below the cheque", () => {
  assert.deepEqual(bad({ reason: "r", partialAmount: 400, partialOn: "2026-10-24" }).value.partialPayment.amount, 400);
  assert.equal(bad({ reason: "r" }).value.partialPayment, null);
  for (const x of [0, -5, "abc", NaN, Infinity]) assert.equal(bad({ reason: "r", partialAmount: x }).code, "INVALID_PARTIAL", String(x));
  assert.equal(bad({ reason: "r", partialAmount: 1000 }).code, "INVALID_PARTIAL", "paid in full did not bounce");
  assert.equal(bad({ reason: "r", partialAmount: 1500 }).code, "INVALID_PARTIAL");
  assert.equal(bad({ reason: "r", partialAmount: 100, partialOn: "garbage" }).code, "INVALID_DATE");
});

test("the bank's charge: a positive amount, an optional tax code that is an id", () => {
  assert.deepEqual(bad({ reason: "r", bankCharge: { amount: "52.5" } }).value.bankCharge, { amount: 52.5, taxCodeId: null });
  assert.equal(bad({ reason: "r", bankCharge: { amount: 52.1234 } }).value.bankCharge.amount, 52.12, "rounded to the fils, not carried as 52.1234");
  for (const x of [0, -1, "x", null, undefined, 1e12]) assert.equal(bad({ reason: "r", bankCharge: { amount: x } }).code, "INVALID_CHARGE", String(x));
  assert.equal(bad({ reason: "r", bankCharge: { amount: 5, taxCodeId: "not-an-id" } }).code, "INVALID_TAX_CODE");
  assert.equal(bad({ reason: "r", bankCharge: { amount: 5, taxCodeId: ACC } }).value.bankCharge.taxCodeId, ACC);
});

test("charging it back to the customer: customers only, with an account to credit", () => {
  const good = bad({ reason: "r", recharge: { amount: 60, accountId: ACC, description: " Bounce fee " } }).value.recharge;
  assert.deepEqual(good, { amount: 60, accountId: ACC, taxCodeId: null, description: "Bounce fee" });
  assert.equal(bad({ reason: "r", recharge: { amount: 60 } }).code, "ACCOUNT_REQUIRED");
  assert.equal(bad({ reason: "r", recharge: { amount: 60, accountId: "short" } }).code, "ACCOUNT_REQUIRED");
  assert.equal(bad({ reason: "r", recharge: { amount: 0, accountId: ACC } }).code, "INVALID_CHARGE");
  const ours = { ...RECEIPT, direction: "payment", partyIsCustomer: false };
  assert.equal(bad({ reason: "r", recharge: { amount: 60, accountId: ACC } }, ours).code, "CHARGE_NOT_APPLICABLE", "our own cheque has no customer to charge");
  assert.ok(bad({ reason: "r", bankCharge: { amount: 60 } }, ours).ok, "but our bank's charge on our own cheque is still a charge");
  const vendorish = { ...RECEIPT, partyIsCustomer: false };
  assert.equal(bad({ reason: "r", recharge: { amount: 60, accountId: ACC } }, vendorish).code, "CHARGE_NOT_APPLICABLE");
});

test("handing a cheque back needs only a reason, and has no charges", () => {
  assert.equal(d.normaliseReturn({}).code, "REASON_REQUIRED");
  assert.equal(d.normaliseReturn({ reason: "x".repeat(251) }).code, "REASON_TOO_LONG");
  assert.equal(d.normaliseReturn({ reason: "Replaced by a new cheque" }).value.reason, "Replaced by a new cheque");
  assert.equal(d.normaliseReturn({ reason: "r", bankCharge: { amount: 5 } }).code, "CHARGE_NOT_APPLICABLE");
  assert.equal(d.normaliseReturn({ reason: "r", recharge: { amount: 5, accountId: ACC } }).code, "CHARGE_NOT_APPLICABLE");
});

test("nothing here asserts a legal consequence: no deadline, no remedy, no 'notice' anywhere in the output", () => {
  const out = JSON.stringify(bad({ reasonCode: "insufficient_funds", memoDate: "2026-10-25", memoRef: "x", certificateRef: "y", partialAmount: 1 }).value);
  assert.doesNotMatch(out, /legal|notice|deadline|prosecut|section|s\.138/i);
});
