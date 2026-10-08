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

const clean = (v) => String(v ?? "").trim();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// How a role is stored on the account. The five types that existed before roles stay in `type` with no roleKey; every
// other role goes in roleKey over the safest type, "viewer", so anything still reading the type fails closed.
const stored = (key) => (roles.LEGACY_TYPES.includes(key) ? { type: key, roleKey: null } : { type: "viewer", roleKey: key });

const present = (account, role) => ({
  id: String(account._id),
  name: account.name,
  email: account.email,
  role: role
    ? { key: role.key, name: role.name, rank: role.rank, builtIn: role.builtIn, active: role.isActive !== false }
    : { key: roles.roleKeyOf(account), name: null, rank: 0, builtIn: false, active: false },
  branchId: account.branchId,
  status: account.status,
  isActive: account.isActive,
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
    const rows = await Admin.find(q).select("name email type roleKey branchId status isActive lastLogin createdAt").sort({ createdAt: 1 }).lean();
    const keys = [...new Set(rows.map((a) => roles.roleKeyOf(a)))];
    const found = new Map();
    for (const k of keys) found.set(k, await RoleService.find(k));
    return rows.map((a) => present(a, found.get(roles.roleKeyOf(a))));
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

    const account = await new Admin({ name, email, password: input.password, ...stored(role.key), branchId, status: "active", isActive: true, createdBy: req.admin?.id || null }).save();
    return present(account, role);
  }

  static async update(id, patch, req) {
    const account = await Admin.findById(id).select("+password");
    if (!account) throw new AppError("That person was not found", 404, "ADMIN_NOT_FOUND");
    const actor = RoleService.actorOf(req);
    const self = String(account._id) === String(req.admin?.id);
    const current = await RoleService.ofAccount(account);

    const wantsRole = patch.role !== undefined && clean(patch.role).toLowerCase() !== roles.roleKeyOf(account);
    const wantsOff = patch.status !== undefined && patch.status !== "active";
    // nobody changes their own role, or switches themselves off: the one way to lose access, or to gain it, by accident
    // (a person changes their own name here and their own password in Settings, where the current password is asked for)
    if (self && (wantsRole || wantsOff || patch.branchId !== undefined || patch.password)) throw new AppError("You cannot change your own role, branch, status or password here. Ask another administrator.", 403, "CANNOT_CHANGE_SELF");

    const next = wantsRole ? await targetRole(patch.role) : null;
    if (!self) guard(roles.mayManage({ actor, target: current || { rank: 0, permissions: [], isActive: false }, next: next || undefined, action: "update" }));

    if (wantsRole || wantsOff) await assertNotLastOwner(account);

    if (patch.name !== undefined) {
      if (clean(patch.name).length < 2) throw new AppError("The person needs a name", 400, "NAME_REQUIRED");
      account.name = clean(patch.name);
    }
    if (next) Object.assign(account, stored(next.key));
    if (patch.branchId !== undefined) account.branchId = await checkBranch(patch.branchId);
    if (patch.status !== undefined) {
      if (!["active", "inactive"].includes(patch.status)) throw new AppError("Status must be active or inactive", 400, "STATUS_INVALID");
      if (patch.status === "active") await UsageService.assertRoom("users", account.isActive && account.status === "active" ? 0 : 1);
      account.status = patch.status;
      account.isActive = patch.status === "active";
    }
    if (patch.password !== undefined && patch.password !== "") {
      if (String(patch.password).length < 8) throw new AppError("A password needs at least 8 characters", 400, "WEAK_PASSWORD");
      account.password = patch.password; // hashed on save
      account.loginAttempts = 0;
      account.lockUntil = undefined;
    }
    account.$locals.updatedBy = req.admin?.id || null;
    await account.save();
    return present(account, next || current);
  }
}

module.exports = UserService;
