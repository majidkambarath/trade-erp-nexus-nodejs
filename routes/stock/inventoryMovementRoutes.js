const express = require("express");
const InventoryMovementController = require("../../controllers/stock/InventoryMovementController");
const { authenticateToken } = require("../../middleware/authMiddleware");
// const validate = require("../middleware/validate");
// const {
//   movementValidationRules,
// } = require("../validations/movementValidation");

const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();

router.use(authenticateToken);
router.use(require("../../middleware/costVisibility").hideCost({ movements: true })); // unit cost, value and the average cost rolled forward are for inventory.viewCost only

router.post("/inventory", requirePermission("inventory.adjust"), InventoryMovementController.createMovement);
router.get("/inventory", requirePermission("inventory.view"), InventoryMovementController.getAllMovements);
router.get("/inventory/stats", requirePermission("inventory.view"), InventoryMovementController.getMovementStats);
router.get("/inventory/:id", requirePermission("inventory.view"), InventoryMovementController.getMovementById);

module.exports = router;
