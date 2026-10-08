const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const C = require("../../controllers/reports/dashboardController");

// The home dashboard, mounted at /api/v1/dashboard-summary. Read-only; every figure comes from an
// existing report or from one grouped query on the same data (services/reports/dashboardService.js).
// One part per tab, all taking ?period=week|month|quarter (default month), ?month=YYYY-MM or ?from=&to=.
const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();
router.use(authenticateToken);
router.use(require("../../middleware/ledgerReady"));

router.get("/", requirePermission("reports.view"), C.summary); // header figures, ops status, trend, top product, VAT, attention, recent activity
router.get("/analytics", requirePermission("reports.view"), C.analytics); // the charts under them on the Dashboard tab
router.get("/sales", requirePermission("reports.view"), C.sales); // Sales tab
router.get("/inventory", requirePermission("reports.view"), C.inventory); // Inventory tab
router.get("/reports", requirePermission("reports.view"), C.reports); // Reports tab

module.exports = router;
