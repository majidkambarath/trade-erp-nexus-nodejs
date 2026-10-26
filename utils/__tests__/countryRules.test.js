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
  assert.deepEqual(R.taxTerms("AE"), { country: "AE", tax: "VAT", taxId: "TRN", taxName: "Value added tax", authority: "the Federal Tax Authority" });
  assert.deepEqual(R.taxTerms("in"), { country: "IN", tax: "GST", taxId: "GSTIN", taxName: "Goods and services tax", authority: "the tax authority" });
  assert.deepEqual(R.taxTerms("GB"), { country: "GB", tax: "VAT", taxId: "VAT no.", taxName: "Value added tax", authority: "the tax authority" });
  assert.deepEqual(R.taxTerms("SG"), { country: "SG", tax: "GST", taxId: "GST no.", taxName: "Goods and services tax", authority: "the tax authority" });
  assert.deepEqual(R.taxTerms("JP"), { country: "JP", tax: "Tax", taxId: "Tax no.", taxName: "Tax", authority: "the tax authority" });
  assert.deepEqual(R.taxTerms(), R.taxTerms("AE"));
});

test("only the UAE's tax authority is named; everywhere else it is 'the tax authority'", () => {
  assert.equal(R.taxTerms("AE").authority, "the Federal Tax Authority");
  for (const c of ["IN", "GB", "SA", "SG", "JP"]) assert.equal(R.taxTerms(c).authority, "the tax authority", c);
});

test("starter account names in the organisation's words; whole words only", () => {
  assert.equal(R.localAccountName("Input VAT", "IN"), "Input GST");
  assert.equal(R.localAccountName("Reverse-charge VAT", "IN"), "Reverse-charge GST");
  assert.equal(R.localAccountName("Output VAT", "AE"), "Output VAT");
  assert.equal(R.localAccountName("Output VAT", "JP"), "Output Tax");
  assert.equal(R.localAccountName("Cash in Hand", "IN"), "Cash in Hand");
  assert.equal(R.localAccountName("VATable sales", "IN"), "VATable sales", "not inside another word");
});

test("cheque validity: six months (183 days) everywhere, because no other country's value is verified", () => {
  const { chequeValidityDays, CHEQUE_VALIDITY_DAYS } = require("../countryRules");
  assert.equal(chequeValidityDays("AE"), 183, "what the register has always used");
  for (const c of ["IN", "in", "SA", "GB", "XX", "", null, undefined]) assert.equal(chequeValidityDays(c), 183, String(c));
  assert.ok(Object.isFrozen(CHEQUE_VALIDITY_DAYS));
  assert.deepEqual(Object.keys(CHEQUE_VALIDITY_DAYS), ["default"], "a country is added here only once its value is confirmed from the primary source");
  for (const k of ["constructor", "__proto__", "toString"]) assert.equal(chequeValidityDays(k), 183, k);
});
