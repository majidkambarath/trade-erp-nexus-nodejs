const express = require("express");
const { authenticateToken } = require("../middleware/authMiddleware");
const LedgerController = require("../controllers/ledgerController");

const { requirePermission } = require("../middleware/permissionGate");
const router = express.Router();

router.use(authenticateToken);

router.get("/parties", requirePermission(["finance.view","reports.financial"]), LedgerController.getAllParties);

// SEPARATE PAGES
router.get("/debit-accounts", requirePermission(["finance.view","reports.financial"]), LedgerController.getDebitAccounts);   // Vendors only
router.get("/credit-accounts", requirePermission(["finance.view","reports.financial"]), LedgerController.getCreditAccounts); // Customers only

// Full ledger
router.get("/ledger/vendor/:id", requirePermission(["finance.view","reports.financial"]), LedgerController.getPartyLedger);
router.get("/ledger/customer/:id", requirePermission(["finance.view","reports.financial"]), LedgerController.getPartyLedger);
module.exports = router;