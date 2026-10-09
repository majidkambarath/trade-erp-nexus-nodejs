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
router.post("/staff", requirePermission("staff.manage"), StaffController.createStaff);
router.get("/staff", requirePermission("staff.view"), StaffController.getAllStaff);
router.get("/staff/stats", requirePermission("staff.view"), StaffController.getStaffStats);
router.get("/staff/:id", requirePermission("staff.view"), StaffController.getStaffById);
router.get("/staff/staffId/:staffId", requirePermission("staff.view"), StaffController.getStaffByStaffId);
router.put(
  "/staff/:id", requirePermission("staff.manage"),
  StaffController.updateStaff,
  handleUploadError
);
router.delete("/staff/:id", requirePermission("staff.manage"), StaffController.deleteStaff);

module.exports = router;
