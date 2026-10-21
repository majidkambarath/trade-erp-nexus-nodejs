const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const { requireFeature } = require("../../middleware/featureGate");
const c = require("../../controllers/stock/processRouteController");

// Saved routes, mounted at /api/v1/process-routes: a product's materials and steps, from which a new process order is
// planned. A master like an item (organisation-wide). Part of the opt-in Production feature.
const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature("production"));

router.get("/plan", requirePermission("inventory.view"), c.plan); // before /:id
router.get("/", requirePermission("inventory.view"), c.list);
router.post("/", requirePermission("inventory.adjust"), c.create);
router.get("/:id", requirePermission("inventory.view"), c.get);
router.put("/:id", requirePermission("inventory.adjust"), c.update);
router.delete("/:id", requirePermission("inventory.adjust"), c.remove);

module.exports = router;
