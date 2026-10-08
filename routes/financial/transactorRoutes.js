const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const TransactorController = require("../../controllers/financial/TransactorController");
const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Transactor CRUD operations
router.post("/Transactor", requirePermission("accounts.manage"), TransactorController.createTransactor);
router.get("/Transactor", requirePermission(["finance.view","accounts.view","lookups.view"]), TransactorController.getAllTransactors);
router.get("/Transactor/:id", requirePermission(["finance.view","accounts.view","lookups.view"]), TransactorController.getTransactorById);
router.put("/Transactor/:id", requirePermission("accounts.manage"), TransactorController.updateTransactor);
router.delete("/Transactor/:id", requirePermission("accounts.manage"), TransactorController.deleteTransactor);

module.exports = router;