const express = require("express");
const { requireFeature } = require("../../middleware/featureGate");
const { authenticateToken, requireRole } = require("../../middleware/authMiddleware");
const c = require("../../controllers/reports/vatReturnController");

// Mounted at /api/v1/vat-return. Reading is open to any signed-in admin; preparing, finalising and
// filing a return needs an admin or super admin.
const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature("vatReturn"));
const canChange = requireRole(["super_admin", "admin"]);

router.get("/return", c.compute);
router.get("/detail", c.detail);
router.get("/returns", c.list);
router.get("/returns/:id", c.get);
router.post("/returns", canChange, c.createDraft);
router.post("/returns/:id/finalize", canChange, c.finalize);
router.post("/returns/:id/file", canChange, c.file);
router.delete("/returns/:id", canChange, c.remove);

module.exports = router;
