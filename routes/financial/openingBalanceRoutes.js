const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const c = require("../../controllers/financial/openingBalanceController");

// Mounted at /api/v1/opening-balances. Reading is open to any signed-in admin; posting or
// reversing an opening balance needs an admin or super admin, like the rest of the accounting setup.
const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();
router.use(authenticateToken);

router.get("/summary", requirePermission("accounts.view"), c.summary);
router.put("/go-live", requirePermission("accounts.manage"), c.setGoLive);

router.get("/accounts", requirePermission("accounts.view"), c.listAccounts);
router.post("/accounts", requirePermission("accounts.manage"), c.postAccounts);
router.delete("/accounts/:id", requirePermission("accounts.manage"), c.reverseAccounts);

router.get("/parties", requirePermission("accounts.view"), c.listParties); // ?type=customer|vendor
router.post("/parties", requirePermission("accounts.manage"), c.postParties);
router.delete("/parties/:id", requirePermission("accounts.manage"), c.reverseParty);

router.get("/stock", requirePermission("accounts.view"), c.listStock);
router.post("/stock", requirePermission("accounts.manage"), c.postStock);
router.delete("/stock/:id", requirePermission("accounts.manage"), c.reverseStock);

module.exports = router;
