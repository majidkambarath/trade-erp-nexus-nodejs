const Admin = require("../../models/core/adminModel");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const AuthSession = require("../../models/core/authSessionModel");
const AppError = require("../../utils/AppError");
const Organisation = require("../../models/core/organisationModel");
const { runWithTenant, runUnscoped } = require("../../utils/tenantContext");
const { permissionsFor, mayManage, withoutSystemFields } = require("../../utils/adminPermissions");
const { deleteFromCloudinary } = require("../../middleware/upload");
const { signInRefusal } = require("../../utils/subscriptionGate");
const { subscriptionState } = require("../../utils/plans");
const UsageService = require("./usageService");
const Branch = require("../../models/core/branchModel");

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";
// Short access tokens: a stolen one stops working within minutes, and the session cookie renews it.
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "15m";
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || "30d";

// Generate JWT tokens. Both name the session (`sid`), so ending the session ends both.
const generateTokens = (payload, sid) => {
  const accessToken = jwt.sign({ ...payload, sid }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
    issuer: "ERP-system",
    audience: "ERP-admin",
  });

  const refreshToken = jwt.sign({ id: payload.id, sid, type: "refresh" }, JWT_SECRET, {
    expiresIn: JWT_REFRESH_EXPIRES_IN,
    issuer: "ERP-system",
    audience: "ERP-admin",
  });

  return { accessToken, refreshToken };
};

// Verify token
const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET, {
      issuer: "ERP-system",
      audience: "ERP-admin",
    });
  } catch (error) {
    if (error.name === "TokenExpiredError")
      throw new AppError("Token has expired", 401, "TOKEN_EXPIRED");
    if (error.name === "JsonWebTokenError")
      throw new AppError("Invalid token", 401, "INVALID_TOKEN");
    throw new AppError("Token verification failed", 401, "TOKEN_ERROR");
  }
};

// Admin login
const loginAdmin = async (email, password, ipAddress = null, context = {}) => {
  if (!email || !password)
    throw new AppError(
      "Email and password are required",
      400,
      "MISSING_CREDENTIALS"
    );

  // The one moment no organisation is known: a person types an email, and the account row says which
  // organisation they belong to. Everything after this runs as that organisation.
  const admin = await runUnscoped("sign-in: the account is found by its email, before any organisation is known", () =>
    Admin.findOne({ email: email.toLowerCase(), isActive: true }).select("+password +loginAttempts +lockUntil")
  );

  if (!admin)
    throw new AppError("Invalid email or password", 401, "INVALID_CREDENTIALS");

  const organisation = await assertOrganisationOpen(admin.companyId);
  const result = await runWithTenant({ companyId: admin.companyId, branchId: admin.branchId }, () => finishLogin(admin, password, ipAddress, context));
  // Where the subscription stands, so the app can warn in the grace period or explain a read-only organisation
  // before the first thing is refused.
  return { ...result, subscription: subscriptionState(organisation) };
};

// An account whose organisation is gone must not sign in, and neither must one whose organisation is suspended,
// closed, or past the end of its subscription (unless that organisation is set to read-only, which may still
// sign in and look). The refusal says which, and when it ended, so the screen can tell the person.
const assertOrganisationOpen = async (companyId) => {
  const organisation = await Organisation.findOne({ code: companyId });
  if (!organisation) throw new AppError("This account's organisation could not be found. Please contact support.", 403, "ORGANISATION_NOT_FOUND");
  const refusal = signInRefusal(organisation);
  if (refusal) throw refusal;
  return organisation;
};

// Password check, lock-out, token and session: all as the account's own organisation.
const finishLogin = async (admin, password, ipAddress, context) => {
  if (admin.isLocked) {
    const lockTime = Math.ceil((admin.lockUntil - Date.now()) / (1000 * 60));
    throw new AppError(
      `Account locked. Try after ${lockTime} minutes`,
      423,
      "ACCOUNT_LOCKED"
    );
  }

  const isValid = await admin.comparePassword(password);
  if (!isValid) {
    await admin.incLoginAttempts();
    throw new AppError("Invalid email or password", 401, "INVALID_CREDENTIALS");
  }

  if (admin.loginAttempts > 0) await admin.resetLoginAttempts();

  admin.lastLogin = new Date();
  await admin.save();

  const tokenPayload = {
    id: admin._id,
    email: admin.email,
    type: admin.type,
    permissions: permissionsFor(admin.type), // derived: what an old row once stored is ignored
    name: admin.name,
    companyId: admin.companyId,
    branchId: admin.branchId,
  };

  // One session per sign-in. The refresh token names it, so logout can end exactly this one.
  const sid = crypto.randomUUID();
  const { accessToken, refreshToken } = generateTokens(tokenPayload, sid);
  const refreshExpiresAt = new Date(jwt.decode(refreshToken).exp * 1000);
  await AuthSession.create({
    _id: sid,
    adminId: admin._id,
    userAgent: context.userAgent || null,
    ip: ipAddress,
    expiresAt: refreshExpiresAt,
  });

  return {
    admin: admin.toJSON(),
    tokens: { accessToken, refreshToken, refreshExpiresAt, expiresIn: JWT_EXPIRES_IN },
    loginInfo: { lastLogin: admin.lastLogin, ipAddress },
  };
};

// Create new admin
// Throws when this actor may not do this to this account. Done inside the service, after any upload, so a
// refused request still passes through the cleanup below instead of leaving files behind.
const assertMay = (args) => {
  const verdict = mayManage(args);
  if (!verdict.ok) throw new AppError(verdict.message, 403, verdict.code);
};

const createAdmin = async (adminData, files = null, creatorId = null, actorType = null) => {
  adminData = withoutSystemFields(adminData);
  // The company's letterhead belongs to the organisation (services/core/companyProfileService.js), never to a person.
  delete adminData.companyInfo;
  if (!actorType) throw new AppError("Authentication required", 401, "AUTH_REQUIRED");
  try {
    assertMay({ actor: actorType, nextType: adminData.type, action: "create" });
  } catch (error) {
    if (files?.profileImage) await deleteFromCloudinary(files.profileImage.filename);
    if (files?.companyLogo) await deleteFromCloudinary(files.companyLogo.filename);
    throw error;
  }
  const existing = await Admin.findOne({
    email: adminData.email.toLowerCase(),
  });
  if (existing) throw new AppError("Email already exists", 400, "EMAIL_EXISTS");

  try {
    // The plan allows only so many people. Checked after the permission and duplicate checks, so a refusal for
    // those reasons is not hidden behind this one, and inside the try so an upload is cleaned up when it refuses.
    await UsageService.assertRoom("users");

    // a person belongs to a branch that exists in this organisation and is switched on (the head office is always there)
    if (adminData.branchId && String(adminData.branchId).toLowerCase() !== "main") {
      const code = String(adminData.branchId).toLowerCase();
      if (!(await Branch.exists({ code, isActive: true }))) throw new AppError("That branch does not exist in this organisation", 400, "BRANCH_NOT_FOUND");
      adminData.branchId = code;
    }

    // Handle profile image
    if (files?.profileImage) {
      adminData.profileImage = {
        url: files.profileImage.path,
        publicId: files.profileImage.filename
      };
    }

    // A company logo sent with a person is not kept on the person: it is discarded (and removed from storage).
    if (files?.companyLogo) { await deleteFromCloudinary(files.companyLogo.filename).catch(() => {}); files = { ...files, companyLogo: null }; }

    const admin = new Admin({ ...adminData, mustChangePassword: true, createdBy: creatorId });
    await admin.save();
    return admin.toJSON();
  } catch (error) {
    // Cleanup uploaded files if admin creation fails
    if (files?.profileImage) {
      await deleteFromCloudinary(files.profileImage.filename);
    }
    if (files?.companyLogo) {
      await deleteFromCloudinary(files.companyLogo.filename);
    }
    throw error;
  }
};

// Update admin
// policy is { actorType } for one person managing another, or { selfService: true } for the profile screen,
// where a person edits only themselves (that route has already removed type, status and the rest). With
// neither, it refuses: a new caller that forgets the policy must fail, not pass.
const updateAdmin = async (adminId, updateData, files = null, updatedBy = null, policy = {}) => {
  updateData = withoutSystemFields(updateData);
  delete updateData.companyInfo; // the letterhead is the organisation's, changed through /company/profile
  const admin = await Admin.findById(adminId);
  if (!admin) {
    // Cleanup uploaded files if admin not found
    if (files?.profileImage) {
      await deleteFromCloudinary(files.profileImage.filename);
    }
    if (files?.companyLogo) {
      await deleteFromCloudinary(files.companyLogo.filename);
    }
    throw new AppError("Admin not found", 404, "ADMIN_NOT_FOUND");
  }

  try {
    if (!policy.selfService) {
      if (!policy.actorType) throw new AppError("Authentication required", 401, "AUTH_REQUIRED");
      assertMay({ actor: policy.actorType, target: admin.type, nextType: updateData.type, self: String(admin._id) === String(updatedBy), action: "update" });
      // Switching someone back on takes a seat again, so it meets the plan's user limit just as adding a new person does
      // (the same rule userService applies on the new users API). Inside the try: a refusal cleans up its uploads.
      const flag = (value, otherwise) => (value === undefined ? otherwise : value === true || value === "true"); // a form sends text
      const wasActive = admin.isActive !== false && admin.status === "active";
      const willBeActive = flag(updateData.isActive, admin.isActive !== false) && (updateData.status ?? admin.status) === "active";
      if (!wasActive && willBeActive) await UsageService.assertRoom("users");
    }
    // Store old image public IDs for cleanup
    const oldProfileImageId = admin.profileImage?.publicId;

    // Handle profile image update
    if (files?.profileImage) {
      updateData.profileImage = {
        url: files.profileImage.path,
        publicId: files.profileImage.filename
      };
    }

    // A company logo sent with a person is not kept on the person: it is discarded (and removed from storage).
    if (files?.companyLogo) { await deleteFromCloudinary(files.companyLogo.filename).catch(() => {}); files = { ...files, companyLogo: null }; }

    // Set the updatedBy field using $locals
    if (updatedBy) {
      admin.$locals = admin.$locals || {};
      admin.$locals.updatedBy = updatedBy;
    }

    // A password set by someone else (an administrator resetting it) is theirs to replace at the next sign-in.
    if (!policy.selfService && updateData.password) { updateData.mustChangePassword = true; updateData.lockUntil = undefined; updateData.loginAttempts = 0; }

    // Apply updates to the admin object
    Object.assign(admin, updateData);
    
    // Save the updated admin
    const savedAdmin = await admin.save();

    // Delete old images from Cloudinary after successful update
    if (files?.profileImage && oldProfileImageId) {
      await deleteFromCloudinary(oldProfileImageId);
    }

    return savedAdmin.toJSON();
  } catch (error) {
    // Cleanup new uploaded files if update fails
    if (files?.profileImage) {
      await deleteFromCloudinary(files.profileImage.filename);
    }
    if (files?.companyLogo) {
      await deleteFromCloudinary(files.companyLogo.filename);
    }
    throw error;
  }
};

// Get admin by ID
const getAdminById = async (adminId) => {
  const admin = await Admin.findById(adminId)
    .populate('createdBy', 'name email')
    .populate('updatedBy', 'name email');
  
  if (!admin) {
    throw new AppError("Admin not found", 404, "ADMIN_NOT_FOUND");
  }
  
  return admin.toJSON();
};

// Get all admins with pagination
const getAllAdmins = async (page = 1, limit = 10, filters = {}) => {
  const skip = (page - 1) * limit;
  
  // Build query
  const query = { isActive: true };
  if (filters.type) query.type = filters.type;
  if (filters.status) query.status = filters.status;
  if (filters.search) {
    query.$or = [
      { name: { $regex: filters.search, $options: 'i' } },
      { email: { $regex: filters.search, $options: 'i' } },
      { 'companyInfo.companyName': { $regex: filters.search, $options: 'i' } }
    ];
  }

  const [admins, total] = await Promise.all([
    Admin.find(query)
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    Admin.countDocuments(query)
  ]);

  return {
    admins: admins.map(admin => admin.toJSON()),
    pagination: {
      current: page,
      pages: Math.ceil(total / limit),
      total,
      limit
    }
  };
};

// Delete admin (soft delete)
const deleteAdmin = async (adminId, deletedBy = null, actorType = null) => {
  if (!actorType) throw new AppError("Authentication required", 401, "AUTH_REQUIRED");
  const admin = await Admin.findById(adminId);
  if (!admin) {
    throw new AppError("Admin not found", 404, "ADMIN_NOT_FOUND");
  }
  assertMay({ actor: actorType, target: admin.type, self: String(admin._id) === String(deletedBy), action: "delete" });

  // Set admin as inactive instead of hard delete
  admin.isActive = false;
  admin.status = 'inactive';
  if (deletedBy) {
    admin.$locals.updatedBy = deletedBy;
  }
  await admin.save();

  // Optionally delete images from Cloudinary
  const imagesToDelete = [];
  if (admin.profileImage?.publicId) {
    imagesToDelete.push(admin.profileImage.publicId);
  }
  // (not companyInfo.companyLogo: the organisation's adopted letterhead may use that very image)
  
  if (imagesToDelete.length > 0) {
    await deleteFromCloudinary(imagesToDelete);
  }

  return { message: 'Admin deleted successfully' };
};

const SESSION_ENDED = "Your session has ended. Please sign in again.";

// Refresh: the refresh token must name a session that is still open. Logging out, or an admin being
// deactivated, ends it, so the next refresh fails and the browser shows the sign-in page.
const refreshAccessToken = async (refreshToken) => {
  if (!refreshToken) throw new AppError(SESSION_ENDED, 401, "SESSION_REVOKED");

  const decoded = verifyToken(refreshToken);
  if (decoded.type !== "refresh")
    throw new AppError("Invalid token type", 401, "INVALID_TOKEN_TYPE");

  // The session id is a random secret that names its own organisation, so it is found with none in scope.
  const session = await runUnscoped("refresh: the session id is a secret that names its own organisation", () => AuthSession.findById(decoded.sid));
  if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.companyId)
    throw new AppError(SESSION_ENDED, 401, "SESSION_REVOKED");

  await assertOrganisationOpen(session.companyId);
  const { admin } = await runWithTenant({ companyId: session.companyId }, async () => {
    const found = await Admin.findById(decoded.id);
    if (!found || !found.isActive || found.status !== "active")
      throw new AppError("Admin not found or inactive", 401, "ADMIN_INACTIVE");
    await AuthSession.updateOne({ _id: session._id }, { lastSeenAt: new Date() });
    return { admin: found };
  });

  const tokenPayload = {
    id: admin._id,
    email: admin.email,
    type: admin.type,
    permissions: permissionsFor(admin.type), // derived: what an old row once stored is ignored
    name: admin.name,
    companyId: admin.companyId,
    branchId: admin.branchId,
  };
  const { accessToken } = generateTokens(tokenPayload, session._id);

  return { accessToken, expiresIn: JWT_EXPIRES_IN, admin: admin.toJSON() };
};

// Logout: revoke this browser's session. An expired or unsigned token has nothing to revoke.
const logoutSession = async (refreshToken) => {
  if (!refreshToken) return;
  let decoded;
  try {
    decoded = jwt.verify(refreshToken, JWT_SECRET, {
      issuer: "ERP-system",
      audience: "ERP-admin",
      ignoreExpiration: true,
    });
  } catch {
    return;
  }
  if (decoded?.type === "refresh" && decoded.sid) {
    await runUnscoped("logout: the session id is a secret that names the session to end", () =>
      AuthSession.updateOne({ _id: decoded.sid, revokedAt: null }, { revokedAt: new Date() })
    );
  }
};

module.exports = {
  loginAdmin,
  logoutSession,
  createAdmin,
  updateAdmin,
  getAdminById,
  getAllAdmins,
  deleteAdmin,
  refreshAccessToken,
  verifyToken,
  generateTokens,
};