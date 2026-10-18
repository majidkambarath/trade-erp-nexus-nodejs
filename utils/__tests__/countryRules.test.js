// What follows the organisation's country rather than its plan (utils/countryRules.js): the UAE-only features, and what
// the tax and its registration number are called.
const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../countryRules");

test("the UAE VAT return and UAE e-invoicing apply in the UAE only, whatever the plan", () => {
  const premium = (country) => ({ planCode: "premium", country });
  assert.equal(R.countryFeatures(premium("AE")).vatReturn, true);
  assert.equal(R.countryFeatures(premium("AE")).einvoicing, true);
  assert.equal(R.countryFeatures(premium("IN")).vatReturn, false);
  assert.equal(R.countryFeatures(premium("IN")).einvoicing, false);
  assert.equal(R.countryFeatures(premium("IN")).banking, true, "everything else is the plan's");
  assert.equal(R.hasCountryFeature({ planCode: "premium", country: "IN", featureOverrides: { vatReturn: true } }, "vatReturn"), false, "an override cannot switch it on elsewhere");
  assert.equal(R.hasCountryFeature({ planCode: "premium" }, "vatReturn"), true, "no country reads as the UAE, as before");
});

test("the words: VAT and TRN in the UAE, GST and GSTIN in India, VAT or Tax elsewhere", () => {
  assert.deepEqual(R.taxTerms("AE"), { country: "AE", tax: "VAT", taxId: "TRN" });
  assert.deepEqual(R.taxTerms("in"), { country: "IN", tax: "GST", taxId: "GSTIN" });
  assert.deepEqual(R.taxTerms("GB"), { country: "GB", tax: "VAT", taxId: "VAT no." });
  assert.deepEqual(R.taxTerms("SG"), { country: "SG", tax: "GST", taxId: "GST no." });
  assert.deepEqual(R.taxTerms("JP"), { country: "JP", tax: "Tax", taxId: "Tax no." });
  assert.deepEqual(R.taxTerms(), R.taxTerms("AE"));
});

test("starter account names in the organisation's words; whole words only", () => {
  assert.equal(R.localAccountName("Input VAT", "IN"), "Input GST");
  assert.equal(R.localAccountName("Reverse-charge VAT", "IN"), "Reverse-charge GST");
  assert.equal(R.localAccountName("Output VAT", "AE"), "Output VAT");
  assert.equal(R.localAccountName("Output VAT", "JP"), "Output Tax");
  assert.equal(R.localAccountName("Cash in Hand", "IN"), "Cash in Hand");
  assert.equal(R.localAccountName("VATable sales", "IN"), "VATable sales", "not inside another word");
});
