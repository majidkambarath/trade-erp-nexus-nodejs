const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const c = require("../../controllers/financial/partyAccountController");

// Mounted at /api/v1/accounting, next to accountingSetupRouter. The account form for a Receivable /
// Payable group is a customer / vendor form; these three endpoints back it.
const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();
router.use(authenticateToken);

router.post("/accounts/party", requirePermission("accounts.manage"), c.create);
router.get("/accounts/:id/party", requirePermission(["accounts.view","sales.view","purchase.view"]), c.get);
router.put("/accounts/:id/party", requirePermission("accounts.manage"), c.update);

module.exports = router;
