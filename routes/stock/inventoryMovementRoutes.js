const express = require("express");
const InventoryMovementController = require("../../controllers/stock/inventoryMovementController");
const { authenticateToken } = require("../../middleware/authMiddleware");
// const validate = require("../middleware/validate");
// const {
//   movementValidationRules,
// } = require("../validations/movementValidation");

const router = express.Router();

router.use(authenticateToken);

router.post("/inventory", InventoryMovementController.createMovement);
router.get("/inventory", InventoryMovementController.getAllMovements);
router.get("/inventory/stats", InventoryMovementController.getMovementStats);
router.get("/inventory/:id", InventoryMovementController.getMovementById);

module.exports = router;
