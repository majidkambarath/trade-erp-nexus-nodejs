const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const CategoryController = require("../../controllers/stock/categoryController");

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Category CRUD routes
router.post("/categories", CategoryController.createCategory);
router.get("/categories", CategoryController.getAllCategories);
router.get("/categories/stats", CategoryController.getCategoryStats);
router.get("/categories/:id", CategoryController.getCategoryById);
router.put("/categories/:id", CategoryController.updateCategory);
router.delete("/categories/:id", CategoryController.deleteCategory);

module.exports = router;