const express = require("express");
const { requireFeature } = require("../../middleware/featureGate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const IfrsReportsController = require("../../controllers/reports/ifrsReportsController");

// IFRS statements from the general ledger. Mounted at /api/v1/ifrs.
const router = express.Router();

router.use(authenticateToken);
router.use(requireFeature("ifrsStatements"));
router.use(require("../../middleware/ledgerReady"));

// ?asAt=YYYY-MM-DD[&from=][&compare=prior-year|prior-period|none]
router.get("/financial-position", IfrsReportsController.financialPosition);
// ?from=&to=[&compare=...]
router.get("/profit-or-loss", IfrsReportsController.profitOrLoss);
router.get("/changes-in-equity", IfrsReportsController.changesInEquity);
router.get("/cash-flows", IfrsReportsController.cashFlows);
// ?asAt=YYYY-MM-DD[&compare=...]
router.get("/notes", IfrsReportsController.notes);

module.exports = router;
