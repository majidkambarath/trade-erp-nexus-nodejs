const express = require("express");
const { requireRole } = require("../../middleware/authMiddleware");
const c = require("../../controllers/banking/reconciliationController");

// Mounted inside bankingRoutes (so under /api/v1/banking/reconciliation, which is registered before
// adminRouter and behind authenticateToken). Anyone signed in can read; changing needs an admin.
const router = express.Router();
const canChange = requireRole(["super_admin", "admin"]);

router.get("/accounts", c.accounts);
router.get("/setup/preview", c.setupPreview);
router.get("/setup/status", c.setupStatus);
router.put("/setup", canChange, c.saveSetup);
router.get("/profile", c.profile);

router.post("/import/preview", canChange, c.previewImport);
router.post("/import", canChange, c.importStatement);
router.get("/imports", c.imports);
router.delete("/imports/:id", canChange, c.voidImport);

router.get("/lines", c.lines);
router.get("/entries", c.entries);
router.get("/lines/:id/allocation", c.allocation);
router.post("/lines/:id/ignore", canChange, c.ignore);
router.post("/lines/:id/unignore", canChange, c.unignore);
router.post("/lines/:id/create", canChange, c.createFromLine);

router.post("/matches", canChange, c.match);
router.post("/matches/accept", canChange, c.accept);
router.delete("/matches/:id", canChange, c.unmatch);

router.get("/proof", c.proof);
router.post("/reconciliations", canChange, c.finish);
router.get("/reconciliations", c.reconciliations);
router.get("/reconciliations/:id", c.reconciliation);
router.post("/reconciliations/:id/reopen", canChange, c.reopen);

router.get("/card/unsettled", c.cardUnsettled);
router.post("/card/settle", canChange, c.cardSettle);
router.get("/card/settlements", c.cardSettlements);
router.get("/card/variance", c.cardVariance);
router.get("/card/ageing", c.cardAgeing);

module.exports = router;
