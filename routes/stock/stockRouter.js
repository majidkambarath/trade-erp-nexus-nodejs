const express = require("express");
const {
  stockValidationRules,
  stockUpdateValidationRules,
} = require("../../validations/stockValidation");
const validate = require("../../middleware/validate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const StockController = require("../../controllers/stock/stockController");

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Stock CRUD routes
router.post("/", validate(stockValidationRules), StockController.createStock);

router.get("/", StockController.getAllStock);
router.get("/stats", StockController.getStockStats);
router.get("/categories", StockController.getCategoriesWithCount);
router.get("/:id", StockController.getStockById);
router.get("/item/:itemId", StockController.getStockByItemId);

router.put(
  "/:id",
  validate(stockUpdateValidationRules),
  StockController.updateStock
);

router.patch("/:id/quantity", StockController.updateStockQuantity);
router.delete("/:id", StockController.deleteStock);

module.exports = router;
