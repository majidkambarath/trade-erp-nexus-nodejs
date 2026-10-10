const express = require("express");
const adminController = require("../../controllers/core/adminController");
const { authenticateToken } = require("../../middleware/authMiddleware");
const { sharedLoginThrottle, refreshFailureThrottle } = require("../../middleware/loginThrottle");
const { requirePermission, selfOr, signedIn, publicRoute } = require("../../middleware/permissionGate");
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

// Managing other people's accounts needs users.manage (seeing them, users.view). Whether this person may touch THIS
// account - one of a lower rank than their own - is decided in the service, which knows the target.
// =================== PUBLIC ROUTES ===================
router.post("/login", publicRoute("signing in: there is no one to check yet"), sharedLoginThrottle(), validateLogin, adminController.login);

router.post("/refresh-token", publicRoute("renewing a session: the session cookie is the credential"), refreshFailureThrottle(), adminController.refreshToken);

router.post("/logout", publicRoute("ending a session: the session cookie names it"), adminController.logout);

// =================== PROTECTED ROUTES ===================

// Admin CRUD operations
router.post(
  "/",
  authenticateToken,
  requirePermission("users.manage"),
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
  requirePermission("users.view"),
  validateGetAllAdmins,
  adminController.getAllAdmins
);

router.get(
  "/:id",
  authenticateToken,
  selfOr("users.view"),
  validateObjectId,
  adminController.getAdmin
);

router.put(
  "/:id",
  authenticateToken,
  requirePermission("users.manage"),
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
  authenticateToken,
  requirePermission("users.manage"),
  validateObjectId,
  adminController.deleteAdmin
);

// =================== PROFILE ROUTES ===================

// Get current admin profile
router.get("/profile/me", authenticateToken, signedIn("a person's own profile"), adminController.getProfile);

// Update current admin profile
router.put(
  "/profile/me",
  authenticateToken,
  signedIn("a person's own profile"),
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
  signedIn("a person's own password"),
  validateChangePassword,
  adminController.changePassword
);

// =================== IMAGE UPLOAD ROUTES ===================

// Upload profile image only
router.post(
  "/profile/upload-image",
  authenticateToken,
  signedIn("a person's own picture"),
  uploadSingle("profileImage"),
  handleUploadError,
  adminController.uploadProfileImage
);

// (The company logo is the organisation's, not a person's: PUT /api/v1/company/profile.)

// =================== ADMIN MANAGEMENT ROUTES ===================

// Get admins by type
router.get("/type/:type", authenticateToken, requirePermission("users.view"), (req, res, next) => {
  req.query.type = req.params.type;
  adminController.getAllAdmins(req, res, next);
});

// Get active admins only
router.get("/status/active", authenticateToken, requirePermission("users.view"), (req, res, next) => {
  req.query.status = "active";
  adminController.getAllAdmins(req, res, next);
});

// Activate/Deactivate admin
router.patch("/:id/status", authenticateToken, requirePermission("users.manage"), async (req, res, next) => {
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
