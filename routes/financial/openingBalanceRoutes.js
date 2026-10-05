const express = require("express");
const { authenticateToken, requireRole } = require("../../middleware/authMiddleware");
const c = require("../../controllers/financial/openingBalanceController");

// Mounted at /api/v1/opening-balances. Reading is open to any signed-in admin; posting or
// reversing an opening balance needs an admin or super admin, like the rest of the accounting setup.
const router = express.Router();
router.use(authenticateToken);
const canChange = requireRole(["super_admin", "admin"]);

router.get("/summary", c.summary);
router.put("/go-live", canChange, c.setGoLive);

router.get("/accounts", c.listAccounts);
router.post("/accounts", canChange, c.postAccounts);
router.delete("/accounts/:id", canChange, c.reverseAccounts);

router.get("/parties", c.listParties); // ?type=customer|vendor
router.post("/parties", canChange, c.postParties);
router.delete("/parties/:id", canChange, c.reverseParty);

router.get("/stock", c.listStock);
router.post("/stock", canChange, c.postStock);
router.delete("/stock/:id", canChange, c.reverseStock);

module.exports = router;
