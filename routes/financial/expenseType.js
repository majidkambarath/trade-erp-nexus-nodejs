const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const ExpenseTypeController = require("../../controllers/financial/expenseTypeController");

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Expense Type CRUD routes
router.post("/expense-types", ExpenseTypeController.createExpenseType);
router.get("/expense-types", ExpenseTypeController.getAllExpenseTypes);
router.get("/expense-types/:id", ExpenseTypeController.getExpenseTypeById);
router.put("/expense-types/:id", ExpenseTypeController.updateExpenseType);
router.delete("/expense-types/:id", ExpenseTypeController.deleteExpenseType);

module.exports = router;