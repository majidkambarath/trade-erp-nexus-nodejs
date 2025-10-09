const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const FinancialController = require("../../controllers/financial/financialController");
const { uploadSingle } = require("../../middleware/upload");
const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Main voucher CRUD operations
router.post(
  "/vouchers",
  uploadSingle("attachedProof"),
  FinancialController.createVoucher
);
router.get("/vouchers", FinancialController.getAllVouchers);
router.get("/vouchers/:id", FinancialController.getVoucherById);
router.put(
  "/vouchers/:id",
  uploadSingle("attachedProof"),
  FinancialController.updateVoucher
);
router.delete("/vouchers/:id", FinancialController.deleteVoucher);

// Voucher type-specific queries (optimized with param)
router.get("/vouchers/type/:type", FinancialController.getVouchersByType);

// Voucher approval workflow
router.patch(
  "/vouchers/:id/approve",
  FinancialController.processVoucherApproval
);
router.get(
  "/vouchers/pending/approvals",
  FinancialController.getPendingVouchers
);

// Bulk operations
router.post("/vouchers/bulk/process", FinancialController.bulkProcessVouchers);

// Utility operations
router.post("/vouchers/:id/duplicate", FinancialController.duplicateVoucher);
router.get("/vouchers/export/data", FinancialController.exportVouchers);

// Reports and analytics
router.get("/reports/financial", FinancialController.getFinancialReports);
router.get("/dashboard/stats", FinancialController.getDashboardStats);

router.get("/ledger-entries", FinancialController.getAllLedgerEntries);
module.exports = router;
