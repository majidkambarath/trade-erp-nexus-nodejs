const express = require("express");
const { requireFeature } = require("../../middleware/featureGate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const DeliveryNote = require("../../models/modules/deliveryNoteModel");
const c = require("../../controllers/orderPurchase/deliveryNoteController");

const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature("deliveryNotes"));
router.param("id", branchOfDocument(DeliveryNote)); // a head office working across branches posts to the document's own branch

// Fixed paths first: none of these may be read as an id.
router.get("/summary", c.summary);
router.get("/uninvoiced", c.uninvoiced);
router.get("/availability", c.availability);
router.get("/from-order/:orderId", c.fromOrder);
router.post("/invoice", c.invoice); // one sales order for one or more delivered notes

router.get("/", c.list);
router.post("/", c.create);
router.get("/:id", c.get);
router.get("/:id/pick-list", c.pickList);
router.get("/:id/activity", c.activity);
router.put("/:id", c.update);
router.delete("/:id", c.remove);

router.post("/:id/dispatch", c.dispatch);
router.post("/:id/deliver", c.deliver);
router.post("/:id/cancel", c.cancel);

module.exports = router;
