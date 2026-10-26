// What depends on the ORGANISATION's country rather than its plan (pure). The UAE VAT return (the FTA's VAT 201) and
// UAE e-invoicing (PINT AE) are built for the UAE's law only: another country's organisation never sees them, whatever
// its plan or overrides say - it needs its own return and format, not the UAE's. The plan decides what was bought;
// this decides what can apply where (utils/plans.js stays the same for every country).
const plans = require("./plans");

const UAE_ONLY_FEATURES = Object.freeze(["vatReturn", "einvoicing"]);

const countryOf = (org) => String(org?.country || "AE").toUpperCase();
const featureAppliesIn = (country, key) => !UAE_ONLY_FEATURES.includes(key) || String(country || "AE").toUpperCase() === "AE";

// The plan's features, less what does not apply in the organisation's country.
function countryFeatures(org) {
  const features = plans.effectiveFeatures(org);
  const country = countryOf(org);
  return Object.fromEntries(Object.entries(features).map(([k, on]) => [k, Boolean(on) && featureAppliesIn(country, k)]));
}

const hasCountryFeature = (org, key) => plans.hasFeature(org, key) && featureAppliesIn(countryOf(org), key);

// What the tax and its registration number are called where the organisation is. The UAE (and the other VAT countries)
// say VAT and, in the UAE, TRN; India says GST and GSTIN. Everything a person reads goes through this, so an Indian
// organisation never sees "VAT" or "TRN". The frontend twin is trade erp/src/lib/taxTerms.js.
const GST_COUNTRIES = new Set(["IN", "SG", "AU", "NZ"]);
const VAT_COUNTRIES = new Set(["AE", "SA", "BH", "OM", "GB", "IE", "DE", "FR", "NL", "BE", "IT", "ES", "PT", "AT", "SE", "DK", "FI", "PL", "CY", "MT", "ZA", "EG"]);
function taxTerms(country = "AE") {
  const c = String(country || "AE").toUpperCase();
  const tax = GST_COUNTRIES.has(c) ? "GST" : VAT_COUNTRIES.has(c) ? "VAT" : "Tax";
  const taxId = c === "AE" ? "TRN" : c === "IN" ? "GSTIN" : tax === "Tax" ? "Tax no." : `${tax} no.`;
  // The tax written out, for a heading or a sentence that cannot use the initials, and who the tax is owed to.
  // Only the UAE's authority is named: "the tax authority" is true everywhere else and claims nothing we do not know.
  const taxName = tax === "GST" ? "Goods and services tax" : tax === "VAT" ? "Value added tax" : "Tax";
  const authority = c === "AE" ? "the Federal Tax Authority" : "the tax authority";
  return { country: c, tax, taxId, taxName, authority };
}

// A starter account's name in the organisation's own words: "Input VAT" is "Input GST" in India, "Input Tax" where
// there is neither. The posting map finds accounts by key, never by name, so only what people read changes.
const localAccountName = (name, country) => {
  const { tax } = taxTerms(country);
  return tax === "VAT" ? name : String(name).replace(/\bVAT\b/g, tax);
};

// How long a cheque is good for after the date written on it, in days. Past it, a cheque is "stale" and the bank may
// refuse it: the register will not accept one, and warns before one goes stale.
//
// ONE VALUE, ON PURPOSE. 183 days (six months) is what this system has always used and it is kept for every country. No
// other country has its own value because none could be VERIFIED: the research behind the cheque lifecycle could not
// confirm the current UAE cheque-law text, and found India's 3-month Reserve Bank rule INDETERMINATE after 28 Nov 2025.
// A wrong number here would refuse a good cheque or wave through a stale one, so a country is added to this table only
// once its value is confirmed from the primary source - a one-line change. This is a convenience for the accounts
// person, not legal advice.
const CHEQUE_VALIDITY_DAYS = Object.freeze({ default: 183 });
const chequeValidityDays = (country) => CHEQUE_VALIDITY_DAYS[String(country || "AE").toUpperCase()] ?? CHEQUE_VALIDITY_DAYS.default;

// The terms of the organisation in scope (a service raising a message reads them here).
const orgTaxTerms = () => taxTerms(require("./orgLocale").country());

module.exports = { UAE_ONLY_FEATURES, countryOf, featureAppliesIn, countryFeatures, hasCountryFeature, taxTerms, orgTaxTerms, localAccountName, CHEQUE_VALIDITY_DAYS, chequeValidityDays };
