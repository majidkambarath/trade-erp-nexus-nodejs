const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { requirePermission } = require("../../middleware/permissionGate");
const { requireFeature } = require("../../middleware/featureGate");
const catchAsync = require("../../utils/catchAsync");
const BatchService = require("../../services/stock/batchService");
const WriteOffService = require("../../services/stock/writeOffService");
const AuditService = require("../../services/core/auditService");

const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature("batches"));

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// Batches with stock on hand, nearest expiry first. ?stockId=  ?expiringWithinDays=30  ?status=
router.get("/", requirePermission("inventory.view"), catchAsync(async (req, res) => ok(res, await BatchService.list(req.query, req))));

// Write off (part of) a batch as expired or damaged.
router.post(
  "/:id/write-off",
  requirePermission("inventory.adjust"),
  catchAsync(async (req, res) => {
    const result = await WriteOffService.writeOff(
      { batchId: req.params.id, qty: req.body.qty, reason: req.body.reason, note: req.body.note },
      { adminId: req.admin?.id }
    );
    await AuditService.log({
      req, action: "STOCK_WRITTEN_OFF", entity: "StockBatch", entityId: req.params.id,
      summary: `${result.number}: ${result.qty} units, cost ${result.cost}`, after: { reason: req.body.reason, note: req.body.note },
    });
    ok(res, result, 201);
  })
);

module.exports = router;
