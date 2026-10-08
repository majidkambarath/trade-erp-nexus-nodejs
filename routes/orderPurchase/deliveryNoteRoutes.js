const express = require("express");
const { requireFeature } = require("../../middleware/featureGate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const DeliveryNote = require("../../models/modules/deliveryNoteModel");
const c = require("../../controllers/orderPurchase/deliveryNoteController");

const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature("deliveryNotes"));
router.param("id", branchOfDocument(DeliveryNote)); // a head office working across branches posts to the document's own branch

// Fixed paths first: none of these may be read as an id.
router.get("/summary", requirePermission("sales.view"), c.summary);
router.get("/uninvoiced", requirePermission("sales.view"), c.uninvoiced);
router.get("/availability", requirePermission("sales.view"), c.availability);
router.get("/from-order/:orderId", requirePermission("sales.view"), c.fromOrder);
router.post("/invoice", requirePermission("sales.approve"), c.invoice); // one sales order for one or more delivered notes

router.get("/", requirePermission("sales.view"), c.list);
router.post("/", requirePermission("sales.create"), c.create);
router.get("/:id", requirePermission("sales.view"), c.get);
router.get("/:id/pick-list", requirePermission("sales.view"), c.pickList);
router.get("/:id/activity", requirePermission("sales.view"), c.activity);
router.put("/:id", requirePermission("sales.edit"), c.update);
router.delete("/:id", requirePermission("sales.delete"), c.remove);

router.post("/:id/dispatch", requirePermission("sales.approve"), c.dispatch);
router.post("/:id/deliver", requirePermission("sales.approve"), c.deliver);
router.post("/:id/cancel", requirePermission("sales.approve"), c.cancel);

module.exports = router;
