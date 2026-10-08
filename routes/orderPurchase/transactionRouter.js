const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { branchOfDocument } = require("../../middleware/branchOfDocument");
const Transaction = require("../../models/modules/transactionModel");
const TransactionController = require("../../controllers/orderPurchase/transactionController");
const OrderClose = require("../../controllers/orderPurchase/orderCloseController");

const router = express.Router();

router.use(authenticateToken);
router.param("id", branchOfDocument(Transaction)); // a head office working across branches posts to the document's own branch

router.post("/transactions", TransactionController.createTransaction);
router.get("/transactions", TransactionController.getAllTransactions);
router.get("/transactions/:id", TransactionController.getTransactionById);
router.get("/transactions/:id/audit", TransactionController.getTransactionAudit);
router.put("/transactions/:id", TransactionController.updateTransaction);
router.delete("/transactions/:id", TransactionController.deleteTransaction);
router.patch(
  "/transactions/:id/process",
  TransactionController.processTransaction
);

// a sales order the customer will not take the rest of
router.get("/transactions/:id/close-short", OrderClose.preview);
router.post("/transactions/:id/close-short", OrderClose.closeShort);
router.post("/transactions/:id/reopen-short", OrderClose.reopen);

module.exports = router;