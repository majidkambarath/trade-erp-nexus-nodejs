const express = require("express");
const { vendorValidationRules } = require("../../validations/vendorValidation");
const validate = require("../../middleware/validate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const VendorController = require("../../controllers/vendor/vendorController");

const router = express.Router();

router.use(authenticateToken);

router.post(
  "/",
  validate(vendorValidationRules),
  VendorController.createVendor
);
router.get("/", VendorController.getAllVendors);
router.get("/:id", VendorController.getVendorById);
router.put(
  "/:id",
  VendorController.updateVendor
);
router.delete("/:id", VendorController.deleteVendor);

module.exports = router;
