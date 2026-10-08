const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const {
  createCategory,
  deleteCategory,
  getAllCategories,
  getCategoryById,
  updateCategory,
} = require("../../controllers/financial/expenseTypeController");

const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Expense Type CRUD routes
router.post("/categories", requirePermission("finance.create"), createCategory);
router.get("/categories", requirePermission(["finance.view","lookups.view"]), getAllCategories);
router.get("/categories/:id", requirePermission(["finance.view","lookups.view"]), getCategoryById);
router.put("/categories/:id", requirePermission("finance.edit"), updateCategory);
router.delete("/categories/:id", requirePermission("finance.delete"), deleteCategory);

module.exports = router;
