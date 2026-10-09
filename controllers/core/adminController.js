const catchAsync = require("../../utils/catchAsync");
const adminService = require("../../services/core/adminService");
const { extractFileInfo } = require("../../middleware/upload");

// Login admin
// The refresh token lives in an httpOnly cookie, so page scripts never see it. It is scoped to the
// API path. Across sites (the deployed frontend and API are different hosts) it must be SameSite=None
// and Secure; same-site use (local development) can stay Lax.
const SESSION_COOKIE = "erp_session";
const SESSION_PATH = "/api/v1";

const sessionCookieOptions = (expires) => {
  const production = process.env.NODE_ENV === "production";
  const sameSite = process.env.SESSION_COOKIE_SAMESITE || (production ? "none" : "lax");
  return {
    httpOnly: true,
    secure: production || sameSite === "none",
    sameSite,
    path: SESSION_PATH,
    ...(expires ? { expires } : {}),
  };
};

exports.login = catchAsync(async (req, res) => {
  const { email, password } = req.body;
  const ipAddress = req.ip;

  const result = await adminService.loginAdmin(email, password, ipAddress, {
    userAgent: req.get("user-agent"),
  });
  const { refreshToken, refreshExpiresAt, ...tokens } = result.tokens;
  res.cookie(SESSION_COOKIE, refreshToken, sessionCookieOptions(refreshExpiresAt));
  res.status(200).json({
    success: true,
    message: "Login successful",
    data: { ...result, tokens },
  });
});

// Create new admin
exports.createAdmin = catchAsync(async (req, res) => {
  const adminData = req.body;
  const creatorId = req.admin?.id || null;
  
  // Handle uploaded files
  const files = {};
  if (req.files) {
    if (req.files.profileImage) {
      files.profileImage = req.files.profileImage[0];
    }
    if (req.files.companyLogo) {
      files.companyLogo = req.files.companyLogo[0];
    }
  }

  const admin = await adminService.createAdmin(adminData, files, creatorId, req.admin?.type);
  res.status(201).json({ 
    success: true, 
    message: "Admin created successfully", 
    data: admin 
  });
});

// Get admin by ID
exports.getAdmin = catchAsync(async (req, res) => {
  const { id } = req.params;
  
  const admin = await adminService.getAdminById(id);
  res.status(200).json({
    success: true,
    message: "Admin retrieved successfully",
    data: admin
  });
});

// Get all admins with pagination and filters
exports.getAllAdmins = catchAsync(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const filters = {
    type: req.query.type,
    status: req.query.status,
    search: req.query.search
  };

  const result = await adminService.getAllAdmins(page, limit, filters);
  res.status(200).json({
    success: true,
    message: "Admins retrieved successfully",
    data: result
  });
});

// Update admin
exports.updateAdmin = catchAsync(async (req, res) => {
  const { id } = req.params;
  const updateData = req.body;
  const updatedBy = req.admin?.id || null;

  // Handle uploaded files
  const files = {};
  if (req.files) {
    if (req.files.profileImage) {
      files.profileImage = req.files.profileImage[0];
    }
    if (req.files.companyLogo) {
      files.companyLogo = req.files.companyLogo[0];
    }
  }

  const admin = await adminService.updateAdmin(id, updateData, files, updatedBy, { actorType: req.admin?.type });
  res.status(200).json({
    success: true,
    message: "Admin updated successfully",
    data: admin
  });
});

// Update admin profile (for self-update)
exports.updateProfile = catchAsync(async (req, res) => {
  const adminId = req.admin.id;
  let updateData = { ...req.body };
  
  // Parse companyInfo if it's a string (from FormData)
  if (typeof updateData.companyInfo === 'string') {
    try {
      updateData.companyInfo = JSON.parse(updateData.companyInfo);
    } catch (error) {
      console.error("Error parsing companyInfo:", error);
      return res.status(400).json({
        success: false,
        message: "Invalid companyInfo format"
      });
    }
  }
  
  // Handle uploaded files
  const files = {};
  if (req.files) {
    if (req.files.profileImage && req.files.profileImage[0]) {
      files.profileImage = req.files.profileImage[0];
    }
    if (req.files.companyLogo && req.files.companyLogo[0]) {
      files.companyLogo = req.files.companyLogo[0];
    }
  }
  
  // Restrict certain fields from being updated by the user themselves
  delete updateData.type;
  delete updateData.permissions;
  delete updateData.status;
  delete updateData.isActive;
  delete updateData.createdBy;
  delete updateData.updatedBy;
  // The password changes only through change-password, which asks for the current one.
  delete updateData.password;

  try {
    const admin = await adminService.updateAdmin(adminId, updateData, files, adminId, { selfService: true });

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      data: admin
    });
  } catch (error) {
    console.error("Update Profile Error:", error);
    res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to update profile",
      error: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Delete admin
exports.deleteAdmin = catchAsync(async (req, res) => {
  const { id } = req.params;
  const deletedBy = req.admin?.id || null;

  const result = await adminService.deleteAdmin(id, deletedBy, req.admin?.type);
  res.status(200).json({
    success: true,
    message: result.message
  });
});

// Change password
exports.changePassword = catchAsync(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const adminId = req.admin.id;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      success: false,
      message: "Current password and new password are required"
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({
      success: false,
      message: "New password must be at least 8 characters"
    });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({
      success: false,
      message: "Choose a password you have not used here",
      error: "PASSWORD_UNCHANGED"
    });
  }

  // Get admin with password
  const Admin = require("../../models/core/adminModel");
  const admin = await Admin.findById(adminId).select("+password");
  
  if (!admin) {
    return res.status(404).json({
      success: false,
      message: "Admin not found"
    });
  }

  // Verify current password
  const isCurrentPasswordValid = await admin.comparePassword(currentPassword);
  if (!isCurrentPasswordValid) {
    return res.status(400).json({
      success: false,
      message: "Current password is incorrect"
    });
  }

  // Update password: from now on it is the person's own, and any lock-out from failed attempts is over
  admin.password = newPassword;
  admin.mustChangePassword = false;
  admin.passwordChangedAt = new Date();
  admin.loginAttempts = 0;
  admin.lockUntil = undefined;
  admin.$locals.updatedBy = adminId;
  await admin.save();

  res.status(200).json({
    success: true,
    message: "Password changed successfully"
  });
});

// Get current admin profile
exports.getProfile = catchAsync(async (req, res) => {
  const adminId = req.admin.id;
  
  const admin = await adminService.getAdminById(adminId);
  res.status(200).json({
    success: true,
    message: "Profile retrieved successfully",
    data: admin
  });
});

// Refresh token
// Renews the access token from the session cookie. The cookie is the only source: a refresh token
// sent in the body is not accepted, so script code cannot supply one.
exports.refreshToken = catchAsync(async (req, res) => {
  const token = await adminService.refreshAccessToken(req.cookies?.[SESSION_COOKIE]);
  res.status(200).json({
    success: true,
    message: "Token refreshed",
    data: token,
  });
});

// Ends this browser's session on the server and clears the cookie.
exports.logout = catchAsync(async (req, res) => {
  await adminService.logoutSession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
  res.status(200).json({ success: true, message: "Signed out" });
});

// Upload profile image only
exports.uploadProfileImage = catchAsync(async (req, res) => {
  const adminId = req.admin.id;
  
  if (!req.file) {
    return res.status(400).json({
      success: false,
      message: "No image file provided"
    });
  }

  const files = { profileImage: req.file };
  const admin = await adminService.updateAdmin(adminId, {}, files, adminId, { selfService: true });
  
  res.status(200).json({
    success: true,
    message: "Profile image uploaded successfully",
    data: admin
  });
});

