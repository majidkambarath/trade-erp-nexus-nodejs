// An organisation's roles: the built-in ones (code) and the ones it made for itself (rows). The rules about who may
// build what are in utils/permissions.js; this applies them to the database and to the person asking.
const Admin = require("../../models/core/adminModel");
const Role = require("../../models/core/roleModel");
const AppError = require("../../utils/AppError");
const roles = require("../../utils/permissions");

const clean = (v) => String(v ?? "").trim();

// The person asking, as the role object the pure rules take: what they hold and where they rank.
const actorOf = (req) => ({
  key: req.admin?.role?.key,
  rank: Number(req.admin?.role?.rank) || 0,
  permissions: req.admin?.grants || [],
  isActive: req.admin?.role?.active !== false,
  approvalLimit: req.admin?.role?.approvalLimit ?? null,
});

// What a person typed for a limit: empty is "no limit"
const parseLimit = (v) => (v === undefined || v === null || v === "" ? null : Number(v));

// `named` is what a person ticked for a custom role, before the implied permissions were added, so the editor can show
// the ticks as they were made and draw the implied ones locked.
const present = (role, people = 0, named) => ({
  key: role.key,
  name: role.name,
  description: role.description || "",
  rank: role.rank,
  approvalLimit: role.approvalLimit ?? null,
  builtIn: Boolean(role.builtIn),
  isActive: role.isActive !== false,
  permissions: roles.expand(role.permissions),
  named: role.builtIn ? undefined : named,
  people,
});

class RoleService {
  /** A role of this organisation by key: built-in, or custom and found. null when there is none. */
  static async find(key) {
    if (roles.isBuiltIn(key)) return roles.resolveRole(key);
    const row = await Role.findOne({ key: clean(key).toLowerCase() }).lean();
    return row ? roles.resolveRole(row.key, [row]) : null;
  }

  /** The role an account holds: its own, else the one its type has always meant. null when it names one that is gone. */
  static async ofAccount(account) {
    return this.find(roles.roleKeyOf(account));
  }

  static async list() {
    const [custom, held, heldInBranch] = await Promise.all([
      Role.find().sort({ rank: -1, name: 1 }).lean(),
      Admin.aggregate([{ $group: { _id: { $ifNull: ["$roleKey", "$type"] }, n: { $sum: 1 } } }]),
      Admin.aggregate([{ $unwind: "$branchRoles" }, { $group: { _id: "$branchRoles.roleKey", n: { $sum: 1 } } }]),
    ]);
    // a role is held by those who have it as their own and those who were given it for a branch
    const people = {};
    for (const h of [...held, ...heldInBranch]) people[h._id] = (people[h._id] || 0) + h.n;
    return {
      catalogue: roles.catalogue(),
      roles: [
        ...roles.BUILT_IN_KEYS.map((k) => present(roles.resolveRole(k), people[k] || 0)),
        ...custom.map((r) => present(roles.resolveRole(r.key, [r]), people[r.key] || 0, r.permissions)),
      ],
    };
  }

  static fail(errors) {
    const [field, message] = Object.entries(errors)[0];
    return new AppError(message, 400, "ROLE_INVALID", { field, errors });
  }

  static async create(input, req) {
    const key = clean(input.key).toLowerCase();
    const body = { key, name: clean(input.name), description: clean(input.description), rank: Number(input.rank), permissions: [].concat(input.permissions || []) };
    const verdict = roles.validateCustomRole(body, actorOf(req));
    if (!verdict.ok) throw this.fail(verdict.errors);
    const approvalLimit = parseLimit(input.approvalLimit);
    const limitError = roles.validateApprovalLimit(approvalLimit, body.permissions, actorOf(req));
    if (limitError) throw this.fail({ approvalLimit: limitError });
    if (await Role.exists({ key })) throw new AppError("This organisation already has a role with that key", 409, "ROLE_KEY_TAKEN");
    const row = await Role.create({ ...body, approvalLimit, createdBy: req.admin?.email || null });
    return present(roles.resolveRole(row.key, [row.toObject()]), 0, row.permissions);
  }

  static async update(key, patch, req) {
    if (roles.isBuiltIn(key)) throw new AppError("A built-in role cannot be changed. Make a role of your own instead.", 409, "BUILT_IN_ROLE");
    const row = await Role.findOne({ key: clean(key).toLowerCase() });
    if (!row) throw new AppError("That role was not found", 404, "ROLE_NOT_FOUND");
    const actor = actorOf(req);
    // a role at or above your own is not yours to change (an administrator may change any custom one, as the owner may)
    if (actor.rank < roles.TOP_RANK && row.rank >= actor.rank) throw new AppError("You can only change a role that ranks below your own.", 403, "RANK_TOO_LOW");
    const next = {
      key: row.key,
      name: patch.name !== undefined ? clean(patch.name) : row.name,
      description: patch.description !== undefined ? clean(patch.description) : row.description,
      rank: patch.rank !== undefined ? Number(patch.rank) : row.rank,
      permissions: patch.permissions !== undefined ? [].concat(patch.permissions) : row.permissions,
      approvalLimit: patch.approvalLimit !== undefined ? parseLimit(patch.approvalLimit) : row.approvalLimit ?? null,
    };
    // Only what is ADDED has to be something the person holds: taking permissions away, or renaming a role that already
    // carries some they do not hold, is not granting anything.
    const unknown = roles.unknownKeys(next.permissions);
    if (unknown.length) throw this.fail({ permissions: `Not a known permission: ${unknown.join(", ")}` });
    const had = new Set(roles.expand(row.permissions));
    const added = roles.expand(next.permissions).filter((k) => !had.has(k));
    const verdict = roles.validateCustomRole({ ...next, permissions: added }, actor, { isNew: false });
    if (!verdict.ok) throw this.fail(verdict.errors);
    if (patch.approvalLimit !== undefined || patch.permissions !== undefined) {
      const limitError = roles.validateApprovalLimit(next.approvalLimit, next.permissions, actor);
      if (limitError) throw this.fail({ approvalLimit: limitError });
    }
    row.name = next.name;
    row.description = next.description;
    row.rank = next.rank;
    row.approvalLimit = next.approvalLimit;
    row.permissions = next.permissions;
    if (patch.isActive !== undefined) {
      const off = patch.isActive === false || patch.isActive === "false";
      // switching off a role people hold would leave them holding nothing: say so rather than do it quietly
      if (off && (await Admin.countDocuments({ $or: [{ roleKey: row.key }, { "branchRoles.roleKey": row.key }] })) > 0) throw new AppError("People still hold this role. Give them another role first.", 409, "ROLE_IN_USE");
      row.isActive = !off;
    }
    row.updatedBy = req.admin?.email || null;
    await row.save();
    const people = await Admin.countDocuments({ $or: [{ roleKey: row.key }, { "branchRoles.roleKey": row.key }] });
    return present(roles.resolveRole(row.key, [row.toObject()]), people, row.permissions);
  }

  static async remove(key, req) {
    if (roles.isBuiltIn(key)) throw new AppError("A built-in role cannot be removed.", 409, "BUILT_IN_ROLE");
    const row = await Role.findOne({ key: clean(key).toLowerCase() });
    if (!row) throw new AppError("That role was not found", 404, "ROLE_NOT_FOUND");
    const actor = actorOf(req);
    if (actor.rank < roles.TOP_RANK && row.rank >= actor.rank) throw new AppError("You can only remove a role that ranks below your own.", 403, "RANK_TOO_LOW");
    const people = await Admin.countDocuments({ $or: [{ roleKey: row.key }, { "branchRoles.roleKey": row.key }] });
    if (people > 0) throw new AppError(`${people} ${people === 1 ? "person holds" : "people hold"} this role. Give them another role first.`, 409, "ROLE_IN_USE", { people });
    await Role.deleteOne({ _id: row._id });
    return { key: row.key };
  }
}

module.exports = RoleService;
module.exports.actorOf = actorOf;
