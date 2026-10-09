const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const c = require("../../controllers/financial/accountingSetupController");
const chart = require("../../controllers/financial/chartController");
const ledgerReports = require("../../controllers/reports/ledgerReportsController");
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

const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();
router.use(authenticateToken);

// Reading the setup is open to any signed-in admin; changing it needs an admin or super admin.

router.get("/account-groups", requirePermission(["accounts.view","lookups.view"]), c.listGroups);
router.post("/account-groups", requirePermission("accounts.manage"), c.createGroup);
router.put("/account-groups/:id", requirePermission("accounts.manage"), c.updateGroup);
router.post("/account-groups/:id/account-code", requirePermission("accounts.manage"), c.mintAccountCode);

router.get("/account-configuration", requirePermission("accounts.view"), c.getConfiguration);
router.put("/account-configuration", requirePermission("accounts.manage"), c.updateConfiguration);
router.get("/account-configuration/readiness", requirePermission("accounts.view"), c.getReadiness);
router.put("/account-configuration/posting", requirePermission("accounts.manage"), c.setPosting);

router.get("/fiscal-years", requirePermission(["accounts.view","lookups.view"]), c.listFiscalYears);
router.post("/fiscal-years", requirePermission("accounts.manage"), c.createFiscalYear);
router.get("/fiscal-years/:id/year-end", requirePermission("accounts.close"), c.yearEnd);
router.post("/fiscal-years/:id/close", requirePermission("accounts.close"), c.closeFiscalYear);
router.post("/fiscal-years/:id/reopen", requirePermission("accounts.close"), c.reopenFiscalYear);

router.get("/number-series", requirePermission("accounts.view"), c.listNumberSeries);

// chart of accounts
router.get("/chart", requirePermission("accounts.view"), chart.getChart);
router.post("/chart/defaults", requirePermission("accounts.manage"), chart.restoreDefaults);
router.get("/accounts/postable", requirePermission(["accounts.view","lookups.view"]), chart.listPostable);
router.post("/accounts", requirePermission("accounts.manage"), chart.createAccount);
router.put("/accounts/:id", requirePermission("accounts.manage"), chart.updateAccount);
router.get("/accounts/:id/ledger", requirePermission(["accounts.view","reports.financial","finance.view"]), chart.getAccountLedger);

// settings, party reports, returns picker, audit
router.get("/settings", requirePermission(["settings.view","accounts.view","lookups.view"]), chart.getSettings);
router.put("/settings", requirePermission("settings.manage"), chart.updateSettings);
router.get("/reports/ageing", requirePermission("reports.view"), chart.getAgeing);
router.get("/reports/statement", requirePermission(["reports.view","finance.view"]), chart.getStatement);

// ledger reports (read from the general ledger)
router.get("/reports/general-ledger", requirePermission("reports.financial"), ledgerReports.generalLedger);
router.get("/reports/profit-loss", requirePermission("reports.financial"), ledgerReports.profitAndLoss);
router.get("/reports/day-book", requirePermission(["reports.financial","finance.view"]), ledgerReports.dayBook);
router.get("/reports/daily-summary", requirePermission(["reports.financial","finance.view"]), ledgerReports.dailySummary);
router.get("/reports/voucher/:id", requirePermission(["reports.financial","finance.view"]), ledgerReports.voucherImpact);
router.get("/reports/cash-book", requirePermission("reports.financial"), ledgerReports.cashBook);
router.get("/reports/cash-flow", requirePermission("reports.financial"), ledgerReports.cashFlow);
router.get("/reports/day-end", requirePermission("reports.financial"), ledgerReports.dayEnd);
router.get("/reports/day-end/register", requirePermission("reports.financial"), ledgerReports.dayEndRegister);
router.get("/reports/party-balances", requirePermission(["reports.financial","finance.view"]), ledgerReports.partyBalances);
router.get("/returnable/:id", requirePermission(["sales.view","purchase.view"]), chart.getReturnable);
router.get("/audit-log", requirePermission("audit.view"), chart.getAuditLog);

// tax codes
router.get("/tax-codes", requirePermission(["accounts.view","lookups.view"]), chart.listTaxCodes);
router.post("/tax-codes", requirePermission("accounts.manage"), chart.createTaxCode);
router.put("/tax-codes/:id", requirePermission("accounts.manage"), chart.updateTaxCode);

// attachments (upload, link to a document, list, authenticated download, delete)
router.post("/attachments", requirePermission(["finance.create","finance.edit","sales.create","sales.edit","purchase.create","purchase.edit","inventory.create","inventory.edit","accounts.manage"]), uploadOne, chart.uploadAttachment);
router.get("/attachments", requirePermission(["finance.view","sales.view","purchase.view","accounts.view"]), chart.listAttachments);
router.post("/attachments/:id/link", requirePermission(["finance.create","finance.edit","sales.create","sales.edit","purchase.create","purchase.edit","inventory.create","inventory.edit","accounts.manage"]), chart.linkAttachment);
router.get("/attachments/:id", requirePermission(["finance.view","sales.view","purchase.view","accounts.view"]), chart.downloadAttachment);
router.delete("/attachments/:id", requirePermission(["finance.delete","sales.delete","purchase.delete","accounts.manage"]), chart.deleteAttachment);

module.exports = router;
