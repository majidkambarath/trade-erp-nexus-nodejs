const express = require("express");
const c = require("../../controllers/banking/reconciliationController");

// Mounted inside bankingRoutes (so under /api/v1/banking/reconciliation, which is registered before
// adminRouter and behind authenticateToken). Anyone signed in can read; changing needs an admin.
const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();

router.get("/accounts", requirePermission("banking.view"), c.accounts);
router.get("/setup/preview", requirePermission("banking.view"), c.setupPreview);
router.get("/setup/status", requirePermission("banking.view"), c.setupStatus);
router.put("/setup", requirePermission("banking.reconcile"), c.saveSetup);
router.get("/profile", requirePermission("banking.view"), c.profile);

router.post("/import/preview", requirePermission("banking.reconcile"), c.previewImport);
router.post("/import", requirePermission("banking.reconcile"), c.importStatement);
router.get("/imports", requirePermission("banking.view"), c.imports);
router.delete("/imports/:id", requirePermission("banking.reconcile"), c.voidImport);

router.get("/lines", requirePermission("banking.view"), c.lines);
router.get("/entries", requirePermission("banking.view"), c.entries);
router.get("/lines/:id/allocation", requirePermission("banking.view"), c.allocation);
router.post("/lines/:id/ignore", requirePermission("banking.reconcile"), c.ignore);
router.post("/lines/:id/unignore", requirePermission("banking.reconcile"), c.unignore);
router.post("/lines/:id/create", requirePermission("banking.reconcile"), c.createFromLine);

router.post("/matches", requirePermission("banking.reconcile"), c.match);
router.post("/matches/accept", requirePermission("banking.reconcile"), c.accept);
router.delete("/matches/:id", requirePermission("banking.reconcile"), c.unmatch);

router.get("/proof", requirePermission("banking.view"), c.proof);
router.post("/reconciliations", requirePermission("banking.reconcile"), c.finish);
router.get("/reconciliations", requirePermission("banking.view"), c.reconciliations);
router.get("/reconciliations/:id", requirePermission("banking.view"), c.reconciliation);
router.post("/reconciliations/:id/reopen", requirePermission("banking.reconcile"), c.reopen);

router.get("/card/unsettled", requirePermission("banking.view"), c.cardUnsettled);
router.post("/card/settle", requirePermission("banking.reconcile"), c.cardSettle);
router.get("/card/settlements", requirePermission("banking.view"), c.cardSettlements);
router.get("/card/variance", requirePermission("banking.view"), c.cardVariance);
router.get("/card/ageing", requirePermission("banking.view"), c.cardAgeing);

module.exports = router;
