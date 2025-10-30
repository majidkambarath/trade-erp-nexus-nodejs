const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const {
  createCategory,
  deleteCategory,
  getAllCategories,
  getCategoryById,
  updateCategory,
} = require("../../controllers/financial/expenseTypeController");

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Expense Type CRUD routes
router.post("/categories", createCategory);
router.get("/categories", getAllCategories);
router.get("/categories/:id", getCategoryById);
router.put("/categories/:id", updateCategory);
router.delete("/categories/:id", deleteCategory);

module.exports = router;
