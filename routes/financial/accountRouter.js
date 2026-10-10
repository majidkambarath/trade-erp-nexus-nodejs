const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const AccountController = require("../../controllers/financial/accountController");
const { uploadSingle } = require("../../middleware/upload");
const { requirePermission, byVoucherDelete } = require("../../middleware/permissionGate");
const router = express.Router();

router.use(authenticateToken);

router.post(
  "/account-vouchers", requirePermission("finance.create"),
  uploadSingle("attachedProof"),
  AccountController.createAccountVoucher
);
router.get("/account-vouchers", requirePermission("finance.view"), AccountController.getAllAccountVouchers);
router.get("/account-vouchers/:id", requirePermission("finance.view"), AccountController.getAccountVoucherById);
router.put(
  "/account-vouchers/:id", requirePermission("finance.edit"),
  uploadSingle("attachedProof"),
  AccountController.updateAccountVoucher
);
router.delete("/account-vouchers/:id", requirePermission(byVoucherDelete), AccountController.deleteAccountVoucher); // a posted (approved or settled) one needs deletePosted

router.patch(
  "/account-vouchers/:id/approve", requirePermission("finance.approve"),
  AccountController.processAccountVoucherApproval
);
router.get(
  "/account-vouchers/pending/approvals", requirePermission("finance.view"),
  AccountController.getPendingAccountVouchers
);

router.get("/account-vouchers/export/data", requirePermission("reports.financial"), AccountController.exportAccountVouchers);

router.get("/account-vouchers/type/:type", requirePermission("finance.view"), AccountController.getAccountVouchersByType);

module.exports = router;