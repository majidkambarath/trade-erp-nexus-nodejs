const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const C = require("../../controllers/reports/stockReportsController");

// Stock reports, mounted at /api/v1/stock-reports. Read-only.
const router = express.Router();
router.use(authenticateToken);
router.use(require("../../middleware/ledgerReady"));

router.get("/lookups", C.lookups); // items and categories for the filters
router.get("/valuation", C.valuation); // ?asOn=&categoryId=&search=&groupBy=item|category&includeZero=
router.get("/movement", C.movement); // ?from=&to=&categoryId=&search=&includeZero=
router.get("/item-ledger", C.itemLedger); // ?itemId=&from=&to=
router.get("/sales-analysis", C.salesAnalysis); // ?from=&to=&groupBy=item|category|customer&direction=sales|purchases
router.get("/expiry", C.expiry); // ?withinDays=30
router.get("/slow-moving", C.slowMoving); // ?days=90
router.get("/reorder", C.reorder);

module.exports = router;
