const { verifyToken } = require("../services/core/adminService");
const { createAppError } = require("../utils/errorHandler");
const Admin = require("../models/core/adminModel");
const Organisation = require("../models/core/organisationModel");
const Role = require("../models/core/roleModel");
const roles = require("../utils/permissions");
const orgLocale = require("../utils/orgLocale");

// While a person's password is one someone else chose, they may only choose their own: read who they are and what they may
// do (so the screen can show that), change the password, and sign out. Everything else is refused, the same way on every
// route, here where the person is identified.
const ONLY_WHEN_CHANGING_PASSWORD = [["PUT", "/api/v1/profile/change-password"], ["GET", "/api/v1/organisation/status"], ["GET", "/api/v1/profile/me"]];
const requestIs = (list, req) => {
  const url = String(req.originalUrl || "").split("?")[0].replace(/\/+$/, "");
  return list.some(([method, path]) => req.method === method && url === path);
};
const mayContinue = (req) => requestIs(ONLY_WHEN_CHANGING_PASSWORD, req);

// The same idea for an organisation that requires two-factor sign-in (Settings -> Security): until the person has set it up they
// may read who they are, and set it up - nothing else. Judged on every request from the database, like everything about identity.
const ONLY_WHEN_ENROLLING = [["POST", "/api/v1/auth/2fa/setup"], ["POST", "/api/v1/auth/2fa/enable"], ["GET", "/api/v1/organisation/status"], ["GET", "/api/v1/profile/me"]];
const mayEnrol = (req) => requestIs(ONLY_WHEN_ENROLLING, req);
const Branch = require("../models/core/branchModel");
const AppError = require("../utils/AppError");
const { runWithTenant, runUnscoped } = require("../utils/tenantContext");
const { requestRefusal, warningHeaders } = require("../utils/subscriptionGate");
const SecurityPolicyService = require("../services/core/securityPolicyService");
const AuthSession = require("../models/core/authSessionModel");

// Who a token belongs to is decided by the DATABASE, not by what the token says. The account row names its
// organisation, its role and so its permissions, so a token cannot choose its organisation, and an
// administrator who is demoted or switched off loses that at once rather than when the token runs out.
// (The organisation in the token is only checked against the row.)
const OBJECT_ID = /^[0-9a-f]{24}$/i;
async function accountFor(decoded) {
  // A refresh token is signed with the same key and names the same session, and lives thirty days: it renews a session and opens nothing.
  // (Access tokens issued before tokens said what they are for carry no `use` and are accepted until they expire.)
  if (decoded.type === "refresh" || decoded.use === "refresh") return { failure: "INVALID_TOKEN_TYPE", message: "A refresh token cannot open the API" };
  // The account id is a plain id and nothing else: an object here ({ $ne: null }) would be handed to the query as an operator.
  if (typeof decoded.id !== "string" || !OBJECT_ID.test(decoded.id)) return { failure: "INVALID_TOKEN", message: "Invalid token" };
  const sessionId = decoded.sid === undefined ? null : decoded.sid;
  if (sessionId !== null && typeof sessionId !== "string") return { failure: "INVALID_TOKEN", message: "Invalid token" };
  const [admin, session] = await runUnscoped("authentication: the account row names the organisation the token is checked against", () =>
    Promise.all([Admin.findById(decoded.id), sessionId ? AuthSession.findById(sessionId).select("adminId companyId revokedAt expiresAt").lean() : null])
  );
  if (!admin || !admin.isActive || admin.status !== "active") return { failure: "ADMIN_INACTIVE", message: "Admin not found or inactive" };
  // The session the token belongs to must still be open: signing out, a password change, an administrator's reset and a detected copy of
  // the refresh cookie all end it, and the access token they leave behind (good for minutes) ends with it. A token with no session at all is
  // one from before sessions existed; it can only be minted by the code that names none, so it cannot appear now, and it is still judged
  // by the account's own row above.
  if (sessionId !== null && (!session || session.revokedAt || session.expiresAt <= new Date() || String(session.adminId) !== String(admin._id) || session.companyId !== admin.companyId)) {
    return { failure: "SESSION_REVOKED", message: "Your session has ended. Please sign in again." };
  }
  // A password reset by email, or an administrator resetting someone's two-factor, ended every sign-in the person held: a token
  // issued in an earlier second than that moment is over, whatever time it had left. (Second precision: a token is stamped in whole
  // seconds, and one issued in the same second as the reset is the sign-in that came right after it.)
  if (admin.sessionsRevokedAt && decoded.iat && decoded.iat < Math.floor(admin.sessionsRevokedAt.getTime() / 1000)) {
    return { failure: "SESSION_REVOKED", message: "Your session has ended. Please sign in again." };
  }
  if (decoded.companyId && decoded.companyId !== admin.companyId) return { failure: "TOKEN_ORGANISATION_MISMATCH", message: "This token does not belong to this account's organisation" };
  const organisation = await Organisation.findOne({ code: admin.companyId });
  if (!organisation) return { failure: "ORGANISATION_NOT_FOUND", message: "This account's organisation could not be found" };
  orgLocale.warm(organisation); // its base currency and time zone, for everything this request does
  return { admin, organisation };
}

// The role a person holds, resolved from the database on every request like the rest of their identity: a built-in role
// is code, a custom one is a row of their own organisation. One that is missing or switched off holds NOTHING.
async function roleOf(admin, key = roles.roleKeyOf(admin)) {
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
  // Branches the person was given a role in. With any, their role is not the same everywhere, so they work in ONE branch at
  // a time and never in the all-branches view (which would let their strongest role apply to every branch at once).
  const given = (admin.branchRoles || []).map((b) => b.branchId);

  if (home !== HEAD_OFFICE) {
    const allowed = new Set([home, ...given]);
    if (asked && !allowed.has(asked)) return { failure: new AppError(given.length ? "You can only work in the branches you have been given" : "You can only work in your own branch", 403, "BRANCH_NOT_ALLOWED") };
    const target = asked || home;
    if (!(await active(target))) return { failure: new AppError(target === home ? "Your branch has been switched off. Please contact your administrator." : "That branch has been switched off. Please contact your administrator.", 403, "BRANCH_INACTIVE") };
    return { branchId: target, branchView: target };
  }
  if (!asked || asked === "all") return given.length ? { branchId: HEAD_OFFICE, branchView: HEAD_OFFICE } : { branchId: HEAD_OFFICE, branchView: null };
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
    role: role ? { key: role.key, name: role.name, rank: role.rank, builtIn: role.builtIn, active: role.isActive !== false, approvalLimit: role.approvalLimit ?? null } : { key: roles.roleKeyOf(admin), name: null, rank: 0, builtIn: false, active: false },
    grants,
    // the seven coarse permissions the token has always carried, now derived from the real ones
    permissions: roles.legacyPermissions(grants, role?.rank),
    name: admin.name,
    companyId: admin.companyId,
    branchId: admin.branchId,
    mustChangePassword: Boolean(admin.mustChangePassword),
    twoFactorEnabled: Boolean(admin.twoFactor?.enabled),
    // where they belong, and the branches they were given a role in (the role above is the one for the branch they are in)
    homeBranch: admin.branchId || HEAD_OFFICE,
    branchRoles: (admin.branchRoles || []).map((b) => ({ branchId: b.branchId, roleKey: b.roleKey })),
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

    // the role they hold in the branch they are working in (their own, unless they were given another for it)
    req.admin = identityOf(admin, await roleOf(admin, roles.roleKeyAt(admin, branch.branchId)));
    req.organisation = organisation;
    req.tenant = { companyId: admin.companyId, branchId: branch.branchId, branchView: branch.branchView };
    req.sessionId = decoded.sid || null; // the sign-in this request belongs to (turning two-factor on ends all the OTHERS)
    if (admin.mustChangePassword && !mayContinue(req)) {
      return next(new AppError("Please choose a new password of your own before you continue.", 403, "PASSWORD_CHANGE_REQUIRED"));
    }
    // An organisation may require two-factor of everyone. Someone who has not set it up may only set it up.
    // (not while the password gate above is closing - it already allows only choosing a password, which must stay possible)
    if (!admin.mustChangePassword && !admin.twoFactor?.enabled && !mayEnrol(req) && (await runWithTenant({ companyId: admin.companyId }, () => SecurityPolicyService.policy())).requireTwoFactor) {
      return next(new AppError("Your organisation requires two-factor sign-in. Set it up before you continue.", 403, "TWO_FACTOR_ENROLMENT_REQUIRED"));
    }

    // Everything downstream - the route, the services, every query - runs as this organisation, in this branch.
    return runWithTenant(req.tenant, next);
  } catch (error) {
    // A token problem we raised ourselves (expired, malformed, wrong kind) is told by its code. Anything else - a database error, a bug - is
    // logged here and told to nobody: the answer used to carry the error's own text (a cast error naming the query it choked on).
    const known = error instanceof AppError && error.statusCode === 401;
    if (!known) console.error("Authentication error:", error);
    const code = known ? error.code || "INVALID_TOKEN" : "INVALID_TOKEN";
    return res.status(401).json({
      success: false,
      message: code === "TOKEN_EXPIRED" ? "Token has expired" : "Invalid token",
      error: code,
      errorCode: code,
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
          req.admin = identityOf(admin, await roleOf(admin, roles.roleKeyAt(admin, admin.branchId || HEAD_OFFICE)));
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

module.exports = {
  authenticateToken,
  authenticateTokenAllowingBlocked,
  optionalAuth,
  requirePermission,
  requireRole,
  requireSuperAdmin,
};
