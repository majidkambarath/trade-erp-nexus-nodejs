const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const { requirePermission } = require("../../middleware/permissionGate");
const RecurringVoucher = require("../../models/modules/financial/recurringVoucherModel");
const c = require("../../controllers/financial/recurringVoucherController");

// Recurring journal and expense vouchers: templates that make PENDING vouchers on a schedule (services/financial/recurringVoucherService.js).
// A voucher it makes posts nothing until somebody who may approve it does (finance.approve, on the voucher's own approve route).
const router = express.Router();
router.use(authenticateToken);
router.param("id", branchOfDocument(RecurringVoucher)); // a head office working across branches acts in the template's own branch

router.get("/preview-dates", requirePermission(["finance.view", "finance.create"]), c.preview);
router.get("/", requirePermission("finance.view"), c.list);
router.post("/", requirePermission("finance.create"), c.create);
router.get("/:id", requirePermission("finance.view"), c.get);
router.put("/:id", requirePermission("finance.edit"), c.update);
router.post("/:id/pause", requirePermission("finance.edit"), c.pause);
router.post("/:id/resume", requirePermission("finance.edit"), c.resume);
router.post("/:id/run", requirePermission("finance.create"), c.run);
router.delete("/:id", requirePermission("finance.delete"), c.remove);

module.exports = router;
