const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const C = require("../../controllers/reports/tradeReportsController");

// Trade reports, mounted at /api/v1/trade-reports. Read-only.
//   summary        sales or purchases by party, item, party and item, or month (optionally a column per month)
//   register       the same documents line by line
//   party-movement receivables or payables per party for a period: opening, invoiced, returns, received / paid, closing
const router = express.Router();
router.use(authenticateToken);
router.use(require("../../middleware/ledgerReady"));

router.get("/summary", requirePermission("reports.view"), C.summary); // ?direction=sales|purchases&from=&to=&groupBy=party|item|party_item|month&partyId=&itemId=&categoryId=&search=&monthly=
router.get("/register", requirePermission("reports.view"), C.register); // ?direction=&from=&to=&partyId=&itemId=&categoryId=&search=&page=&limit=
router.get("/party-movement", requirePermission(["reports.financial", "finance.view"]), C.partyMovement); // ?type=customer|vendor&from=&to=&search=&includeZero=

module.exports = router;
