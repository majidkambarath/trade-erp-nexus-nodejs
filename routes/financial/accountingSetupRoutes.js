const express = require("express");
const { authenticateToken, requireRole } = require("../../middleware/authMiddleware");
const c = require("../../controllers/financial/accountingSetupController");
const chart = require("../../controllers/financial/chartController");
const multer = require("multer");
const AppError = require("../../utils/AppError");
const AttachmentService = require("../../services/core/attachmentService");

// Files are held in memory, validated (extension + content), then written by AttachmentService.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: AttachmentService.MAX_BYTES, files: 1 } });
const uploadOne = (req, res, next) =>
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    next(err.code === "LIMIT_FILE_SIZE" ? new AppError("File too large (10 MB maximum)", 413, "FILE_TOO_LARGE") : new AppError("Upload failed", 400));
  });

const router = express.Router();
router.use(authenticateToken);

// Reading the setup is open to any signed-in admin; changing it needs an admin or super admin.
const canChange = requireRole(["super_admin", "admin"]);

router.get("/account-groups", c.listGroups);
router.post("/account-groups", canChange, c.createGroup);
router.put("/account-groups/:id", canChange, c.updateGroup);
router.post("/account-groups/:id/account-code", canChange, c.mintAccountCode);

router.get("/account-configuration", c.getConfiguration);
router.put("/account-configuration", canChange, c.updateConfiguration);
router.get("/account-configuration/readiness", c.getReadiness);
router.put("/account-configuration/posting", canChange, c.setPosting);

router.get("/fiscal-years", c.listFiscalYears);
router.post("/fiscal-years", canChange, c.createFiscalYear);
router.post("/fiscal-years/:id/close", canChange, c.closeFiscalYear);
router.post("/fiscal-years/:id/reopen", canChange, c.reopenFiscalYear);

router.get("/number-series", c.listNumberSeries);

// chart of accounts
router.get("/chart", chart.getChart);
router.post("/chart/defaults", canChange, chart.restoreDefaults);
router.get("/accounts/postable", chart.listPostable);
router.post("/accounts", canChange, chart.createAccount);
router.put("/accounts/:id", canChange, chart.updateAccount);
router.get("/accounts/:id/ledger", chart.getAccountLedger);

// settings, party reports, returns picker, audit
router.get("/settings", chart.getSettings);
router.put("/settings", canChange, chart.updateSettings);
router.get("/reports/ageing", chart.getAgeing);
router.get("/reports/statement", chart.getStatement);
router.get("/returnable/:id", chart.getReturnable);
router.get("/audit-log", chart.getAuditLog);

// tax codes
router.get("/tax-codes", chart.listTaxCodes);
router.post("/tax-codes", canChange, chart.createTaxCode);
router.put("/tax-codes/:id", canChange, chart.updateTaxCode);

// attachments (upload, link to a document, list, authenticated download, delete)
router.post("/attachments", uploadOne, chart.uploadAttachment);
router.get("/attachments", chart.listAttachments);
router.post("/attachments/:id/link", chart.linkAttachment);
router.get("/attachments/:id", chart.downloadAttachment);
router.delete("/attachments/:id", chart.deleteAttachment);

module.exports = router;
