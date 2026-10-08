const express = require("express");
const { requireFeature } = require("../../middleware/featureGate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const c = require("../../controllers/reports/vatReturnController");

// Mounted at /api/v1/vat-return. Reading is open to any signed-in admin; preparing, finalising and
// filing a return needs an admin or super admin.
const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature("vatReturn"));

router.get("/return", requirePermission("reports.financial"), c.compute);
router.get("/detail", requirePermission("reports.financial"), c.detail);
router.get("/returns", requirePermission("reports.financial"), c.list);
router.get("/returns/:id", requirePermission("reports.financial"), c.get);
router.post("/returns", requirePermission("reports.vat"), c.createDraft);
router.post("/returns/:id/finalize", requirePermission("reports.vat"), c.finalize);
router.post("/returns/:id/file", requirePermission("reports.vat"), c.file);
router.delete("/returns/:id", requirePermission("reports.vat"), c.remove);

module.exports = router;
