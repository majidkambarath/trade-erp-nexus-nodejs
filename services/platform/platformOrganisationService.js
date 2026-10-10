// What a developer does to an organisation from the console. It composes OrganisationService (the registry, the
// plan, the provisioning), BranchService and the customer's own accounts, and records every change in two
// places: the platform's own log, and the organisation's audit trail in words fit for its staff.
//
// Platform code has NO organisation in scope, so every read or write of an organisation's own data names it
// and runs inside runWithTenant for that code. Forgetting to would fail closed, not leak.
const Organisation = require("../../models/core/organisationModel");
const Branch = require("../../models/core/branchModel");
const Admin = require("../../models/core/adminModel");
const Transaction = require("../../models/modules/transactionModel");
const PlatformAudit = require("../../models/platform/platformAuditModel");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const OrganisationService = require("../core/organisationService");
const BranchService = require("../core/branchService");
const AuditService = require("../core/auditService");
const AppError = require("../../utils/AppError");
const plans = require("../../utils/plans");
const currencies = require("../../utils/currencyCatalog");
const { runWithTenant, runUnscoped } = require("../../utils/tenantContext");
const { permissionsFor } = require("../../utils/adminPermissions");
const roles = require("../../utils/permissions");
const RoleService = require("../core/roleService");
const UserService = require("../core/userService");

const HEAD_OFFICE = OrganisationService.HEAD_OFFICE;
const inOrg = async (code, fn) => {
  const org = await OrganisationService.get(code);
  return runWithTenant({ companyId: org.code, branchId: HEAD_OFFICE }, () => fn(org));
};

// The role a developer names for a person: any switched-on role of THAT organisation, ready-made or its own. The console
// is not ranked like the organisation's administrators (it is how the first owner gets in), so there is no "may hand it
// out" check; the organisation's own rules still apply once the person is in. Must run inside inOrg.
async function roleFor(key) {
  const wanted = String(key ?? "").trim().toLowerCase();
  const role = wanted ? await RoleService.find(wanted) : null;
  if (!role) throw new AppError("Choose a valid role", 400, "ROLE_NOT_FOUND");
  if (role.isActive === false) throw new AppError("That role has been switched off", 400, "ROLE_INACTIVE");
  return role;
}

class PlatformOrganisationService {
  // ---- the record of what was done

  static async record({ by, ip, action, organisation, summary, details }) {
    try {
      await PlatformAudit.create({ by: by?.email || null, ip: ip || null, action, organisation: organisation || null, summary, details: details ?? null });
      if (organisation) {
        // the organisation's own trail says it plainly, with who on the platform side did it
        await runWithTenant({ companyId: organisation, branchId: HEAD_OFFICE }, () =>
          AuditService.log({ req: { admin: { id: null, email: `platform support (${by?.email || "unknown"})` }, ip }, action: `PLATFORM_${action}`, entity: "Organisation", entityId: organisation, summary })
        );
      }
    } catch (error) {
      console.error("[platform] could not write the audit record:", error.message); // never fail the change over its log
    }
  }

  static async auditLog({ organisation, page = 1, limit = 50 } = {}) {
    const q = organisation ? { organisation } : {};
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const [rows, total] = await Promise.all([
      PlatformAudit.find(q).sort({ at: -1 }).skip((Math.max(Number(page) || 1, 1) - 1) * lim).limit(lim).lean(),
      PlatformAudit.countDocuments(q),
    ]);
    return { rows, total };
  }

  // ---- what the console offers to choose from

  static catalog() {
    return {
      plans: Object.entries(plans.PLANS).map(([code, p]) => ({ code, name: p.name, trialDays: p.trialDays || null, features: p.features, limits: p.limits })),
      features: Object.entries(plans.FEATURES).map(([key, f]) => ({ key, label: f.label })),
      limits: plans.LIMIT_KEYS,
      currencies: currencies.list(),
      unsupportedCurrencies: currencies.THREE_DECIMAL,
      timezones: typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [],
      accountTypes: ["super_admin", "admin", "manager", "operator", "viewer"],
    };
  }

  // ---- reading

  static async usage(code) {
    return inOrg(code, async () => {
      const start = new Date();
      start.setUTCDate(1);
      start.setUTCHours(0, 0, 0, 0);
      const [users, branches, documentsThisMonth] = await Promise.all([
        Admin.countDocuments({ isActive: true, status: "active" }),
        Branch.countDocuments({ isActive: true }),
        Transaction.countDocuments({ createdAt: { $gte: start } }),
      ]);
      return { users, branches, documentsPerMonth: documentsThisMonth };
    });
  }

  // The whole picture of one organisation, as the console's detail screen shows it.
  static async detail(code, now = new Date()) {
    const org = await OrganisationService.get(code);
    const usage = await this.usage(org.code);
    const limits = plans.effectiveLimits(org);
    const settings = await inOrg(org.code, () => CompanySettings.findOne().select("profile").lean());
    return {
      organisation: org.toJSON(),
      profile: settings?.profile || {},
      features: plans.effectiveFeatures(org),
      limits,
      usage,
      state: plans.subscriptionState(org, now),
      room: Object.fromEntries(plans.LIMIT_KEYS.map((k) => [k, plans.checkLimit(org, k, usage[k] ?? 0)])),
    };
  }

  static async list(opts = {}, now = new Date()) {
    const out = await OrganisationService.list(opts);
    out.rows = out.rows.map((o) => ({ ...o, state: plans.subscriptionState(o, now), features: plans.effectiveFeatures(o) }));
    return out;
  }

  // An email belongs to one person in one organisation, so whether it is taken is a question about EVERY organisation.
  static emailTaken(email) {
    return runUnscoped("platform: an email address is unique across every organisation, so whether it is taken spans them all", () =>
      Admin.exists({ email: String(email || "").toLowerCase().trim() })
    );
  }

  // ---- creating

  // Create an organisation, and optionally its first administrator (a super_admin, so they can manage their own
  // people). The administrator's email is checked FIRST: emails are unique across organisations, and finding a
  // clash after the organisation exists would leave it half made.
  static async create(input, ctx) {
    const firstAdmin = input.firstAdmin;
    if (firstAdmin) {
      if (!firstAdmin.email || !firstAdmin.password || !firstAdmin.name) throw new AppError("The first administrator needs a name, an email and a password", 400, "FIRST_ADMIN_INCOMPLETE");
      if (await this.emailTaken(firstAdmin.email)) throw new AppError("That email already belongs to a user of an organisation", 409, "EMAIL_EXISTS");
    }
    const made = await OrganisationService.create(input, { by: ctx.by?.email });
    const result = { ...made, firstAdmin: null, firstAdminError: null };
    if (firstAdmin) {
      try {
        const user = await this.createUser(made.organisation.code, { ...firstAdmin, type: "super_admin" });
        result.firstAdmin = { id: String(user._id), email: user.email, type: user.type };
      } catch (error) {
        result.firstAdminError = error.message; // the organisation exists; the console shows this and lets the developer add one
      }
    }
    await this.record({ ...ctx, action: "ORGANISATION_CREATED", organisation: made.organisation.code, summary: `Organisation created on the ${made.organisation.planCode} plan, books in ${made.organisation.baseCurrency}`, details: { provisioning: made.provisioning.complete } });
    return result;
  }

  // ---- changing an organisation's own data

  static async update(code, patch, ctx) {
    await OrganisationService.update(code, patch);
    const fields = Object.keys(patch).filter((k) => patch[k] !== undefined);
    await this.record({ ...ctx, action: "ORGANISATION_UPDATED", organisation: code, summary: `Changed: ${fields.join(", ") || "nothing"}`, details: { fields } });
    return this.detail(code);
  }

  static async extend(code, input, ctx) {
    const org = await OrganisationService.extend(code, input);
    await this.record({ ...ctx, action: "SUBSCRIPTION_EXTENDED", organisation: code, summary: `Subscription now ends ${org.subscription.endsAt?.toISOString().slice(0, 10)}`, details: input });
    return this.detail(code);
  }

  static async setStatus(code, status, ctx) {
    if (!["trial", "active", "suspended", "closed"].includes(status)) throw new AppError("Status must be trial, active, suspended or closed", 400, "STATUS_INVALID");
    await OrganisationService.update(code, { status });
    await this.record({ ...ctx, action: `ORGANISATION_${String(status).toUpperCase()}`, organisation: code, summary: `Status set to ${status}` });
    return this.detail(code);
  }

  // Run the set-up again: it finishes whatever stopped, and changes nothing that is already there.
  static async provision(code, ctx) {
    const result = await OrganisationService.provision(code);
    await this.record({ ...ctx, action: "ORGANISATION_PROVISIONED", organisation: code, summary: result.complete ? "Set-up complete" : "Set-up ran; some steps need attention", details: result });
    return result;
  }

  static async updateCompanyProfile(code, profile, ctx) {
    const out = await OrganisationService.updateCompanyProfile(code, profile);
    await this.record({ ...ctx, action: "COMPANY_PROFILE_UPDATED", organisation: code, summary: `Company details changed: ${Object.keys(profile).join(", ")}` });
    return out;
  }

  // ---- the organisation's people

  static async listUsers(code) {
    return inOrg(code, async () => {
      const rows = await Admin.find().select("name email type roleKey status isActive branchId lastLogin createdAt").sort({ createdAt: 1 }).lean();
      const found = new Map();
      for (const key of new Set(rows.map((a) => roles.roleKeyOf(a)))) found.set(key, await RoleService.find(key));
      return rows.map((a) => {
        const key = roles.roleKeyOf(a);
        const role = found.get(key);
        return { ...a, role: { key, name: role?.name || null, rank: role?.rank ?? 0, active: role ? role.isActive !== false : false } };
      });
    });
  }

  // the roles an organisation can give a person: the ready-made ones and the ones it made for itself
  static async listRoles(code) {
    return inOrg(code, async () => {
      const { roles: all } = await RoleService.list();
      return all.map(({ key, name, rank, builtIn, isActive, people }) => ({ key, name, rank, builtIn, isActive, people }));
    });
  }

  static async createUser(code, input = {}, ctx = null) {
    const user = await inOrg(code, async (org) => {
      const role = await roleFor(input.role ?? input.type ?? "admin"); // `type` is the older spelling of the same thing
      if (await this.emailTaken(input.email)) throw new AppError("That email already belongs to a user of an organisation", 409, "EMAIL_EXISTS");
      const used = await Admin.countDocuments({ isActive: true, status: "active" });
      const room = plans.checkLimit(org, "users", used);
      if (!room.ok) throw new AppError(`This organisation is limited to ${room.limit} users and already has ${room.used}. Raise its limit first.`, 403, "LIMIT_REACHED", { resource: "users", ...room });
      const branchId = input.branchId || HEAD_OFFICE;
      if (!(await Branch.exists({ code: branchId, isActive: true }))) throw new AppError("That branch does not exist in this organisation", 400, "BRANCH_NOT_FOUND");
      return new Admin({ name: input.name, email: input.email, password: input.password, mustChangePassword: true, ...UserService.storedFor(role.key), status: "active", isActive: true, branchId }).save();
    });
    if (ctx) await this.record({ ...ctx, action: "USER_CREATED", organisation: code, summary: `Account created for ${user.email} (${roles.roleKeyOf(user)})` });
    return user;
  }

  // Reset a password, switch an account on or off, change its type or name. Never removes the last way in.
  static async updateUser(code, id, patch = {}, ctx) {
    const user = await inOrg(code, async () => {
      const u = await Admin.findById(id).select("+password");
      if (!u) throw new AppError("That account was not found in this organisation", 404, "ADMIN_NOT_FOUND");
      const wanted = patch.role ?? patch.type; // `type` is the older spelling of the same thing
      const losingAdmin = u.type === "super_admin" && u.isActive && ((patch.status && patch.status !== "active") || patch.isActive === false || (wanted !== undefined && String(wanted).trim().toLowerCase() !== "super_admin"));
      if (losingAdmin && (await Admin.countDocuments({ type: "super_admin", isActive: true, status: "active", _id: { $ne: u._id } })) === 0) {
        throw new AppError("That is the organisation's last active super administrator", 409, "LAST_ADMIN");
      }
      if (patch.name !== undefined) u.name = String(patch.name).trim();
      if (wanted !== undefined) Object.assign(u, UserService.storedFor((await roleFor(wanted)).key));
      if (patch.status !== undefined) {
        if (!["active", "inactive", "suspended"].includes(patch.status)) throw new AppError("Choose a valid status", 400, "STATUS_INVALID");
        u.status = patch.status;
        u.isActive = patch.status === "active";
      }
      if (patch.password !== undefined) {
        if (String(patch.password).length < 8) throw new AppError("A password needs at least 8 characters", 400, "WEAK_PASSWORD");
        u.password = patch.password;
        u.mustChangePassword = true; // the developer set it, so the person chooses their own at the next sign-in
        u.lockUntil = undefined;
        u.loginAttempts = 0;
      }
      await u.save();
      // a password set by the developer, or an account switched off, ends the sign-ins the person holds
      if (patch.password !== undefined || (patch.status !== undefined && patch.status !== "active")) {
        await require("../../models/core/authSessionModel").updateMany({ adminId: u._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
      }
      return u;
    });
    await this.record({ ...ctx, action: "USER_UPDATED", organisation: code, summary: `Account ${user.email} changed: ${Object.keys(patch).map((k) => (k === "password" ? "password reset" : k)).join(", ")}` });
    return user;
  }

  // ---- the organisation's branches

  static listBranches(code) {
    return inOrg(code, () => BranchService.list());
  }

  static async createBranch(code, input, ctx) {
    const branch = await inOrg(code, () => BranchService.create(input, {}, { by: ctx.by?.email }));
    await this.record({ ...ctx, action: "BRANCH_CREATED", organisation: code, summary: `Branch ${branch.code} (${branch.name}) created` });
    return branch;
  }

  static async updateBranch(code, branchCode, patch, ctx) {
    const branch = await inOrg(code, () => BranchService.update(branchCode, patch));
    await this.record({ ...ctx, action: "BRANCH_UPDATED", organisation: code, summary: `Branch ${branch.code} changed: ${Object.keys(patch).join(", ")}` });
    return branch;
  }
}

module.exports = PlatformOrganisationService;
