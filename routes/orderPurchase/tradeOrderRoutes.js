const express = require("express");
const mongoose = require("mongoose");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const TradeOrder = require("../../models/modules/tradeOrderModel");
const c = require("../../controllers/orderPurchase/tradeOrderController");

// Sales orders and purchase orders, mounted at /api/v1/trade-orders. A commitment, never a posting. One router serves both
// kinds, so what a request needs is decided from the STORED order's kind (or the kind it names for a new one / a list), never
// from the URL: a person who may use purchases only cannot reach a sales order by its id.
const router = express.Router();
router.use(authenticateToken);
router.param("id", branchOfDocument(TradeOrder)); // a head office working across branches acts in the order's own branch

const kindOf = async (req) => {
  if (req.params?.id && mongoose.isValidObjectId(req.params.id)) {
    const stored = await TradeOrder.findById(req.params.id).select("kind").lean().catch(() => null);
    if (stored) return stored.kind;
  }
  return req.body?.kind || (Array.isArray(req.query?.kind) ? undefined : req.query?.kind);
};
const can = (action) => async (req) => {
  const kind = await kindOf(req);
  if (kind === "sales") return `sales.${action}`;
  if (kind === "purchase") return `purchase.${action}`;
  return [`sales.${action}`, `purchase.${action}`];
};

router.get("/summary", requirePermission(can("view")), c.summary);
router.get("/", requirePermission(can("view")), c.list);
router.post("/", requirePermission(can("create")), c.create);
router.get("/:id", requirePermission(can("view")), c.get);
router.get("/:id/activity", requirePermission(can("view")), c.activity);
router.put("/:id", requirePermission(can("edit")), c.update);
router.delete("/:id", requirePermission(can("delete")), c.remove);

router.post("/:id/confirm", requirePermission(can("approve")), c.confirm);
router.post("/:id/cancel", requirePermission(can("approve")), c.cancel);
router.post("/:id/close", requirePermission(can("approve")), c.close);
router.post("/:id/reopen", requirePermission(can("approve")), c.reopen);

module.exports = router;
