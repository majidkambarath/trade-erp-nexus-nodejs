const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const AccountController = require("../../controllers/financial/accountController");
const { uploadSingle } = require("../../middleware/upload");
const router = express.Router();

router.use(authenticateToken);

router.post(
  "/account-vouchers",
  uploadSingle("attachedProof"),
  AccountController.createAccountVoucher
);
router.get("/account-vouchers", AccountController.getAllAccountVouchers);
router.get("/account-vouchers/:id", AccountController.getAccountVoucherById);
router.put(
  "/account-vouchers/:id",
  uploadSingle("attachedProof"),
  AccountController.updateAccountVoucher
);
router.delete("/account-vouchers/:id", AccountController.deleteAccountVoucher);

router.patch(
  "/account-vouchers/:id/approve",
  AccountController.processAccountVoucherApproval
);
router.get(
  "/account-vouchers/pending/approvals",
  AccountController.getPendingAccountVouchers
);

router.get("/account-vouchers/export/data", AccountController.exportAccountVouchers);

router.get("/account-vouchers/type/:type", AccountController.getAccountVouchersByType);

module.exports = router;