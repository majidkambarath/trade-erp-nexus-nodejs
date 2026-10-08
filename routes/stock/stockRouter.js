const express = require("express");
const {
  stockValidationRules,
  stockUpdateValidationRules,
  stockQuantityValidationRules,
} = require("../../validations/stockValidation");
const validate = require("../../middleware/validate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const StockController = require("../../controllers/stock/stockController");

const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Stock CRUD routes
router.post("/stock", requirePermission("inventory.create"), StockController.createStock);
router.get("/stock", requirePermission(["inventory.view","lookups.view"]), StockController.getAllStock);
router.get("/stock/stats", requirePermission(["inventory.view","lookups.view"]), StockController.getStockStats);
router.get("/stock/:id", requirePermission(["inventory.view","lookups.view"]), StockController.getStockById);
router.get("/stock/:id/current", requirePermission(["inventory.view","lookups.view"]), StockController.getCurrentStockById);
router.get("/stock/item/:itemId", requirePermission(["inventory.view","lookups.view"]), StockController.getStockByItemId);
router.put("/stock/:id", requirePermission("inventory.create"), StockController.updateStock);
router.patch("/stock/:id/quantity", requirePermission("inventory.adjust"), StockController.updateStockQuantity);
router.delete("/stock/:id", requirePermission("inventory.delete"), StockController.deleteStock);
router.get("/stock/:id/purchase-logs", requirePermission("inventory.view"), StockController.getPurchaseLogsByItemId);
module.exports = router;
