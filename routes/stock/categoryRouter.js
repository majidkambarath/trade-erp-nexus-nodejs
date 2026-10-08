const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const CategoryController = require("../../controllers/stock/categoryController");

const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Category CRUD routes
router.post("/categories", requirePermission("inventory.create"), CategoryController.createCategory);
router.get("/categories", requirePermission(["inventory.view","lookups.view"]), CategoryController.getAllCategories);
router.get("/categories/stats", requirePermission(["inventory.view","lookups.view"]), CategoryController.getCategoryStats);
router.get("/categories/:id", requirePermission(["inventory.view","lookups.view"]), CategoryController.getCategoryById);
router.put("/categories/:id", requirePermission("inventory.create"), CategoryController.updateCategory);
router.delete("/categories/:id", requirePermission("inventory.delete"), CategoryController.deleteCategory);

module.exports = router;