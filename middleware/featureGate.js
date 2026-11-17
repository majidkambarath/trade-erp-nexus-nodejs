// Refuses a route whose optional feature is not switched on for the caller's organisation. Put it after
// authenticateToken in a router, which is what puts the organisation on the request. A mistyped feature name
// crashes when the router is loaded rather than letting everyone in.
const AppError = require("../utils/AppError");
const plans = require("../utils/plans");
const { featureError } = require("../services/core/usageService");
const { hasCountryFeature } = require("../utils/countryRules");
const VatRegistrationService = require("../services/financial/vatRegistrationService");

const requireFeature = (key) => {
  if (!(key in plans.FEATURES)) throw new Error(`requireFeature("${key}"): not a known feature`);
  return async (req, res, next) => {
    if (!req.organisation) return next(new AppError("Authentication required", 401, "AUTH_REQUIRED"));
    if (!hasCountryFeature(req.organisation, key)) return next(featureError(req.organisation, key)); // not in the plan, or not for this country
    // the VAT return is for an organisation that IS registered for VAT: the return reports the tax it charged and claimed
    if (key === "vatReturn") {
      try {
        const vat = await VatRegistrationService.stateOn(new Date());
        if (vat.governs && !vat.registered) {
          return next(new AppError("The VAT return is for VAT-registered organisations. Save the company's tax number under Settings > Business rules > Tax identity first.", 403, "VAT_NOT_REGISTERED"));
        }
      } catch (error) {
        return next(error);
      }
    }
    return next();
  };
};

module.exports = { requireFeature };
