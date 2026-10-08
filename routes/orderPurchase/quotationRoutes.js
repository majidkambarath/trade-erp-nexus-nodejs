const express = require("express");
const { requireFeature } = require("../../middleware/featureGate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const Quotation = require("../../models/modules/quotationModel");
const c = require("../../controllers/orderPurchase/quotationController");

const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature("quotations"));
router.param("id", branchOfDocument(Quotation)); // a head office working across branches posts to the document's own branch

// Fixed paths first: "/summary" must not be read as an id.
router.get("/summary", requirePermission("sales.view"), c.summary);
router.get("/", requirePermission("sales.view"), c.list);
router.post("/", requirePermission("sales.create"), c.create);
router.get("/:id", requirePermission("sales.view"), c.get);
router.get("/:id/activity", requirePermission("sales.view"), c.activity);
router.put("/:id", requirePermission("sales.create"), c.update);
router.delete("/:id", requirePermission("sales.delete"), c.remove);

router.post("/:id/send", requirePermission("sales.send"), c.send);
router.post("/:id/accept", requirePermission("sales.approve"), c.accept);
router.post("/:id/reject", requirePermission("sales.approve"), c.reject);
router.post("/:id/revise", requirePermission("sales.create"), c.revise);
router.post("/:id/convert", requirePermission("sales.approve"), c.convert); // -> a draft sales order
router.post("/:id/delivery-note", requirePermission("sales.approve"), c.toDeliveryNote); // -> a delivery note, to be invoiced after

module.exports = router;
