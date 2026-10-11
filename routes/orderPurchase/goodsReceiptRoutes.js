const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const GoodsReceipt = require("../../models/modules/goodsReceiptModel");
const c = require("../../controllers/orderPurchase/goodsReceiptController");

// Goods received, mounted at /api/v1/goods-receipts. The paper that says what a vendor's goods turned out to be; it posts
// nothing and moves no stock (the purchase invoice made from it does).
const router = express.Router();
router.use(authenticateToken);
router.param("id", branchOfDocument(GoodsReceipt)); // a head office working across branches acts in the receipt's own branch

// Fixed paths first: none of these may be read as an id.
router.get("/summary", requirePermission("purchase.view"), c.summary);
router.get("/from-order/:orderId", requirePermission("purchase.view"), c.fromOrder);
router.post("/invoice", requirePermission("purchase.approve"), c.invoice); // one purchase invoice for one or more received receipts

router.get("/", requirePermission("purchase.view"), c.list);
router.post("/", requirePermission("purchase.create"), c.create);
router.get("/:id", requirePermission("purchase.view"), c.get);
router.get("/:id/activity", requirePermission("purchase.view"), c.activity);
router.put("/:id", requirePermission("purchase.edit"), c.update);
router.delete("/:id", requirePermission("purchase.delete"), c.remove);

router.post("/:id/receive", requirePermission("purchase.approve"), c.receive);
router.post("/:id/cancel", requirePermission("purchase.approve"), c.cancel);

module.exports = router;
