const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const C = require("../../controllers/reports/stockReportsController");

// Stock reports, mounted at /api/v1/stock-reports. Read-only.
const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();
router.use(authenticateToken);
router.use(require("../../middleware/ledgerReady"));

router.get("/lookups", requirePermission(["reports.view","inventory.view"]), C.lookups); // items and categories for the filters
router.get("/valuation", requirePermission("reports.view"), C.valuation); // ?asOn=&categoryId=&search=&groupBy=item|category&includeZero=
router.get("/movement", requirePermission("reports.view"), C.movement); // ?from=&to=&categoryId=&search=&includeZero=
router.get("/item-ledger", requirePermission("reports.view"), C.itemLedger); // ?itemId=&from=&to=
router.get("/sales-analysis", requirePermission("reports.view"), C.salesAnalysis); // ?from=&to=&groupBy=item|category|customer&direction=sales|purchases
router.get("/expiry", requirePermission("reports.view"), C.expiry); // ?withinDays=30
router.get("/slow-moving", requirePermission("reports.view"), C.slowMoving); // ?days=90
router.get("/reorder", requirePermission("reports.view"), C.reorder);

module.exports = router;
