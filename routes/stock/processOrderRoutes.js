const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const { requireFeature } = require("../../middleware/featureGate");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const ProcessOrder = require("../../models/modules/processOrderModel");
const c = require("../../controllers/stock/processOrderController");

// Process orders, mounted at /api/v1/process-orders: a product made through steps (in-house or at job workers) and the
// board that shows what is pending, in progress, late, due today or tomorrow. Part of the opt-in Production feature.
// A step can be started and finished by the person it is given to (checked in the controller); everything else that
// changes an order needs inventory.adjust.
const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature("production"));
router.param("id", branchOfDocument(ProcessOrder)); // a head office working across branches acts in the order's own branch

// Fixed paths first: none of these may be read as an id.
router.get("/board", requirePermission("inventory.view"), c.board);
router.get("/assignees", requirePermission("inventory.view"), c.assignees);
router.get("/last-steps", requirePermission("inventory.view"), c.lastSteps);
router.get("/my-work", requirePermission("inventory.view"), c.myWork);
router.get("/analysis", requirePermission("inventory.view"), c.analysis);
router.get("/expense-vouchers", requirePermission("finance.view"), c.expenseVouchers);

router.get("/", requirePermission("inventory.view"), c.list);
router.post("/", requirePermission("inventory.adjust"), c.create);
router.get("/:id", requirePermission("inventory.view"), c.get);
router.get("/:id/activity", requirePermission("inventory.view"), c.activity);
router.put("/:id", requirePermission("inventory.adjust"), c.update);
router.delete("/:id", requirePermission("inventory.adjust"), c.remove);
router.post("/:id/release", requirePermission("inventory.adjust"), c.release);
router.post("/:id/cancel", requirePermission("inventory.adjust"), c.cancel);
router.post("/:id/finish", requirePermission("inventory.adjust"), c.finish);
router.post("/:id/reopen", requirePermission("inventory.adjust"), c.reopen);
router.post("/:id/steps/:stepId/start", requirePermission("inventory.view"), c.startStep);
router.post("/:id/steps/:stepId/complete", requirePermission("inventory.view"), c.completeStep);
router.post("/:id/steps/:stepId/send", requirePermission("inventory.adjust"), c.sendStep);
router.post("/:id/costs", requirePermission("inventory.adjust"), c.addCost);
router.delete("/:id/costs/:costId", requirePermission("inventory.adjust"), c.removeCost);

module.exports = router;
