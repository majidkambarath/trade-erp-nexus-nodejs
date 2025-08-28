const express = require("express");
const { vendorValidationRules } = require("../../validations/vendorValidation");
const validate = require("../../middleware/validate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const VendorController = require("../../controllers/vendor/vendorController");

const router = express.Router();

router.use(authenticateToken);

router.post("/vendors", VendorController.createVendor);
router.get("/vendors", VendorController.getAllVendors);
router.get("/vendors/:id", VendorController.getVendorById);
router.put("/vendors/:id", VendorController.updateVendor);
router.delete("/vendors/:id", VendorController.deleteVendor);

module.exports = router;
