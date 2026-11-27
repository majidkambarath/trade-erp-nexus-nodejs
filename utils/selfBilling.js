// A tax invoice the BUYER raises for the supplier (self-billing). Pure rules: no database.
//
// UAE VAT Executive Regulation Art. 59(9): where the recipient agrees to raise the tax invoice for a registered
// supplier, it counts as the supplier's if (a) the recipient is a registrant, (b) the two agree in writing that the
// supplier issues none, (c) it carries every particular of a tax invoice, and (d) the words "Tax Invoice raised by
// buyer" are clearly displayed. Art. 60(4) says the same of a tax credit note, "Tax Credit Note created by buyer".
// Confirm the current text before quoting it as advice.

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A vendor's agreement as a request names it -> undefined (not named), { value } or { error }.
 * Agreed needs the agreement's reference (it is in writing) and the day it starts.
 */
function cleanAgreement(input) {
  if (input === undefined) return undefined;
  if (input === null || input === false) return { value: { agreed: false } };
  if (typeof input !== "object" || Array.isArray(input)) return { error: "Self-billing is a yes or no, a reference and a date." };
  if (input.agreed !== true) return { value: { agreed: false } };
  const agreementRef = typeof input.agreementRef === "string" ? input.agreementRef.trim() : "";
  const from = typeof input.from === "string" ? input.from.trim() : "";
  if (!agreementRef) return { error: "Enter the reference of the written self-billing agreement." };
  if (agreementRef.length > 80) return { error: "The agreement reference is at most 80 characters." };
  const day = YMD.test(from) ? new Date(`${from}T00:00:00.000Z`) : null;
  if (!day || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== from) return { error: "Enter the day the self-billing agreement starts." };
  return { value: { agreed: true, agreementRef, from } };
}

/**
 * Why a document dated `day` may not be raised by us for this supplier, or null when it may.
 *   country        the organisation's
 *   recipientTrn   our own tax number; registered: whether we are registered for VAT on that day
 *   vendor         { vendorName, trn, selfBilling }
 */
function refusal({ country = "AE", recipientTrn = "", registered = true, vendor, day }) {
  const no = (code, message) => ({ code, message });
  if (String(country).toUpperCase() !== "AE") return no("SELF_BILLING_UAE_ONLY", "Self-billed tax invoices follow the UAE's rules and are for organisations in the UAE.");
  if (!vendor) return no("SELF_BILLING_NO_SUPPLIER", "Choose the supplier first.");
  if (!String(recipientTrn).trim() || registered === false) return no("SELF_BILLING_RECIPIENT_NOT_REGISTERED", "Only a business registered for VAT may raise a tax invoice for its supplier: save your tax number first.");
  const agreement = vendor.selfBilling || {};
  if (!agreement.agreed) return no("SELF_BILLING_NOT_AGREED", `There is no written self-billing agreement with ${vendor.vendorName || "this supplier"}. Record it on the supplier first.`);
  if (!String(vendor.trn || "").trim()) return no("SELF_BILLING_SUPPLIER_NOT_REGISTERED", `${vendor.vendorName || "This supplier"} has no tax number: a tax invoice can only be raised for a registered supplier.`);
  if (agreement.from && day && day < agreement.from) return no("SELF_BILLING_BEFORE_AGREEMENT", `The self-billing agreement with ${vendor.vendorName || "this supplier"} starts on ${agreement.from}.`);
  return null;
}

module.exports = { cleanAgreement, refusal };
