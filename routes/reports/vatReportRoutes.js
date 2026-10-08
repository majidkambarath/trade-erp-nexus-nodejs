const express = require("express");
const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();
const VATReportController = require("../../controllers/reports/vatReportController");
const { authenticateToken } = require("../../middleware/authMiddleware");

// Optional: protect all routes & allow only admin/accountant
router.use(authenticateToken);

// GET /api/vat-reports
router.get("/vat", requirePermission("reports.financial"), VATReportController.getAll);

// GET /api/vat-reports/:id
router.get("/vat/:id", requirePermission("reports.financial"), VATReportController.getById);

// POST /api/vat-reports/:id/finalize
router.post("/vat/:id/finalize", requirePermission("reports.vat"), VATReportController.finalize);

// POST /api/vat-reports/:id/submit
router.post("/vat/:id/submit", requirePermission("reports.vat"), VATReportController.submit);

// DELETE /api/vat-reports/:id (only DRAFT)
router.delete("/vat/:id", requirePermission("reports.vat"), VATReportController.deleteDraft);

module.exports = router;
