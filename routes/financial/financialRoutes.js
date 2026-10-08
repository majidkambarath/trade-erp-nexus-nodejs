const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const { Voucher } = require("../../models/modules/financial/financialModels");
const FinancialController = require("../../controllers/financial/financialController");
const { uploadSingle } = require("../../middleware/upload");
const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);
router.param("id", branchOfDocument(Voucher)); // a head office working across branches posts to the document's own branch

// Main voucher CRUD operations
router.post(
  "/vouchers", requirePermission("finance.create"),
  uploadSingle("attachedProof"),
  FinancialController.createVoucher
);
router.get("/vouchers", requirePermission("finance.view"), FinancialController.getAllVouchers);
router.get("/vouchers/:id", requirePermission("finance.view"), FinancialController.getVoucherById);
router.get("/vouchers/:id/audit", requirePermission("finance.view"), FinancialController.getVoucherAudit);
router.put(
  "/vouchers/:id", requirePermission("finance.create"),
  uploadSingle("attachedProof"),
  FinancialController.updateVoucher
);
router.delete("/vouchers/:id", requirePermission("finance.delete"), FinancialController.deleteVoucher);

// Voucher type-specific queries (optimized with param)
router.get("/vouchers/type/:type", requirePermission("finance.view"), FinancialController.getVouchersByType);

// Voucher approval workflow
router.patch(
  "/vouchers/:id/approve", requirePermission("finance.approve"),
  FinancialController.processVoucherApproval
);
router.get(
  "/vouchers/pending/approvals", requirePermission("finance.view"),
  FinancialController.getPendingVouchers
);

// Bulk operations
router.post("/vouchers/bulk/process", requirePermission("finance.approve"), FinancialController.bulkProcessVouchers);

// Utility operations
router.post("/vouchers/:id/duplicate", requirePermission("finance.create"), FinancialController.duplicateVoucher);
router.get("/vouchers/export/data", requirePermission("reports.financial"), FinancialController.exportVouchers);

// Reports and analytics
router.get("/reports/financial", requirePermission("reports.financial"), FinancialController.getFinancialReports);
router.get("/dashboard/stats", requirePermission("reports.view"), FinancialController.getDashboardStats);

router.get("/ledger-entries", requirePermission(["finance.view","reports.financial"]), FinancialController.getAllLedgerEntries);
module.exports = router;
