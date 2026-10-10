// Who may do what to user accounts, as plain rules with no Mongoose and no request, so the whole
// table is tested without a server.
//
// Two things live here. First, which permissions each account type carries: the pre-save hook used to
// give all seven to every account, so `requirePermission` could never refuse anyone. Second, who may
// create, change or remove whom: without this, any signed-in user could promote themselves.
const roles = require("./permissions");
const ALL = ["users_manage", "inventory_manage", "transactions_manage", "transactions_approve", "financial_reports", "system_settings", "backup_restore"];

const BY_TYPE = {
  super_admin: ALL,
  admin: ALL.filter((p) => p !== "backup_restore"),
  manager: ["inventory_manage", "transactions_manage", "transactions_approve", "financial_reports"],
  operator: ["inventory_manage", "transactions_manage"],
  viewer: ["financial_reports"],
};

// An unknown type gets nothing. Falling back to "everything" is the mistake this file exists to undo.
const permissionsFor = (type) => [...(BY_TYPE[type] || [])];

// The two types that can manage other people's accounts.
const MANAGER_TYPES = ["super_admin", "admin"];

// May `actor` (an account type) do `action` to an account of `target` type, moving it to `nextType`?
// -> { ok: true } or { ok: false, code, message }. Rules:
//   - only a super_admin or admin manages accounts at all;
//   - only a super_admin creates, changes, promotes or removes an admin or super_admin account, so an
//     admin cannot make themselves, or anyone, more powerful than they are.
// The rules themselves now live with the roles (utils/permissions.js): holding users.manage, and a rank above the
// person being changed. This keeps the old call shape, with the types as role keys, so existing callers are unchanged.
function mayManage({ actor, target, nextType, self = false, action = "update" }) {
  return roles.mayManage({ actor, target, next: nextType, self, action });
}

// Fields nobody may set through a request body, whatever their role: they are the system's to write.
// companyId is among them: an account belongs to the organisation of whoever creates it, never to one
// the request names.
// roleKey is the one that matters most: the role IS the account's power, so it is only ever set through the users API,
// which checks the actor's rank. Left open here, "create an account" could name any role, owner included.
// twoFactor and sessionsRevokedAt are the account's own security: switching two-factor off needs the password and a code (POST
// /auth/2fa/disable), and ending every sign-in is a reset's doing. Left open here, a profile update with { twoFactor: { enabled: false } }
// would switch it off with neither.
const SYSTEM_FIELDS = ["permissions", "roleKey", "branchRoles", "twoFactor", "sessionsRevokedAt", "companyId", "createdBy", "updatedBy", "loginAttempts", "lockUntil", "lastLogin", "_id", "__v", "createdAt", "updatedAt"];

function withoutSystemFields(body) {
  const out = { ...(body || {}) };
  for (const k of SYSTEM_FIELDS) delete out[k];
  // ...and a path into one of them ("twoFactor.enabled"), which a document would also take as an assignment
  for (const k of Object.keys(out)) if (SYSTEM_FIELDS.some((f) => k.startsWith(`${f}.`))) delete out[k];
  return out;
}

module.exports = { ALL, BY_TYPE, permissionsFor, MANAGER_TYPES, mayManage, SYSTEM_FIELDS, withoutSystemFields };
