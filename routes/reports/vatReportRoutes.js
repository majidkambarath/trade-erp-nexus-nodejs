const express = require("express");
const router = express.Router();
const VATReportController = require("../../controllers/reports/vatReportController");
const { authenticateToken } = require("../../middleware/authMiddleware");

// Optional: protect all routes & allow only admin/accountant
router.use(authenticateToken);

// GET /api/vat-reports
router.get("/vat", VATReportController.getAll);

// GET /api/vat-reports/:id
router.get("/vat/:id", VATReportController.getById);

// POST /api/vat-reports/:id/finalize
router.post("/vat/:id/finalize", VATReportController.finalize);

// POST /api/vat-reports/:id/submit
router.post("/vat/:id/submit", VATReportController.submit);

// DELETE /api/vat-reports/:id (only DRAFT)
router.delete("/vat/:id", VATReportController.deleteDraft);

module.exports = router;
