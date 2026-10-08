const express = require("express");
const {
  uomValidationRules,
  uomConversionValidationRules,
} = require("../../validations/uomValidation");
const validate = require("../../middleware/validate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const UOMController = require("../../controllers/unit/uomController");

const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();

router.use(authenticateToken);

// UOM Routes
router.post("/units", requirePermission("inventory.create"), UOMController.createUOM);
router.get("/units", requirePermission(["inventory.view","lookups.view"]), UOMController.getAllUOMs);
router.get("/units/:id", requirePermission(["inventory.view","lookups.view"]), UOMController.getUOMById);
router.put("/units/:id", requirePermission("inventory.edit"), UOMController.updateUOM);
router.delete("/units/:id", requirePermission("inventory.delete"), UOMController.deleteUOM);

// UOM Conversion Routes
router.post("/conversions", requirePermission("inventory.create"), UOMController.createUOMConversion);
router.get("/conversions", requirePermission(["inventory.view","lookups.view"]), UOMController.getAllUOMConversions);
router.get("/conversions/:id", requirePermission(["inventory.view","lookups.view"]), UOMController.getUOMConversionById);
router.put("/conversions/:id", requirePermission("inventory.edit"), UOMController.updateUOMConversion);
router.delete("/conversions/:id", requirePermission("inventory.delete"), UOMController.deleteUOMConversion);

// Utility Routes
router.post("/convert", requirePermission(["inventory.view","lookups.view"]), UOMController.convertUnits);

module.exports = router;
