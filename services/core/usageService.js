// What an organisation is using against what its plan allows: the one place the limits and the optional features
// are enforced from inside the services. Everything runs in the caller's scope, so it counts the caller's own
// organisation and nobody else's. The rules themselves (what a plan includes, what counts as room) are the pure
// functions in utils/plans.js.
const Organisation = require("../../models/core/organisationModel");
const Admin = require("../../models/core/adminModel");
const Branch = require("../../models/core/branchModel");
const Transaction = require("../../models/modules/transactionModel");
const AppError = require("../../utils/AppError");
const plans = require("../../utils/plans");
const { getTenant } = require("../../utils/tenant");
const { DEFAULT_TENANT, legacyDefaultEnabled } = require("../../utils/tenantContext");

const LABELS = { users: "users", branches: "branches", documentsPerMonth: "documents this month" };

class UsageService {
  // The organisation the call is running for. Loaded fresh: a limit or a feature the developer changed a moment
  // ago applies to the next call, not the next restart.
  static async organisation() {
    const { companyId } = getTenant();
    const org = await Organisation.findOne({ code: companyId });
    if (org) return org;
    // Single-company compatibility mode (TENANT_LEGACY_DEFAULT, which the running server never has on): the
    // original company has no registry row in a database that was only ever used through the services, which is
    // how the older suites run. It is treated as the internal plan: everything on, no limits, no end date.
    if (legacyDefaultEnabled() && companyId === DEFAULT_TENANT.companyId) {
      return { code: companyId, legalName: companyId, planCode: "internal", status: "active", timezone: "Asia/Dubai", featureOverrides: {}, limitOverrides: {}, subscription: {} };
    }
    throw new AppError("This organisation could not be found", 403, "ORGANISATION_NOT_FOUND");
  }

  // Counted in the organisation's own calendar month, not UTC's. "Documents" are the trade documents (sales and
  // purchase orders and their returns) made this month; opening balances are the go-live load, not trading, and
  // quotations, delivery notes and vouchers are not counted.
  static async current(org, now = new Date()) {
    const start = plans.monthStartIn(org.timezone, now);
    const [users, branches, documentsPerMonth] = await Promise.all([
      Admin.countDocuments({ isActive: true, status: "active" }),
      Branch.countDocuments({ isActive: true }),
      Transaction.countDocuments({ createdAt: { $gte: start }, isOpening: { $ne: true } }),
    ]);
    return { users, branches, documentsPerMonth };
  }

  static async used(org, key) {
    return (await this.current(org))[key];
  }

  // Refuses with LIMIT_REACHED when `adding` more would go over. A null limit is unlimited and is never counted.
  static async assertRoom(key, adding = 1, org = null) {
    org = org || (await this.organisation());
    if (plans.effectiveLimits(org)[key] === null) return { ok: true, limit: null };
    const used = await this.used(org, key);
    const room = plans.checkLimit(org, key, used, adding);
    if (!room.ok) {
      throw new AppError(
        `This organisation is limited to ${room.limit} ${LABELS[key] || key} and already has ${room.used}. Please contact support to raise the limit.`,
        403,
        "LIMIT_REACHED",
        { resource: key, ...room }
      );
    }
    return room;
  }

  // For a service that is not behind a router with the gate on it (a payment mode, say).
  static async assertFeature(key, org = null) {
    org = org || (await this.organisation());
    if (!plans.hasFeature(org, key)) throw featureError(org, key);
    return org;
  }

  // For a background job that has no request: the organisations whose work it may do now. Not suspended or
  // closed, not past the end of the subscription (or read-only), and - when the job belongs to an optional
  // feature - with that feature switched on. A cross-organisation read by design: it returns codes only.
  static async liveCodes({ feature = null, now = new Date() } = {}) {
    const found = await Organisation.find({ status: { $in: ["trial", "active"] } }).select("code status planCode subscription featureOverrides").lean();
    const live = new Set(
      found
        .filter((o) => plans.subscriptionState(o, now).canWrite && (!feature || plans.hasFeature(o, feature)))
        .map((o) => o.code)
    );
    // Single-company compatibility mode: the original company has no registry row (see organisation()), and is live.
    if (legacyDefaultEnabled() && !found.some((o) => o.code === DEFAULT_TENANT.companyId)) live.add(DEFAULT_TENANT.companyId);
    return live;
  }

  // Everything a screen needs to know about what it may show: the plan, the switched-on features, the limits with
  // their use, and where the subscription stands.
  // `who` is the caller: { admin, tenant } from the request. It adds where they are working: their branch, whether they
  // may switch (a head-office user in an organisation with more than one branch), and the branches they could choose.
  static async status(org, now = new Date(), who = {}) {
    const usage = await this.current(org, now);
    const limits = plans.effectiveLimits(org);
    const branches = await Branch.find({ isActive: true }).sort({ isHeadOffice: -1, name: 1 }).select("code name isHeadOffice").lean();
    const here = who.tenant?.branchId || "main";
    const mine = branches.find((b) => b.code === here);
    // A head-office person may work in any branch. Anyone else works in their own and the ones they were given a role in.
    const home = who.admin?.homeBranch || who.admin?.branchId || "main";
    const given = (who.admin?.branchRoles || []).map((b) => b.branchId);
    const offered = home === "main" ? branches : branches.filter((b) => b.code === home || given.includes(b.code));
    return {
      branches: offered.map((b) => ({ code: b.code, name: b.name, isHeadOffice: Boolean(b.isHeadOffice) })),
      branch: {
        code: here,
        name: mine?.name || here,
        isHeadOffice: Boolean(mine?.isHeadOffice),
        canSwitch: offered.length > 1,
        // the "all branches" choice is only for a head-office person whose role is the same in every branch
        canViewAll: home === "main" && given.length === 0,
        view: who.tenant?.branchView || null,
      },
      support: { contact: process.env.SUPPORT_CONTACT || process.env.SUPPORT_EMAIL || null },
      organisation: { code: org.code, legalName: org.legalName, country: org.country, baseCurrency: org.baseCurrency, timezone: org.timezone, planCode: org.planCode, planName: plans.PLANS[org.planCode]?.name || org.planCode },
      subscription: plans.subscriptionState(org, now),
      features: plans.effectiveFeatures(org),
      limits,
      usage,
      room: Object.fromEntries(plans.LIMIT_KEYS.map((k) => [k, plans.checkLimit(org, k, usage[k] ?? 0)])),
    };
  }
}

function featureError(org, key) {
  return new AppError(`${plans.FEATURES[key]?.label || key} is not included in this organisation's plan.`, 403, "FEATURE_NOT_IN_PLAN", { feature: key, plan: org?.planCode || null });
}

module.exports = UsageService;
module.exports.featureError = featureError;
