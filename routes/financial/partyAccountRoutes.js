const express = require("express");
const { authenticateToken, requireRole } = require("../../middleware/authMiddleware");
const c = require("../../controllers/financial/partyAccountController");

// Mounted at /api/v1/accounting, next to accountingSetupRouter. The account form for a Receivable /
// Payable group is a customer / vendor form; these three endpoints back it.
const router = express.Router();
router.use(authenticateToken);
const canChange = requireRole(["super_admin", "admin"]);

router.post("/accounts/party", canChange, c.create);
router.get("/accounts/:id/party", c.get);
router.put("/accounts/:id/party", canChange, c.update);

module.exports = router;
