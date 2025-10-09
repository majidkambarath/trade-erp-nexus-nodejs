const express = require("express");
const { authenticateToken } = require("../../middleware/authMiddleware");
const TransactorController = require("../../controllers/financial/TransactorController");
const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Transactor CRUD operations
router.post("/Transactor", TransactorController.createTransactor);
router.get("/Transactor", TransactorController.getAllTransactors);
router.get("/Transactor/:id", TransactorController.getTransactorById);
router.put("/Transactor/:id", TransactorController.updateTransactor);
router.delete("/Transactor/:id", TransactorController.deleteTransactor);

module.exports = router;