const express = require("express");
const adminController = require("../../controllers/core/adminController");
const { authenticateToken } = require("../../middleware/authMiddleware");
const {
  uploadSingle,
  uploadFields,
  handleUploadError,
} = require("../../middleware/upload");
const {
  validateCreateAdmin,
  validateUpdateAdmin,
  validateProfileUpdate,
  validateLogin,
  validateChangePassword,
  validateObjectId,
  validateGetAllAdmins,
} = require("../../validations/adminValidation");

const router = express.Router();

// =================== PUBLIC ROUTES ===================
router.post("/login", validateLogin, adminController.login);

router.post("/refresh-token", adminController.refreshToken);

// Test route
router.get("/test", (req, res) => res.json({ message: "Admin router works!" }));

// =================== PROTECTED ROUTES ===================

// Admin CRUD operations
router.post(
  "/",
  uploadFields([
    { name: "profileImage", maxCount: 1 },
    { name: "companyLogo", maxCount: 1 },
  ]),
  handleUploadError,
  adminController.createAdmin
);

router.get(
  "/",
  authenticateToken,
  validateGetAllAdmins,
  adminController.getAllAdmins
);

router.get(
  "/:id",
  authenticateToken,
  validateObjectId,
  adminController.getAdmin
);

router.put(
  "/:id",
  authenticateToken,
  validateObjectId,
  uploadFields([
    { name: "profileImage", maxCount: 1 },
    { name: "companyLogo", maxCount: 1 },
  ]),
  handleUploadError,
  validateUpdateAdmin,
  adminController.updateAdmin
);

router.delete(
  "/:id",
  // authenticateToken,
  validateObjectId,
  adminController.deleteAdmin
);

// =================== PROFILE ROUTES ===================

// Get current admin profile
router.get("/profile/me", authenticateToken, adminController.getProfile);

// Update current admin profile
router.put(
  "/profile/me",
  authenticateToken,
  uploadFields([
    { name: "profileImage", maxCount: 1 },
    { name: "companyLogo", maxCount: 1 },
  ]),
  handleUploadError,
  adminController.updateProfile
);

// Change password
router.put(
  "/profile/change-password",
  authenticateToken,
  validateChangePassword,
  adminController.changePassword
);

// =================== IMAGE UPLOAD ROUTES ===================

// Upload profile image only
router.post(
  "/profile/upload-image",
  authenticateToken,
  uploadSingle("profileImage"),
  handleUploadError,
  adminController.uploadProfileImage
);

// Upload company logo only
router.post(
  "/profile/upload-logo",
  authenticateToken,
  uploadSingle("companyLogo"),
  handleUploadError,
  adminController.uploadCompanyLogo
);

// =================== ADMIN MANAGEMENT ROUTES ===================

// Get admins by type
router.get("/type/:type", authenticateToken, (req, res, next) => {
  req.query.type = req.params.type;
  adminController.getAllAdmins(req, res, next);
});

// Get active admins only
router.get("/status/active", authenticateToken, (req, res, next) => {
  req.query.status = "active";
  adminController.getAllAdmins(req, res, next);
});

// Activate/Deactivate admin
router.patch("/:id/status", authenticateToken, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!["active", "inactive", "suspended"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid status. Must be active, inactive, or suspended",
      });
    }

    req.body = { status };
    adminController.updateAdmin(req, res, next);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
