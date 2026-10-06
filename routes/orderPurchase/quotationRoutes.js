const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const c = require("../../controllers/orderPurchase/quotationController");

const router = express.Router();
router.use(authenticateToken);

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
