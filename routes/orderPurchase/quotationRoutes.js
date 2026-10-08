const express = require("express");
const { requireFeature } = require("../../middleware/featureGate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const Quotation = require("../../models/modules/quotationModel");
const c = require("../../controllers/orderPurchase/quotationController");

const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature("quotations"));
router.param("id", branchOfDocument(Quotation)); // a head office working across branches posts to the document's own branch

// Fixed paths first: "/summary" must not be read as an id.
router.get("/summary", c.summary);
router.get("/", c.list);
router.post("/", c.create);
router.get("/:id", c.get);
router.get("/:id/activity", c.activity);
router.put("/:id", c.update);
router.delete("/:id", c.remove);

router.post("/:id/send", c.send);
router.post("/:id/accept", c.accept);
router.post("/:id/reject", c.reject);
router.post("/:id/revise", c.revise);
router.post("/:id/convert", c.convert); // -> a draft sales order
router.post("/:id/delivery-note", c.toDeliveryNote); // -> a delivery note, to be invoiced after

module.exports = router;
