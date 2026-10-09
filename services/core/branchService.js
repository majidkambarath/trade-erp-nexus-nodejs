// Branches of the organisation in scope. The head office is made with the organisation and cannot be
// removed or switched off; every further branch needs the multiBranch feature and room under the plan's
// branch limit. A document stores its branch's `code` as `branchId`.
//
// Scoped by the tenant plugin, so an organisation only ever lists, changes or counts its own.
const Branch = require("../../models/core/branchModel");
const Organisation = require("../../models/core/organisationModel");
const Admin = require("../../models/core/adminModel");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const plans = require("../../utils/plans");

const bad = (message, code, details) => new AppError(message, 400, code, details);
const CODE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const organisationOf = async (req) => {
  const { companyId } = getTenant(req);
  const org = await Organisation.findOne({ code: companyId });
  if (!org) throw new AppError("That organisation was not found", 404, "ORGANISATION_NOT_FOUND");
  return org;
};

// Who can sign in and works from a branch: what switching it off would lock out.
const peopleIn = (code) => Admin.countDocuments({ branchId: code, isActive: true, status: "active" });

class BranchService {
  // `withPeople` adds, to each branch, how many people can sign in with it as their home branch (for the screen that
  // manages branches: a branch with people in it cannot be switched off).
  static async list({ withPeople = false } = {}) {
    const rows = await Branch.find().sort({ isHeadOffice: -1, code: 1 }).lean();
    if (!withPeople) return rows;
    const counts = await Admin.aggregate([{ $match: { isActive: true, status: "active" } }, { $group: { _id: "$branchId", n: { $sum: 1 } } }]);
    const byCode = Object.fromEntries(counts.map((c) => [c._id || "main", c.n]));
    return rows.map((b) => ({ ...b, people: byCode[b.code] || 0 }));
  }

  static async get(code) {
    const branch = await Branch.findOne({ code: String(code || "").toLowerCase() });
    if (!branch) throw new AppError("That branch was not found", 404, "BRANCH_NOT_FOUND");
    return branch;
  }

  static async create(input = {}, req, { by = null } = {}) {
    const org = await organisationOf(req);
    const code = String(input.code || "").trim().toLowerCase();
    const name = String(input.name || "").trim();
    if (code.length < 2 || code.length > 20 || !CODE.test(code)) throw bad("A branch code is 2 to 20 lower-case letters, digits or hyphens", "BRANCH_CODE_INVALID");
    if (!name) throw bad("The branch needs a name", "BRANCH_NAME_REQUIRED");

    // Not the head office: that one is made with the organisation, so anything made here is a further branch.
    if (!plans.hasFeature(org, "multiBranch")) {
      throw new AppError("More than one branch is not included in this organisation's plan.", 403, "FEATURE_NOT_IN_PLAN", { feature: "multiBranch" });
    }
    const used = await Branch.countDocuments({ isActive: true });
    const room = plans.checkLimit(org, "branches", used);
    if (!room.ok) throw new AppError(`This organisation is limited to ${room.limit} branches and already has ${room.used}.`, 403, "LIMIT_REACHED", { resource: "branches", ...room });
    if (await Branch.exists({ code })) throw new AppError("That branch code is already used", 409, "BRANCH_CODE_TAKEN");

    return Branch.create({
      code, name, isHeadOffice: false, createdBy: by,
      address: { line1: input.addressLine1, city: input.city, state: input.state, country: input.country || org.country },
      phone: input.phone, email: input.email,
    });
  }

  // The code never changes (it is stamped on documents) and the head office is never switched off.
  static async update(code, patch = {}, req = null) {
    const branch = await this.get(code);
    if (patch.isActive === false && branch.isActive && !branch.isHeadOffice) {
      // Anyone whose home branch is switched off is refused at every request (BRANCH_INACTIVE), so move them first.
      const people = await peopleIn(branch.code);
      if (people) throw new AppError(`${people} ${people === 1 ? "person works" : "people work"} in this branch and would be locked out. Move them to another branch first.`, 409, "BRANCH_HAS_PEOPLE", { people });
    }
    if (patch.isActive === true && !branch.isActive) {
      // Switching a branch back on takes a place under the plan's branch limit again, as adding one does.
      const org = await organisationOf(req || {});
      if (!plans.hasFeature(org, "multiBranch")) throw new AppError("More than one branch is not included in this organisation's plan.", 403, "FEATURE_NOT_IN_PLAN", { feature: "multiBranch" });
      const room = plans.checkLimit(org, "branches", await Branch.countDocuments({ isActive: true }));
      if (!room.ok) throw new AppError(`This organisation is limited to ${room.limit} branches and already has ${room.used}.`, 403, "LIMIT_REACHED", { resource: "branches", ...room });
    }
    if (patch.code !== undefined && String(patch.code).toLowerCase() !== branch.code) throw new AppError("A branch code cannot be changed: it is stamped on documents", 409, "BRANCH_CODE_LOCKED");
    if (patch.isActive === false && branch.isHeadOffice) throw new AppError("The head office cannot be switched off", 409, "HEAD_OFFICE_REQUIRED");
    if (patch.isHeadOffice !== undefined && Boolean(patch.isHeadOffice) !== branch.isHeadOffice) throw new AppError("Which branch is the head office cannot be changed", 409, "HEAD_OFFICE_LOCKED");

    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw bad("The branch needs a name", "BRANCH_NAME_REQUIRED");
      branch.name = name;
    }
    for (const k of ["line1", "city", "state"]) if (patch[k] !== undefined) branch.address[k] = String(patch[k]).trim();
    for (const k of ["phone", "email"]) if (patch[k] !== undefined) branch[k] = String(patch[k]).trim();
    if (patch.isActive !== undefined) branch.isActive = Boolean(patch.isActive);
    await branch.save();
    return branch;
  }
}

module.exports = BranchService;
