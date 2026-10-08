const express = require("express");
const {
  staffValidationRules,
  staffUpdateValidationRules,
} = require("../../validations/staffValidation");
const validate = require("../../middleware/validate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const StaffController = require("../../controllers/staff/staffController");
const { handleUploadError } = require("../../middleware/upload");

const { requirePermission } = require("../../middleware/permissionGate");
const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Staff CRUD routes
router.post("/staff", requirePermission("users.manage"), StaffController.createStaff);
router.get("/staff", requirePermission("users.view"), StaffController.getAllStaff);
router.get("/staff/stats", requirePermission("users.view"), StaffController.getStaffStats);
router.get("/staff/:id", requirePermission("users.view"), StaffController.getStaffById);
router.get("/staff/staffId/:staffId", requirePermission("users.view"), StaffController.getStaffByStaffId);
router.put(
  "/staff/:id", requirePermission("users.manage"),
  StaffController.updateStaff,
  handleUploadError
);
router.delete("/staff/:id", requirePermission("users.manage"), StaffController.deleteStaff);

module.exports = router;
