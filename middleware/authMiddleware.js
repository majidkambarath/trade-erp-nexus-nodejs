const { verifyToken } = require("../services/core/adminService");
const { createAppError } = require("../utils/errorHandler");
const Admin = require("../models/core/adminModel");

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

    const admin = await Admin.findById(decoded.id);
    if (!admin || !admin.isActive || admin.status !== "active") {
      return res.status(401).json({
        success: false,
        message: "Admin not found or inactive",
        error: "ADMIN_INACTIVE",
      });
    }

    req.admin = {
      id: decoded.id,
      email: decoded.email,
      type: decoded.type,
      permissions: decoded.permissions,
      name: decoded.name,
    };

    next();
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
        const admin = await Admin.findById(decoded.id);

        if (admin && admin.isActive && admin.status === "active") {
          req.admin = {
            id: decoded.id,
            email: decoded.email,
            type: decoded.type,
            permissions: decoded.permissions,
            name: decoded.name,
          };
        }
      } catch (tokenError) {
        // Ignore token errors here
        console.warn("Optional auth token error:", tokenError.message);
      }
    }
    next();
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
