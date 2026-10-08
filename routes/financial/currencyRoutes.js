const express = require("express");
const { requireFeature } = require("../../middleware/featureGate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const c = require("../../controllers/financial/currencyController");

const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature("currencies"));

// Anyone signed in can read the currencies and rates (the voucher forms need them); changing them
// needs an admin or super admin, as with the other masters.

router.get("/", requirePermission(["accounts.view","lookups.view"]), c.list);
router.post("/", requirePermission("accounts.manage"), c.create);

// One-segment paths first, so they are never read as a currency code
router.get("/rate", requirePermission(["accounts.view","lookups.view"]), c.rate);
router.get("/register", requirePermission(["reports.financial","accounts.view"]), c.register);
router.get("/settings", requirePermission(["accounts.view","lookups.view"]), c.getSettings);
router.put("/settings", requirePermission("accounts.manage"), c.updateSettings);

router.get("/:code/rates", requirePermission(["accounts.view","lookups.view"]), c.rates);
router.post("/:code/rates", requirePermission("accounts.manage"), c.addRate);
router.put("/:code", requirePermission("accounts.manage"), c.update);
router.delete("/:code", requirePermission("accounts.manage"), c.remove);

module.exports = router;
