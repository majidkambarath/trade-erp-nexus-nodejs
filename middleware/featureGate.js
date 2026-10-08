// Refuses a route whose optional feature is not switched on for the caller's organisation. Put it after
// authenticateToken in a router, which is what puts the organisation on the request. A mistyped feature name
// crashes when the router is loaded rather than letting everyone in.
const AppError = require("../utils/AppError");
const plans = require("../utils/plans");
const { featureError } = require("../services/core/usageService");

const requireFeature = (key) => {
  if (!(key in plans.FEATURES)) throw new Error(`requireFeature("${key}"): not a known feature`);
  return (req, res, next) => {
    if (!req.organisation) return next(new AppError("Authentication required", 401, "AUTH_REQUIRED"));
    if (plans.hasFeature(req.organisation, key)) return next();
    return next(featureError(req.organisation, key));
  };
};

module.exports = { requireFeature };
