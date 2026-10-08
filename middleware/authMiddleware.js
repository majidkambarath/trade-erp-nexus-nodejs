const { verifyToken } = require("../services/core/adminService");
const { createAppError } = require("../utils/errorHandler");
const Admin = require("../models/core/adminModel");
const Organisation = require("../models/core/organisationModel");
const { permissionsFor } = require("../utils/adminPermissions");
const { runWithTenant, runUnscoped } = require("../utils/tenantContext");

// Who a token belongs to is decided by the DATABASE, not by what the token says. The account row names its
// organisation, its role and so its permissions, so a token cannot choose its organisation, and an
// administrator who is demoted or switched off loses that at once rather than when the token runs out.
// (The organisation in the token is only checked against the row.)
async function accountFor(decoded) {
  const admin = await runUnscoped("authentication: the account row names the organisation the token is checked against", () => Admin.findById(decoded.id));
  if (!admin || !admin.isActive || admin.status !== "active") return { failure: "ADMIN_INACTIVE", message: "Admin not found or inactive" };
  if (decoded.companyId && decoded.companyId !== admin.companyId) return { failure: "TOKEN_ORGANISATION_MISMATCH", message: "This token does not belong to this account's organisation" };
  const organisation = await Organisation.findOne({ code: admin.companyId });
  if (!organisation) return { failure: "ORGANISATION_NOT_FOUND", message: "This account's organisation could not be found" };
  return { admin, organisation };
}

const identityOf = (admin) => ({
  id: String(admin._id),
  email: admin.email,
  type: admin.type,
  permissions: permissionsFor(admin.type),
  name: admin.name,
  companyId: admin.companyId,
  branchId: admin.branchId,
});

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Access token is required",
        error: "MISSING_TOKEN",
      });
    }

    const decoded = verifyToken(token);

    const { admin, organisation, failure, message } = await accountFor(decoded);
    if (failure) return res.status(401).json({ success: false, message, error: failure });

    req.admin = identityOf(admin);
    req.organisation = organisation;
    req.tenant = { companyId: admin.companyId, branchId: admin.branchId };

    // Everything downstream - the route, the services, every query - runs as this organisation.
    return runWithTenant(req.tenant, next);
  } catch (error) {
    console.error("Authentication error:", error);
    return res.status(401).json({
      success: false,
      message: "Invalid token",
      error: error.message,
    });
  }
};

const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (token) {
      try {
        const decoded = verifyToken(token);
        const { admin, organisation, failure } = await accountFor(decoded);
        if (!failure) {
          req.admin = identityOf(admin);
          req.organisation = organisation;
          req.tenant = { companyId: admin.companyId, branchId: admin.branchId };
        }
      } catch (tokenError) {
        // Ignore token errors here
        console.warn("Optional auth token error:", tokenError.message);
      }
    }
    return req.tenant ? runWithTenant(req.tenant, next) : next();
  } catch (error) {
    next(error);
  }
};

const requirePermission = (requiredPermissions, requireAll = false) => (req, res, next) => {
  try {
    if (!req.admin) {
      throw createAppError("Authentication required", 401, "AUTH_REQUIRED");
    }

    const adminPermissions = req.admin.permissions || [];
    const permissions = Array.isArray(requiredPermissions) ? requiredPermissions : [requiredPermissions];

    const hasPermission = requireAll
      ? permissions.every((p) => adminPermissions.includes(p))
      : permissions.some((p) => adminPermissions.includes(p));

    if (!hasPermission) {
      throw createAppError(
        "Insufficient permissions",
        403,
        "INSUFFICIENT_PERMISSIONS",
        { required: permissions, current: adminPermissions }
      );
    }
    next();
  } catch (error) {
    next(error);
  }
};

const requireRole = (requiredRoles) => (req, res, next) => {
  try {
    if (!req.admin) {
      throw createAppError("Authentication required", 401, "AUTH_REQUIRED");
    }

    const adminRole = req.admin.type;
    const roles = Array.isArray(requiredRoles) ? requiredRoles : [requiredRoles];

    if (!roles.includes(adminRole)) {
      throw createAppError(
        "Insufficient role permissions",
        403,
        "INSUFFICIENT_ROLE",
        { required: roles, current: adminRole }
      );
    }
    next();
  } catch (error) {
    next(error);
  }
};

const requireSuperAdmin = (req, res, next) => {
  try {
    if (!req.admin) {
      throw createAppError("Authentication required", 401, "AUTH_REQUIRED");
    }

    if (req.admin.type !== "super_admin") {
      throw createAppError("Super admin access required", 403, "SUPER_ADMIN_REQUIRED");
    }
    next();
  } catch (error) {
    next(error);
  }
};

// Simple in-memory rate limiter for auth routes (per IP)
const authRateLimit = (windowMs = 15 * 60 * 1000, maxAttempts = 2) => {
  const attempts = new Map();

  return (req, res, next) => {
    const clientId = req.ip || req.connection.remoteAddress;
    const now = Date.now();

    // Clean up expired entries
    for (const [key, data] of attempts.entries()) {
      if (now - data.firstAttempt > windowMs) {
        attempts.delete(key);
      }
    }

    const clientAttempts = attempts.get(clientId);

    if (!clientAttempts) {
      attempts.set(clientId, { firstAttempt: now, count: 1 });
      return next();
    }

    if (now - clientAttempts.firstAttempt > windowMs) {
      attempts.set(clientId, { firstAttempt: now, count: 1 });
      return next();
    }

    if (clientAttempts.count >= maxAttempts) {
      const resetTime = new Date(clientAttempts.firstAttempt + windowMs);
      const err = createAppError(
        `Too many login attempts. Try again after ${resetTime.toLocaleTimeString()}`,
        429,
        "RATE_LIMIT_EXCEEDED"
      );
      return next(err);
    }

    clientAttempts.count++;
    next();
  };
};

module.exports = {
  authenticateToken,
  optionalAuth,
  requirePermission,
  requireRole,
  requireSuperAdmin,
  authRateLimit,
};
