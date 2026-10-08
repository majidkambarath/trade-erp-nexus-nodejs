// Who may do what to user accounts, as plain rules with no Mongoose and no request, so the whole
// table is tested without a server.
//
// Two things live here. First, which permissions each account type carries: the pre-save hook used to
// give all seven to every account, so `requirePermission` could never refuse anyone. Second, who may
// create, change or remove whom: without this, any signed-in user could promote themselves.
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
const PRIVILEGED = ["super_admin", "admin"];

// May `actor` (an account type) do `action` to an account of `target` type, moving it to `nextType`?
// -> { ok: true } or { ok: false, code, message }. Rules:
//   - only a super_admin or admin manages accounts at all;
//   - only a super_admin creates, changes, promotes or removes an admin or super_admin account, so an
//     admin cannot make themselves, or anyone, more powerful than they are.
function mayManage({ actor, target, nextType, self = false, action = "update" }) {
  if (!MANAGER_TYPES.includes(actor)) {
    return { ok: false, code: "INSUFFICIENT_ROLE", message: "Only an administrator can manage user accounts." };
  }
  if (actor === "super_admin") {
    if (self && action === "delete") return { ok: false, code: "CANNOT_REMOVE_SELF", message: "You cannot remove your own account." };
    return { ok: true };
  }
  // actor is "admin"
  if (self && action === "delete") return { ok: false, code: "CANNOT_REMOVE_SELF", message: "You cannot remove your own account." };
  if (target && PRIVILEGED.includes(target)) {
    return { ok: false, code: "SUPER_ADMIN_REQUIRED", message: "Only a super administrator can change an administrator account." };
  }
  if (nextType && PRIVILEGED.includes(nextType)) {
    return { ok: false, code: "SUPER_ADMIN_REQUIRED", message: "Only a super administrator can make someone an administrator." };
  }
  return { ok: true };
}

// Fields nobody may set through a request body, whatever their role: they are the system's to write.
const SYSTEM_FIELDS = ["permissions", "createdBy", "updatedBy", "loginAttempts", "lockUntil", "lastLogin", "_id", "__v", "createdAt", "updatedAt"];

function withoutSystemFields(body) {
  const out = { ...(body || {}) };
  for (const k of SYSTEM_FIELDS) delete out[k];
  return out;
}

module.exports = { ALL, BY_TYPE, permissionsFor, MANAGER_TYPES, mayManage, SYSTEM_FIELDS, withoutSystemFields };
