const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const { requireFeature } = require("../../middleware/featureGate");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const JobWorkOrder = require("../../models/modules/jobWorkOrderModel");
const c = require("../../controllers/stock/jobWorkController");

// Job work (subcontracting), mounted at /api/v1/job-work: our parts sent to an outside job worker on a challan and
// received back finished (each receipt posts a Production). Part of the opt-in Production feature.
const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature("production"));
router.param("id", branchOfDocument(JobWorkOrder)); // a head office working across branches acts in the job's own branch

// Fixed paths first: none of these may be read as an id.
router.get("/with-job-worker", requirePermission(["inventory.view", "lookups.view"]), c.withJobWorker);

router.get("/", requirePermission("inventory.view"), c.list);
router.post("/", requirePermission("inventory.adjust"), c.create);
router.get("/:id", requirePermission("inventory.view"), c.get);
router.get("/:id/activity", requirePermission("inventory.view"), c.activity);
router.put("/:id", requirePermission("inventory.adjust"), c.update);
router.delete("/:id", requirePermission("inventory.adjust"), c.remove);
router.post("/:id/send", requirePermission("inventory.adjust"), c.send);
router.post("/:id/cancel", requirePermission("inventory.adjust"), c.cancel);
router.post("/:id/receive", requirePermission("inventory.adjust"), c.receive);
router.post("/:id/receipts/:receiptId/reverse", requirePermission("inventory.adjust"), c.reverseReceipt);

module.exports = router;
