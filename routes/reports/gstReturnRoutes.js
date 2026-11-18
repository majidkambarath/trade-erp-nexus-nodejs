const express = require("express");
const AppError = require("../../utils/AppError");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const { hasGstReturn } = require("../../utils/countryRules");
const c = require("../../controllers/reports/gstReturnController");

// Mounted at /api/v1/gst-return. India's GSTR-1 and GSTR-3B, read live from the approved documents.
// The permission is checked FIRST on every route (a person who may not read the financial reports is told so, whatever the
// organisation's country); only then is it asked whether this organisation files GST returns at all.
const router = express.Router();
router.use(authenticateToken);

const forIndia = (req, res, next) => {
  if (!req.organisation) return next(new AppError("Authentication required", 401, "AUTH_REQUIRED"));
  if (hasGstReturn(req.organisation)) return next();
  const india = String(req.organisation.country || "").toUpperCase() === "IN";
  return next(
    india
      ? new AppError("The tax return is not included in this organisation's plan.", 403, "FEATURE_NOT_IN_PLAN", { feature: "vatReturn" })
      : new AppError("The GST returns are for organisations in India.", 403, "FEATURE_NOT_FOR_COUNTRY", { feature: "gstReturn", country: req.organisation.country })
  );
};

router.get("/gstr1", requirePermission("reports.financial"), forIndia, c.gstr1);
router.get("/gstr3b", requirePermission("reports.financial"), forIndia, c.gstr3b);

module.exports = router;
