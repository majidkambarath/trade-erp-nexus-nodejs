const catchAsync = require("../../utils/catchAsync");
const adminService = require("../../services/core/adminService");
const { extractFileInfo } = require("../../middleware/upload");
const AuditService = require("../../services/core/auditService");
const { runWithTenant } = require("../../utils/tenantContext");

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
  // Two-factor is on: the password was right, nobody is signed in yet. No cookie, no tokens - a challenge for the second step.
  if (result.twoFactorRequired) {
    return res.status(200).json({
      success: true,
      message: "Enter the code from your authenticator app",
      data: { twoFactorRequired: true, challengeToken: result.challengeToken, expiresIn: result.challengeExpiresIn },
    });
  }
  sendSession(res, result);
});

// The session a successful sign-in opens: the refresh token in its httpOnly cookie, the access token in the body.
function sendSession(res, result) {
  const { refreshToken, refreshExpiresAt, ...tokens } = result.tokens;
  res.cookie(SESSION_COOKIE, refreshToken, sessionCookieOptions(refreshExpiresAt));
  res.status(200).json({
    success: true,
    message: "Login successful",
    data: { ...result, tokens },
  });
}

// Sign-in, step two (POST /auth/login/2fa): the challenge from step one plus a code or a recovery code.
exports.loginTwoFactor = catchAsync(async (req, res) => {
  const { challengeToken, code, recoveryCode } = req.body || {};
  const result = await adminService.completeTwoFactorLogin({ challengeToken, code, recoveryCode }, req.ip, { userAgent: req.get("user-agent") });
  // A recovery code is the way in when the phone is gone: say so in the organisation's trail and to the person, who may not have used it.
  if (result.signIn?.method === "recovery") {
    const who = result.admin;
    await runWithTenant({ companyId: who.companyId, branchId: who.branchId }, async () => {
      await AuditService.log({ req: { admin: { id: String(who._id || who.id), email: who.email }, ip: req.ip }, action: "TWO_FACTOR_RECOVERY_CODE_USED", entity: "Admin", entityId: who._id || who.id, summary: `${who.email} signed in with a recovery code (${result.signIn.recoveryCodesLeft} left)` });
    });
    require("../../services/core/accountSecurityService").notice(who, "A recovery code was used to sign in", `${result.signIn.recoveryCodesLeft} recovery code(s) are left. Replace them in Settings -> Security if you are running low.`);
  }
  sendSession(res, result);
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
    // what we raised ourselves is told in its own words; anything else (a database error) is not told at all
    res.status(error.isOperational ? error.statusCode || 400 : 500).json({
      success: false,
      message: error.isOperational ? error.message : "Failed to update profile",
      errorCode: error.isOperational ? error.code : "INTERNAL_ERROR",
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
// The current password is asked for, and a wrong one is COUNTED toward the account's lock like a wrong password at the sign-in door:
// a stolen session must not be able to guess it here, without limit, and then replace it. (400 and not 401: a 401 makes the browser
// think the session ended and sign the person out.) On success every OTHER sign-in of the person ends; this one carries on.
exports.changePassword = catchAsync(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const adminId = req.admin.id;

  if (typeof currentPassword !== "string" || typeof newPassword !== "string" || !currentPassword || !newPassword) {
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
  if (newPassword.length > 200 || currentPassword.length > 1000) {
    return res.status(400).json({
      success: false,
      message: "That password is too long",
      error: "WEAK_PASSWORD"
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
  const admin = await Admin.findById(adminId).select("+password +loginAttempts +lockUntil");

  if (!admin) {
    return res.status(404).json({
      success: false,
      message: "Admin not found"
    });
  }

  if (admin.isLocked) throw adminService.lockedError(admin.lockUntil);
  const attempt = await admin.reserveAttempt(); // counted before the password is weighed: parallel guesses get no extra
  if (attempt.locked) throw adminService.lockedError(attempt.lockUntil);

  // Verify current password
  const isCurrentPasswordValid = await admin.comparePassword(currentPassword);
  if (!isCurrentPasswordValid) {
    return res.status(400).json({
      success: false,
      message: "Current password is incorrect",
      error: "PASSWORD_INCORRECT",
      errorCode: "PASSWORD_INCORRECT"
    });
  }

  // Update password: from now on it is the person's own
  admin.password = newPassword;
  admin.mustChangePassword = false;
  admin.passwordChangedAt = new Date();
  admin.$locals.updatedBy = adminId;
  await admin.save();
  await admin.resetLoginAttempts(); // any lock-out from failed attempts is over
  // whoever else holds a sign-in of this person (a thief with an old password, a forgotten browser) is out; this browser stays in
  await adminService.endSessionsOf(admin._id, req.sessionId);

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
  const { refreshToken, refreshExpiresAt, ...token } = await adminService.refreshAccessToken(req.cookies?.[SESSION_COOKIE]);
  // Every refresh replaces the cookie (a stolen copy of an old one is then recognisable). The new token is in the cookie and nowhere else.
  if (refreshToken) res.cookie(SESSION_COOKIE, refreshToken, sessionCookieOptions(refreshExpiresAt));
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

