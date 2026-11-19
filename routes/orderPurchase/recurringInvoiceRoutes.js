const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const { requirePermission } = require("../../middleware/permissionGate");
const RecurringInvoice = require("../../models/modules/recurringInvoiceModel");
const c = require("../../controllers/orderPurchase/recurringInvoiceController");

// Recurring invoices: templates that make DRAFT sales invoices on a schedule (services/orderPurchase/recurringInvoiceService.js).
const router = express.Router();
router.use(authenticateToken);
router.param("id", branchOfDocument(RecurringInvoice)); // a head office working across branches acts in the template's own branch

router.get("/preview-dates", requirePermission(["sales.view", "sales.create"]), c.preview);
router.get("/", requirePermission("sales.view"), c.list);
router.post("/", requirePermission("sales.create"), c.create);
router.get("/:id", requirePermission("sales.view"), c.get);
router.put("/:id", requirePermission("sales.edit"), c.update);
router.post("/:id/pause", requirePermission("sales.edit"), c.pause);
router.post("/:id/resume", requirePermission("sales.edit"), c.resume);
router.post("/:id/run", requirePermission("sales.create"), c.run);
router.delete("/:id", requirePermission("sales.delete"), c.remove);

module.exports = router;
