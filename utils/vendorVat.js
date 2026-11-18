// A purchase bill that carries tax from a supplier who is not registered for it. Pure, no database.
//
// A supplier that is not registered for VAT / GST cannot charge it, and the tax on such a bill cannot be recovered as input tax. Nothing here
// refuses the bill - suppliers get registered, rates are mistyped, a TRN is simply not on file yet - but approving it posts the tax to Input VAT
// as a claim, so the person is told first and has to say they mean it (the same shape as the credit-limit warning).
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (n) => Number(n) || 0;

const ACK_FIELD = "riskAck_unregistered_vendor_vat";

// Is this supplier registered? An explicit status wins ("registered", "designated_zone" and "exempt" are not "unregistered"); with no status stored a tax
// number on file means registered and none means not (the rule utils/partyMaster.js resolveVat uses when a status is not given).
function vendorIsUnregistered(vendor) {
  const status = String(vendor?.vat?.status || "").toLowerCase();
  if (status) return status === "unregistered";
  return !(vendor?.vat?.trn || vendor?.trnNO);
}

// The tax a bill charges: the lines' and the charges', not the self-assessed tax of a reverse-charge line (the supplier charged none).
function taxCharged(doc) {
  const p = doc?.pricing;
  if (p && (p.lineVat !== undefined || p.chargesVat !== undefined)) return round2(num(p.lineVat) + num(p.chargesVat));
  const lines = (doc?.items || []).reduce((t, i) => t + num(i.vatAmount), 0);
  const charges = (doc?.charges || []).reduce((t, c) => t + num(c.vatAmount), 0);
  return round2(lines + charges);
}

/**
 * -> null (nothing to say) or { tax, message }
 * Only a purchase bill, only when the organisation will claim the tax (a bill stamped vatRegistered === false posts it as cost, so there is
 * no claim to warn about), only when it really carries tax and the supplier is not registered.
 */
function unregisteredVendorWarning({ doc, vendor, taxName = "VAT", currency = "AED" }) {
  if (!doc || doc.type !== "purchase_order" || doc.isOpening) return null;
  if (doc.vatRegistered === false) return null;
  const tax = taxCharged(doc);
  if (!(tax > 0.005)) return null;
  if (!vendorIsUnregistered(vendor)) return null;
  const name = vendor?.vendorName || "This supplier";
  return {
    tax,
    message: `${name} is not registered for ${taxName}, but this bill charges ${taxName} of ${currency} ${tax.toFixed(2)}. A supplier that is not registered cannot charge ${taxName}, and it cannot be claimed back as input tax. Check the supplier's invoice and tax number first.`,
  };
}

module.exports = { ACK_FIELD, vendorIsUnregistered, taxCharged, unregisteredVendorWarning };
