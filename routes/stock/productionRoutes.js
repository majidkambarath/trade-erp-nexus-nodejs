const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const { requireFeature } = require("../../middleware/featureGate");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const ProductionOrder = require("../../models/modules/productionOrderModel");
const c = require("../../controllers/stock/productionController");

// Productions, mounted at /api/v1/productions: materials used up and expenses moved into the cost of the item made.
// Stock rights decide the route; a production with cost lines also needs finance rights (checked in the controller).
const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature("production")); // opt-in per organisation (utils/plans.js): off unless the developer switched it on
router.param("id", branchOfDocument(ProductionOrder)); // a head office working across branches acts in the production's own branch

// Fixed paths first: none of these may be read as an id.
router.get("/cost-report", requirePermission(["inventory.view", "reports.view"]), c.costReport);

router.get("/", requirePermission("inventory.view"), c.list);
router.post("/", requirePermission("inventory.adjust"), c.create);
router.get("/:id", requirePermission("inventory.view"), c.get);
router.get("/:id/activity", requirePermission("inventory.view"), c.activity);
router.put("/:id", requirePermission("inventory.adjust"), c.update);
router.delete("/:id", requirePermission("inventory.adjust"), c.remove);
router.post("/:id/post", requirePermission("inventory.adjust"), c.post);
router.post("/:id/reverse", requirePermission("inventory.adjust"), c.reverse);

module.exports = router;
