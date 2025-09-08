const express = require("express");
const {
  staffValidationRules,
  staffUpdateValidationRules,
} = require("../../validations/staffValidation");
const validate = require("../../middleware/validate");
const { authenticateToken } = require("../../middleware/authMiddleware");
const StaffController = require("../../controllers/staff/staffController");
const { handleUploadError } = require("../../middleware/upload");

const router = express.Router();

// Apply authentication middleware to all routes
router.use(authenticateToken);

// Staff CRUD routes
router.post("/staff", StaffController.createStaff);
router.get("/staff", StaffController.getAllStaff);
router.get("/staff/stats", StaffController.getStaffStats);
router.get("/staff/:id", StaffController.getStaffById);
router.get("/staff/staffId/:staffId", StaffController.getStaffByStaffId);
router.put(
  "/staff/:id",
  StaffController.updateStaff,
  handleUploadError
);
router.delete("/staff/:id", StaffController.deleteStaff);

module.exports = router;
