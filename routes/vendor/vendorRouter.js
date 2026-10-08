const express = require("express");
const { vendorValidationRules } = require("../../validations/vendorValidation");
const validate = require("../../middleware/validate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const VendorController = require("../../controllers/vendor/vendorController");

const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();

router.use(authenticateToken);

router.post("/vendors", requirePermission("purchase.create"), VendorController.createVendor);
router.get("/vendors", requirePermission(["purchase.view","accounts.view"]), VendorController.getAllVendors);
router.get("/vendors/:id", requirePermission(["purchase.view","accounts.view"]), VendorController.getVendorById);
router.put("/vendors/:id", requirePermission("purchase.create"), VendorController.updateVendor);
router.delete("/vendors/:id", requirePermission("purchase.delete"), VendorController.deleteVendor);

module.exports = router;
