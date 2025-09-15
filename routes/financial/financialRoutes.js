const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const FinancialController = require("../../controllers/financial/financialController");

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Main voucher CRUD operations
router.post("/vouchers", FinancialController.createVoucher);
router.get("/vouchers", FinancialController.getAllVouchers);
router.get("/vouchers/:id", FinancialController.getVoucherById);
router.put("/vouchers/:id", FinancialController.updateVoucher);
router.delete("/vouchers/:id", FinancialController.deleteVoucher);

// Voucher approval workflow
router.patch(
  "/vouchers/:id/approve",
  FinancialController.processVoucherApproval
);
router.get(
  "/vouchers/pending/approvals",
  FinancialController.getPendingVouchers
);

// Specific voucher type routes
router.get("/vouchers/type/receipt", FinancialController.getReceiptVouchers);
router.get("/vouchers/type/payment", FinancialController.getPaymentVouchers);
router.get("/vouchers/type/journal", FinancialController.getJournalVouchers);
router.get("/vouchers/type/contra", FinancialController.getContraVouchers);
router.get("/vouchers/type/expense", FinancialController.getExpenseVouchers);

// Bulk operations
router.post("/vouchers/bulk/process", FinancialController.bulkProcessVouchers);

// Utility operations
router.post("/vouchers/:id/duplicate", FinancialController.duplicateVoucher);
router.get("/vouchers/export/data", FinancialController.exportVouchers);

// Reports and analytics
router.get("/reports/financial", FinancialController.getFinancialReports);
router.get("/dashboard/stats", FinancialController.getDashboardStats);

// Legacy specific routes (for backwards compatibility)
// Receipt Voucher specific routes
router.post("/receipt-vouchers", (req, res, next) => {
  req.body.voucherType = "receipt";
  FinancialController.createVoucher(req, res, next);
});

router.get("/receipt-vouchers", FinancialController.getReceiptVouchers);

router.get("/receipt-vouchers/:id", FinancialController.getVoucherById);

router.put("/receipt-vouchers/:id", (req, res, next) => {
  req.body.voucherType = "receipt";
  FinancialController.updateVoucher(req, res, next);
});

// Payment Voucher specific routes
router.post("/payment-vouchers", (req, res, next) => {
  req.body.voucherType = "payment";
  FinancialController.createVoucher(req, res, next);
});

router.get("/payment-vouchers", FinancialController.getPaymentVouchers);

router.get("/payment-vouchers/:id", FinancialController.getVoucherById);

router.put("/payment-vouchers/:id", (req, res, next) => {
  req.body.voucherType = "payment";
  FinancialController.updateVoucher(req, res, next);
});

// Journal Voucher specific routes
router.post("/journal-vouchers", (req, res, next) => {
  req.body.voucherType = "journal";
  FinancialController.createVoucher(req, res, next);
});

router.get("/journal-vouchers", FinancialController.getJournalVouchers);

router.get("/journal-vouchers/:id", FinancialController.getVoucherById);

router.put("/journal-vouchers/:id", (req, res, next) => {
  req.body.voucherType = "journal";
  FinancialController.updateVoucher(req, res, next);
});

// Contra Voucher specific routes
router.post("/contra-vouchers", (req, res, next) => {
  req.body.voucherType = "contra";
  FinancialController.createVoucher(req, res, next);
});

router.get("/contra-vouchers", FinancialController.getContraVouchers);

router.get("/contra-vouchers/:id", FinancialController.getVoucherById);

router.put("/contra-vouchers/:id", (req, res, next) => {
  req.body.voucherType = "contra";
  FinancialController.updateVoucher(req, res, next);
});

// Expense Voucher specific routes
router.post("/expense-vouchers", (req, res, next) => {
  req.body.voucherType = "expense";
  FinancialController.createVoucher(req, res, next);
});

router.get("/expense-vouchers", FinancialController.getExpenseVouchers);

router.get("/expense-vouchers/:id", FinancialController.getVoucherById);

router.put("/expense-vouchers/:id", (req, res, next) => {
  req.body.voucherType = "expense";
  FinancialController.updateVoucher(req, res, next);
});

module.exports = router;
