// What is recorded when a cheque comes back: why, when the bank said so, and what it cost. Pure: no Mongoose, no I/O.
//
// THIS RECORDS FACTS. It deliberately asserts no legal consequence. The memo reference and the bank's certificate
// reference are things an accounts person wants on file; what they mean in law differs by country and has changed
// (the UAE's 2022 cheque reforms; India's Negotiable Instruments Act), and the research behind this module could not
// verify the current text for either. So nothing here computes a legal deadline or says a remedy exists.

const RETURN_REASONS = Object.freeze([
  { code: "insufficient_funds", label: "Insufficient funds" },
  { code: "account_closed", label: "Account closed" },
  { code: "signature_mismatch", label: "Signature differs" },
  { code: "stop_payment", label: "Payment stopped by the drawer" },
  { code: "amount_mismatch", label: "Amount in words and figures differ" },
  { code: "post_dated", label: "Presented before its date" },
  { code: "stale", label: "Stale or out of date" },
  { code: "technical", label: "Technical (damaged, not cleared in time, wrong bank)" },
  { code: "other", label: "Other" },
].map(Object.freeze));

const codes = new Set(RETURN_REASONS.map((r) => r.code));
const isReturnReason = (code) => typeof code === "string" && codes.has(code);
const reasonLabel = (code) => RETURN_REASONS.find((r) => r.code === code)?.label || "";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const fail = (code, message, status = 400) => ({ ok: false, code, message, status });
const text = (v, max) => String(v ?? "").trim().slice(0, max);
const isObjectId = (v) => /^[0-9a-f]{24}$/i.test(String(v || ""));
const day = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };
const MAX_REASON = 250;

// A sum of money: a positive, finite number of at most two decimals' worth (anything else is a mistake, not a rounding).
function money(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1e9) return NaN;
  return round2(n);
}

// A cheque going back to the party before it was ever presented. A reason is all it needs.
function normaliseReturn(input = {}) {
  const reason = text(input.reason, MAX_REASON + 1);
  if (!reason) return fail("REASON_REQUIRED", "Say why the cheque is being handed back");
  if (reason.length > MAX_REASON) return fail("REASON_TOO_LONG", `The reason can be at most ${MAX_REASON} characters`);
  if (input.bankCharge || input.recharge) return fail("CHARGE_NOT_APPLICABLE", "A cheque handed back before it was presented has no bank charge");
  return { ok: true, value: { reason } };
}

// A cheque the bank sent back. `reason` (words) and `reasonCode` (the pick-list) may each be given; one of them must be.
// `ctx`: { amount (the cheque's), direction ("receipt" | "payment"), partyIsCustomer, now }.
function normaliseBounce(input = {}, ctx = {}) {
  const now = ctx.now || new Date();
  const reasonCode = input.reasonCode ? String(input.reasonCode) : "";
  if (reasonCode && !isReturnReason(reasonCode)) return fail("RETURN_REASON_INVALID", "Choose a reason from the list");
  let reason = text(input.reason, MAX_REASON + 1);
  if (!reason && reasonCode && reasonCode !== "other") reason = reasonLabel(reasonCode);
  if (!reason) return fail("REASON_REQUIRED", "Say why the cheque bounced");
  if (reason.length > MAX_REASON) return fail("REASON_TOO_LONG", `The reason can be at most ${MAX_REASON} characters`);

  let memoDate = null;
  if (input.memoDate) {
    memoDate = day(input.memoDate);
    if (!memoDate) return fail("INVALID_DATE", "Enter a valid date for the bank's return memo");
    if (memoDate.getTime() > now.getTime() + 86400000) return fail("INVALID_DATE", "The bank's return memo cannot be dated in the future");
  }
  const memoRef = text(input.memoRef, 60);
  const certificateRef = text(input.certificateRef, 60);

  // What the bank actually paid, if it paid part. Recorded as a fact; the cheque is still reversed in full (see the
  // service), and the part paid is entered as an ordinary receipt.
  let partialPayment = null;
  if (input.partialAmount !== undefined && input.partialAmount !== null && input.partialAmount !== "") {
    const paid = money(input.partialAmount);
    if (Number.isNaN(paid) || paid === null) return fail("INVALID_PARTIAL", "Enter the amount the bank paid, as a number above zero");
    if (ctx.amount > 0 && paid >= ctx.amount) return fail("INVALID_PARTIAL", "The part paid must be less than the cheque's amount; if it was paid in full, it did not bounce");
    const on = input.partialOn ? day(input.partialOn) : null;
    if (input.partialOn && !on) return fail("INVALID_DATE", "Enter a valid date for the part payment");
    partialPayment = { amount: paid, ...(on ? { on } : {}) };
  }

  let bankCharge = null;
  if (input.bankCharge) {
    const amount = money(input.bankCharge.amount);
    if (amount === null || Number.isNaN(amount)) return fail("INVALID_CHARGE", "Enter the bank's charge as a number above zero");
    bankCharge = { amount, taxCodeId: input.bankCharge.taxCodeId ? String(input.bankCharge.taxCodeId) : null };
    if (bankCharge.taxCodeId && !isObjectId(bankCharge.taxCodeId)) return fail("INVALID_TAX_CODE", "Choose a tax code from the list");
  }

  let recharge = null;
  if (input.recharge) {
    if (ctx.direction !== "receipt" || !ctx.partyIsCustomer) return fail("CHARGE_NOT_APPLICABLE", "Only a customer's cheque can be charged back to the customer");
    const amount = money(input.recharge.amount);
    if (amount === null || Number.isNaN(amount)) return fail("INVALID_CHARGE", "Enter the amount to charge the customer as a number above zero");
    if (!isObjectId(input.recharge.accountId)) return fail("ACCOUNT_REQUIRED", "Choose the account the recovered charge is credited to");
    const taxCodeId = input.recharge.taxCodeId ? String(input.recharge.taxCodeId) : null;
    if (taxCodeId && !isObjectId(taxCodeId)) return fail("INVALID_TAX_CODE", "Choose a tax code from the list");
    recharge = { amount, accountId: String(input.recharge.accountId), taxCodeId, description: text(input.recharge.description, 150) };
  }

  return {
    ok: true,
    value: {
      reason,
      returnMemo: { ...(reasonCode ? { reasonCode } : {}), reasonText: reason, ...(memoDate ? { memoDate } : {}), ...(memoRef ? { memoRef } : {}) },
      certificateRef, partialPayment, bankCharge, recharge,
    },
  };
}

module.exports = { RETURN_REASONS, isReturnReason, reasonLabel, normaliseReturn, normaliseBounce };
