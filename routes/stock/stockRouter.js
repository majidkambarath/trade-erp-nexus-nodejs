const express = require("express");
const {
  stockValidationRules,
  stockUpdateValidationRules,
  stockQuantityValidationRules,
} = require("../../validations/stockValidation");
const validate = require("../../middleware/validate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const StockController = require("../../controllers/stock/stockController");

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Stock CRUD routes
router.post(
  "/stock",
  validate(stockValidationRules),
  StockController.createStock
);
router.get("/stock", StockController.getAllStock);
router.get("/stock/stats", StockController.getStockStats);
router.get("/stock/categories", StockController.getCategoriesWithCount);
router.get("/stock/:id", StockController.getStockById);
router.get("/stock/item/:itemId", StockController.getStockByItemId);
router.put(
  "/stock/:id",
  validate(stockUpdateValidationRules),
  StockController.updateStock
);
router.patch(
  "/stock/:id/quantity",
  validate(stockQuantityValidationRules),
  StockController.updateStockQuantity
); // Ensure this references the new method
router.delete("/stock/:id", StockController.deleteStock);

module.exports = router;
