// The people of an organisation who sign in, managed by its own administrators. Who may touch whom is rank
// (utils/permissions.js mayManage); what an account holds is its role (services/core/roleService.js). The older
// account routes in adminRouter still exist, but only this one can give a person a role of their own.
const Admin = require("../../models/core/adminModel");
const Branch = require("../../models/core/branchModel");
const AppError = require("../../utils/AppError");
const roles = require("../../utils/permissions");
const { runUnscoped } = require("../../utils/tenantContext");
const UsageService = require("./usageService");
const RoleService = require("./roleService");
const TwoFactorService = require("./twoFactorService");
const AuthSession = require("../../models/core/authSessionModel");

const clean = (v) => String(v ?? "").trim();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// How a role is stored on the account. The five types that existed before roles stay in `type` with no roleKey; every
// other role goes in roleKey over the safest type, "viewer", so anything still reading the type fails closed.
const stored = (key) => (roles.LEGACY_TYPES.includes(key) ? { type: key, roleKey: null } : { type: "viewer", roleKey: key });

const roleCard = (key, role) => (role
  ? { key: role.key, name: role.name, rank: role.rank, builtIn: role.builtIn, active: role.isActive !== false }
  : { key, name: null, rank: 0, builtIn: false, active: false });

// `found` maps role keys to the roles the screen needs named; the branch roles are looked up in it too
const present = (account, role, found = new Map()) => ({
  id: String(account._id),
  name: account.name,
  email: account.email,
  role: roleCard(roles.roleKeyOf(account), role),
  // where this person holds a different role from their own, and which one
  branchRoles: (account.branchRoles || []).map((b) => ({ branchId: b.branchId, role: roleCard(b.roleKey, found.get(b.roleKey)) })),
  branchId: account.branchId,
  status: account.status,
  isActive: account.isActive,
  twoFactorEnabled: Boolean(account.twoFactor?.enabled), // on or off, so an administrator can see who has it; nothing about the secret
  lastLogin: account.lastLogin || null,
  createdAt: account.createdAt,
});

const guard = (verdict) => {
  if (!verdict.ok) throw new AppError(verdict.message, 403, verdict.code);
};

// the role a request names, which must exist, be switched on, and be one the actor may hand out
async function targetRole(key) {
  const role = await RoleService.find(clean(key).toLowerCase());
  if (!role) throw new AppError("That role does not exist in this organisation", 400, "ROLE_NOT_FOUND");
  if (role.isActive === false) throw new AppError("That role has been switched off", 400, "ROLE_INACTIVE");
  return role;
}

// The roles a person is given for particular branches, checked: each branch real and switched on, each role real and switched on
// and one the actor may hand out (nothing at or above their own rank), a branch named once.
async function checkBranchRoles(list, actor) {
  if (!Array.isArray(list)) throw new AppError("Branch roles must be a list", 400, "BRANCH_ROLES_INVALID");
  if (list.length > 25) throw new AppError("That is more branch roles than a person can hold", 400, "BRANCH_ROLES_INVALID");
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const branchId = clean(entry?.branchId).toLowerCase();
    const key = clean(entry?.role ?? entry?.roleKey).toLowerCase();
    if (!branchId || !key) throw new AppError("Each branch role needs a branch and a role", 400, "BRANCH_ROLES_INVALID");
    if (seen.has(branchId)) throw new AppError("A person has one role in a branch", 400, "DUPLICATE_BRANCH_ROLE");
    seen.add(branchId);
    await checkBranch(branchId);
    const role = await targetRole(key);
    guard(roles.mayManage({ actor, next: role, action: "update" }));
    out.push({ branchId, roleKey: role.key });
  }
  return out;
}

// the roles named for a set of accounts, looked up once
async function rolesNamedBy(accounts) {
  const keys = new Set();
  for (const a of accounts) {
    keys.add(roles.roleKeyOf(a));
    for (const b of a.branchRoles || []) keys.add(b.roleKey);
  }
  const found = new Map();
  for (const k of keys) found.set(k, await RoleService.find(k));
  return found;
}

async function checkBranch(code) {
  const branch = clean(code || "main").toLowerCase();
  if (branch !== "main" && !(await Branch.exists({ code: branch, isActive: true }))) throw new AppError("That branch does not exist in this organisation", 400, "BRANCH_NOT_FOUND");
  return branch;
}

// the owner is the way back in: an organisation is never left without an active one
async function assertNotLastOwner(account) {
  const owns = (a) => a.type === "super_admin" && !a.roleKey;
  if (!owns(account) || !account.isActive || account.status !== "active") return;
  const others = await Admin.countDocuments({ type: "super_admin", roleKey: null, isActive: true, status: "active", _id: { $ne: account._id } });
  if (others === 0) throw new AppError("That is the organisation's last active owner. Make someone else an owner first.", 409, "LAST_OWNER");
}

class UserService {
  static async list({ search, status } = {}) {
    const q = {};
    if (status === "active") Object.assign(q, { isActive: true, status: "active" });
    if (status === "inactive") q.$or = [{ isActive: false }, { status: { $ne: "active" } }];
    if (search) {
      const r = new RegExp(clean(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      q.$and = [{ $or: [{ name: r }, { email: r }] }];
    }
    const rows = await Admin.find(q).select("name email type roleKey branchRoles branchId status isActive lastLogin createdAt twoFactor.enabled").sort({ createdAt: 1 }).lean();
    const found = await rolesNamedBy(rows);
    return rows.map((a) => present(a, found.get(roles.roleKeyOf(a)), found));
  }

  static async create(input, req) {
    const actor = RoleService.actorOf(req);
    const name = clean(input.name);
    const email = clean(input.email).toLowerCase();
    if (name.length < 2) throw new AppError("The person needs a name", 400, "NAME_REQUIRED");
    if (!EMAIL.test(email)) throw new AppError("Enter a valid email address", 400, "EMAIL_INVALID");
    if (String(input.password || "").length < 8) throw new AppError("A password needs at least 8 characters", 400, "WEAK_PASSWORD");
    const role = await targetRole(input.role || "viewer");
    guard(roles.mayManage({ actor, next: role, action: "create" }));

    // an email belongs to one person in one organisation, so whether it is taken is a question about EVERY organisation
    if (await runUnscoped("an email address is unique across every organisation, so whether it is taken spans them all", () => Admin.exists({ email }))) {
      throw new AppError("That email already belongs to someone who signs in here or in another organisation", 409, "EMAIL_EXISTS");
    }
    await UsageService.assertRoom("users");
    const branchId = await checkBranch(input.branchId);
    const branchRoles = input.branchRoles === undefined ? [] : await checkBranchRoles(input.branchRoles, actor);

    const account = await new Admin({ name, email, password: input.password, mustChangePassword: true, ...stored(role.key), branchRoles, branchId, status: "active", isActive: true, createdBy: req.admin?.id || null }).save();
    return present(account, role, await rolesNamedBy([account]));
  }

  static async update(id, patch, req) {
    const account = await Admin.findById(id).select("+password");
    if (!account) throw new AppError("That person was not found", 404, "ADMIN_NOT_FOUND");
    const actor = RoleService.actorOf(req);
    const self = String(account._id) === String(req.admin?.id);
    const current = await RoleService.ofAccount(account);
    let endSessions = false; // a password set by someone else, or a person switched off, ends the sign-ins they hold

    const wantsRole = patch.role !== undefined && clean(patch.role).toLowerCase() !== roles.roleKeyOf(account);
    const wantsOff = patch.status !== undefined && patch.status !== "active";
    // nobody changes their own role, or switches themselves off: the one way to lose access, or to gain it, by accident
    // (a person changes their own name here and their own password in Settings, where the current password is asked for)
    if (self && (wantsRole || wantsOff || patch.branchId !== undefined || patch.branchRoles !== undefined || patch.password)) throw new AppError("You cannot change your own role, branch, status or password here. Ask another administrator.", 403, "CANNOT_CHANGE_SELF");

    const next = wantsRole ? await targetRole(patch.role) : null;
    if (!self) guard(roles.mayManage({ actor, target: current || { rank: 0, permissions: [], isActive: false }, next: next || undefined, action: "update" }));

    if (wantsRole || wantsOff) await assertNotLastOwner(account);

    if (patch.name !== undefined) {
      if (clean(patch.name).length < 2) throw new AppError("The person needs a name", 400, "NAME_REQUIRED");
      account.name = clean(patch.name);
    }
    if (next) Object.assign(account, stored(next.key));
    if (patch.branchId !== undefined) account.branchId = await checkBranch(patch.branchId);
    if (patch.branchRoles !== undefined) {
      // changing where someone holds another role means being able to manage the roles they hold there now, too
      for (const b of account.branchRoles || []) {
        const held = await RoleService.find(b.roleKey);
        if (held) guard(roles.mayManage({ actor, target: held, action: "update" }));
      }
      account.branchRoles = await checkBranchRoles(patch.branchRoles, actor);
    }
    if (patch.status !== undefined) {
      if (!["active", "inactive"].includes(patch.status)) throw new AppError("Status must be active or inactive", 400, "STATUS_INVALID");
      if (patch.status === "active") await UsageService.assertRoom("users", account.isActive && account.status === "active" ? 0 : 1);
      account.status = patch.status;
      account.isActive = patch.status === "active";
      if (patch.status !== "active") endSessions = true;
    }
    if (patch.password !== undefined && patch.password !== "") {
      if (typeof patch.password !== "string" || patch.password.length < 8) throw new AppError("A password needs at least 8 characters", 400, "WEAK_PASSWORD");
      if (patch.password.length > 200) throw new AppError("That password is too long", 400, "WEAK_PASSWORD");
      endSessions = true;
      account.password = patch.password; // hashed on save
      account.mustChangePassword = true; // an administrator set it, so the person chooses their own at the next sign-in
      account.lockUntil = undefined; // and a reset is also how a locked-out person is let back in
      account.loginAttempts = 0;
    }
    account.$locals.updatedBy = req.admin?.id || null;
    await account.save();
    if (endSessions) await AuthSession.updateMany({ adminId: account._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    return present(account, next || current, await rolesNamedBy([account]));
  }
}

// An administrator clears someone else's two-factor (a lost phone, with no recovery codes left). It ends every sign-in the person holds,
// and they must set it up again if the organisation requires it. Never one's own: that is Settings, with the password and a code.
UserService.resetTwoFactor = async (id, req) => {
  const account = await Admin.findById(id).select("name email type roleKey branchRoles branchId status isActive lastLogin createdAt twoFactor.enabled");
  if (!account) throw new AppError("That person was not found", 404, "ADMIN_NOT_FOUND");
  if (String(account._id) === String(req.admin?.id)) {
    throw new AppError("You cannot reset your own two-factor here. Turn it off in Settings, with your password and a code.", 403, "CANNOT_CHANGE_SELF");
  }
  const current = await RoleService.ofAccount(account);
  guard(roles.mayManage({ actor: RoleService.actorOf(req), target: current || { rank: 0, permissions: [], isActive: false }, action: "update" }));
  if (!TwoFactorService.isEnabled(account)) throw new AppError("Two-factor is not on for that person.", 409, "TWO_FACTOR_NOT_ON");
  await TwoFactorService.disable(account);
  const now = new Date();
  await Admin.updateOne({ _id: account._id }, { $set: { sessionsRevokedAt: now } });
  await AuthSession.updateMany({ adminId: account._id, revokedAt: null }, { $set: { revokedAt: now } });
  require("./accountSecurityService").notice(account, "Your two-factor sign-in was reset by an administrator", "Signing in no longer asks for a code until you set it up again. You were signed out everywhere.");
  return { ...present(account, current, await rolesNamedBy([account])), twoFactorEnabled: false };
};

UserService.storedFor = stored; // the developer console gives people roles by the same rule
module.exports = UserService;
