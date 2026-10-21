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
  return { country: c, tax, taxId };
}

// A starter account's name in the organisation's own words: "Input VAT" is "Input GST" in India, "Input Tax" where
// there is neither. The posting map finds accounts by key, never by name, so only what people read changes.
const localAccountName = (name, country) => {
  const { tax } = taxTerms(country);
  return tax === "VAT" ? name : String(name).replace(/\bVAT\b/g, tax);
};

// The terms of the organisation in scope (a service raising a message reads them here).
const orgTaxTerms = () => taxTerms(require("./orgLocale").country());

module.exports = { UAE_ONLY_FEATURES, countryOf, featureAppliesIn, countryFeatures, hasCountryFeature, taxTerms, orgTaxTerms, localAccountName };
