const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const Transaction = require("../../models/modules/transactionModel");
const TransactionController = require("../../controllers/orderPurchase/transactionController");
const OrderClose = require("../../controllers/orderPurchase/orderCloseController");

const { requirePermission, byDocumentType } = require("../../middleware/permissionGate");
const router = express.Router();

router.use(authenticateToken);
router.param("id", branchOfDocument(Transaction)); // a head office working across branches posts to the document's own branch

router.post("/transactions", requirePermission(byDocumentType("create")), TransactionController.createTransaction);
router.get("/transactions", requirePermission(byDocumentType("view")), TransactionController.getAllTransactions);
router.get("/transactions/:id", requirePermission(byDocumentType("view")), TransactionController.getTransactionById);
router.get("/transactions/:id/audit", requirePermission(byDocumentType("view")), TransactionController.getTransactionAudit);
router.put("/transactions/:id", requirePermission(byDocumentType("create")), TransactionController.updateTransaction);
router.delete("/transactions/:id", requirePermission(byDocumentType("delete")), TransactionController.deleteTransaction);
router.patch(
  "/transactions/:id/process", requirePermission(byDocumentType("approve")),
  TransactionController.processTransaction
);

// a sales order the customer will not take the rest of
router.get("/transactions/:id/close-short", requirePermission(byDocumentType("view")), OrderClose.preview);
router.post("/transactions/:id/close-short", requirePermission(byDocumentType("approve")), OrderClose.closeShort);
router.post("/transactions/:id/reopen-short", requirePermission(byDocumentType("approve")), OrderClose.reopen);

module.exports = router;