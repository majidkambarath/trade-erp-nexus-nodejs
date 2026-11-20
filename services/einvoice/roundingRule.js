// Does this organisation price its sales documents the e-invoice's way (VAT rounded once per tax category and rate: utils/vatRounding.js)?
// Only a UAE organisation that sends its invoices through Wafeq: the books, the printed invoice and the e-invoice must then agree to the fils,
// and Wafeq cannot carry a round-off amount either. Everyone else prices exactly as before.
const { EInvoiceSettings } = require("../../models/modules/einvoiceModels");
const { getTenant } = require("../../utils/tenant");
const orgLocale = require("../../utils/orgLocale");

async function roundsVatByRate(session) {
  if (orgLocale.country() !== "AE") return false;
  const { companyId } = getTenant();
  let q = EInvoiceSettings.findOne({ companyId }).select("enabled provider").lean();
  if (session) q = q.session(session);
  const s = await q;
  return Boolean(s?.enabled && s.provider === "wafeq");
}

module.exports = { roundsVatByRate };
