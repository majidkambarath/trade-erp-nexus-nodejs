const { verifyToken } = require("../services/core/adminService");
const { createAppError } = require("../utils/errorHandler");
const Admin = require("../models/core/adminModel");
const Organisation = require("../models/core/organisationModel");
const Role = require("../models/core/roleModel");
const roles = require("../utils/permissions");
const Branch = require("../models/core/branchModel");
const AppError = require("../utils/AppError");
const { runWithTenant, runUnscoped } = require("../utils/tenantContext");
const { requestRefusal, warningHeaders } = require("../utils/subscriptionGate");

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

// The role a person holds, resolved from the database on every request like the rest of their identity: a built-in role
// is code, a custom one is a row of their own organisation. One that is missing or switched off holds NOTHING.
async function roleOf(admin) {
  const key = roles.roleKeyOf(admin);
  if (roles.isBuiltIn(key)) return roles.resolveRole(key);
  const row = await runWithTenant({ companyId: admin.companyId }, () => Role.findOne({ key }).lean());
  return roles.resolveRole(key, row ? [row] : []);
}

const HEAD_OFFICE = "main";

// Which branch a request works in, and which branch's documents it may see.
//   A branch user works in their own branch, always: the X-Branch header may only repeat it.
//   A head-office user works in the head office and sees every branch, unless the header names a branch: then they
//   work in that branch and see only it. (The header is sent by the branch switcher; it is checked every time.)
async function resolveBranch(admin, header) {
  const home = admin.branchId || HEAD_OFFICE;
  const asked = String(header || "").trim().toLowerCase();
  const active = (code) => runWithTenant({ companyId: admin.companyId, branchId: home }, () => Branch.exists({ code, isActive: true }));

  if (home !== HEAD_OFFICE) {
    if (asked && asked !== home) return { failure: new AppError("You can only work in your own branch", 403, "BRANCH_NOT_ALLOWED") };
    if (!(await active(home))) return { failure: new AppError("Your branch has been switched off. Please contact your administrator.", 403, "BRANCH_INACTIVE") };
    return { branchId: home, branchView: home };
  }
  if (!asked || asked === "all") return { branchId: HEAD_OFFICE, branchView: null };
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(asked) || !(await active(asked))) return { failure: new AppError("That branch was not found", 403, "BRANCH_NOT_FOUND") };
  return { branchId: asked, branchView: asked };
}

const identityOf = (admin, role) => {
  const grants = roles.grantsOf(role);
  return {
    id: String(admin._id),
    email: admin.email,
    type: admin.type,
    // what the person may do: their role and the permissions it expands to (utils/permissions.js)
    role: role ? { key: role.key, name: role.name, rank: role.rank, builtIn: role.builtIn, active: role.isActive !== false } : { key: roles.roleKeyOf(admin), name: null, rank: 0, builtIn: false, active: false },
    grants,
    // the seven coarse permissions the token has always carried, now derived from the real ones
    permissions: roles.legacyPermissions(grants, role?.rank),
    name: admin.name,
    companyId: admin.companyId,
    branchId: admin.branchId,
  };
};

// `allowBlocked` is for the one route that has to answer an organisation whose subscription has ended (the screen that
// tells it so, and when to renew). Everything else is refused while the organisation is blocked, and while it is
// read-only anything but a read.
const makeAuthenticator = ({ allowBlocked = false } = {}) => async (req, res, next) => {
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

    if (!allowBlocked) {
      const refusal = requestRefusal(organisation, req.method);
      if (refusal) return next(refusal);
    }
    res.set(warningHeaders(organisation));

    const branch = await resolveBranch(admin, req.get("x-branch"));
    if (branch.failure) return next(branch.failure);

    req.admin = identityOf(admin, await roleOf(admin));
    req.organisation = organisation;
    req.tenant = { companyId: admin.companyId, branchId: branch.branchId, branchView: branch.branchView };

    // Everything downstream - the route, the services, every query - runs as this organisation, in this branch.
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

const authenticateToken = makeAuthenticator();
const authenticateTokenAllowingBlocked = makeAuthenticator({ allowBlocked: true });

const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (token) {
      try {
        const decoded = verifyToken(token);
        const { admin, organisation, failure } = await accountFor(decoded);
        // An organisation that may not use the system (or not change anything) is treated as anonymous here.
        if (!failure && !requestRefusal(organisation, req.method)) {
          req.admin = identityOf(admin, await roleOf(admin));
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
  authenticateTokenAllowingBlocked,
  optionalAuth,
  requirePermission,
  requireRole,
  requireSuperAdmin,
  authRateLimit,
};
