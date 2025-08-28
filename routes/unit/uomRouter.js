const express = require("express");
const {
  uomValidationRules,
  uomConversionValidationRules,
} = require("../../validations/uomValidation");
const validate = require("../../middleware/validate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const UOMController = require("../../controllers/unit/UOMController");

const router = express.Router();

router.use(authenticateToken);

// UOM Routes
router.post("/units", UOMController.createUOM);
router.get("/units", UOMController.getAllUOMs);
router.get("/units/:id", UOMController.getUOMById);
router.put("/units/:id", UOMController.updateUOM);
router.delete("/units/:id", UOMController.deleteUOM);

// UOM Conversion Routes
router.post("/conversions", UOMController.createUOMConversion);
router.get("/conversions", UOMController.getAllUOMConversions);
router.get("/conversions/:id", UOMController.getUOMConversionById);
router.put("/conversions/:id", UOMController.updateUOMConversion);
router.delete("/conversions/:id", UOMController.deleteUOMConversion);

// Utility Routes
router.post("/convert", UOMController.convertUnits);

module.exports = router;
