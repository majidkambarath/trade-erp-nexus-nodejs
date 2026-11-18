const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const C = require("../../controllers/reports/stockReportsController");

// Stock reports, mounted at /api/v1/stock-reports. Read-only.
const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();
router.use(authenticateToken);
router.use(require("../../middleware/ledgerReady"));
// The cost and margin reports below need inventory.viewCost (slow stock is ranked and totalled by value at cost); the others (expiry, reorder, lookups) lose any cost column for a caller without it.
// (on the expiry and reorder reports `value` / `shortfallValue` / `stockValue` are cost figures: value at cost, shortfall at cost)
router.use(require("../../middleware/costVisibility").hideCost({ movements: true, extra: ["value", "shortfallValue", "pctOfStockValue", "stockValue"] }));

router.get("/lookups", requirePermission(["reports.view","inventory.view"]), C.lookups); // items and categories for the filters
router.get("/valuation", requirePermission("inventory.viewCost"), C.valuation); // ?asOn=&categoryId=&search=&groupBy=item|category&includeZero=
router.get("/ledger-check", requirePermission("inventory.viewCost"), C.ledgerCheck); // ?asOn= - the valuation's comparison with the Inventory account, as at a day
router.get("/movement", requirePermission("inventory.viewCost"), C.movement); // ?from=&to=&categoryId=&search=&includeZero=
router.get("/item-ledger", requirePermission("inventory.viewCost"), C.itemLedger); // ?itemId=&from=&to=
router.get("/sales-analysis", requirePermission("inventory.viewCost"), C.salesAnalysis); // ?from=&to=&groupBy=item|category|customer&direction=sales|purchases
router.get("/expiry", requirePermission("reports.view"), C.expiry); // ?withinDays=30
router.get("/slow-moving", requirePermission("inventory.viewCost"), C.slowMoving); // ?days=90
router.get("/reorder", requirePermission("reports.view"), C.reorder);

module.exports = router;
