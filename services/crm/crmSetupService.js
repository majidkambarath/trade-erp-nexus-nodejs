// The CRM's configuration: the pipeline stages (a master of their own) and the automation settings (a block on the
// organisation's CompanySettings). Everything else in the module reads its rules from here, so there is one answer to
// "what are this organisation's stages" and one answer to "is auto-advance on".
//
// `ensureStarter` is the lazy, idempotent seed - the same shape as TaxCodeService.ensureStarter and
// DefaultChartService.provision: the first read of the pipeline creates it, nothing has to be provisioned up front, and
// an organisation that has edited its stages is never given the starter set again.
const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const CrmStage = require("../../models/modules/crm/crmStageModel");
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const Admin = require("../../models/core/adminModel");
const roles = require("../../utils/permissions");
const rules = require("../../utils/crm");
const { getTenant } = require("../../utils/tenant");

const fail = (message, status, code, details) => new AppError(message, status, code, details);

class CrmSetupService {
  /** The organisation's stages, in pipeline order, seeding the starter pipeline on the first read. */
  static async stages({ session } = {}) {
    const found = await CrmStage.find({}).sort({ order: 1 }).session(session || null).lean();
    if (found.length) return found.map(clean);
    return (await this.ensureStarter({ session })).map(clean);
  }

  /**
   * Seed the starter pipeline once. Two people opening the screen at the same moment race here; the unique index on
   * { companyId, key } decides it, and the loser simply reads what the winner wrote.
   *
   * INSIDE a caller's transaction the duplicate key is re-thrown instead, on purpose: a duplicate key aborts the whole
   * transaction server-side, so swallowing it would leave the caller committing a transaction that no longer exists.
   * Thrown, it is a transient failure that `withTransactionSession` retries on a fresh session - where the count now
   * finds the stages the winner wrote. (The same trap as ActivityService.ensureAuto; see services/crm/crmHooks.js.)
   */
  static async ensureStarter({ session } = {}) {
    const { companyId } = getTenant();
    const existing = await CrmStage.countDocuments({}).session(session || null);
    if (existing > 0) return CrmStage.find({}).sort({ order: 1 }).session(session || null).lean();
    try {
      await CrmStage.insertMany(
        rules.STARTER_STAGES.map((s) => ({ ...s, companyId })),
        { session: session || undefined, ordered: true }
      );
    } catch (error) {
      if (error?.code !== 11000 || session) throw error; // somebody else seeded it between the count and the insert
    }
    return CrmStage.find({}).sort({ order: 1 }).session(session || null).lean();
  }

  /** Replace the whole pipeline in one go: the stages are an ordered list, so they are saved as one. */
  static async replaceStages(list, by) {
    const errors = rules.validateStages(list);
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });

    const next = rules.normaliseStages(list);
    const Opportunity = require("../../models/modules/crm/opportunityModel");
    const current = await CrmStage.find({}).lean();
    const keptKeys = new Set(next.map((s) => s.key));

    // A stage with deals on it cannot simply vanish: the deals would point at nothing and the board could not draw
    // them. The person is told which stage and how many, and moves them first.
    for (const stage of current) {
      if (keptKeys.has(stage.key)) continue;
      const count = await Opportunity.countDocuments({ stageKey: stage.key, status: "OPEN" });
      if (count > 0) {
        throw fail(
          `${count} open ${count === 1 ? "deal is" : "deals are"} on "${stage.name}". Move them to another stage before removing it.`,
          409,
          "STAGE_IN_USE",
          { stage: stage.key, deals: count }
        );
      }
    }

    const { companyId } = getTenant();
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await CrmStage.deleteMany({}, { session });
        await CrmStage.insertMany(
          next.map((s) => ({ ...s, companyId })),
          { session, ordered: true }
        );
      });
    } finally {
      await session.endSession();
    }
    // The name and probability a deal carries are a copy, kept so a list needs no join; refresh them here or a renamed
    // stage would still read by its old name on every open deal.
    for (const s of next) {
      await Opportunity.updateMany({ stageKey: s.key }, { $set: { stageName: s.name, probability: s.probability } });
    }
    return (await CrmStage.find({}).sort({ order: 1 }).lean()).map(clean);
  }

  /** The automation settings, with every default filled in, whatever an older document stored. */
  static async settings({ session } = {}) {
    const doc = await CompanySettings.findOne({}).select("crm").session(session || null).lean();
    const stored = doc?.crm || {};
    return { ...rules.normaliseSettings(stored), lastAssignedOwnerId: stored.lastAssignedOwnerId || null };
  }

  static async saveSettings(input, by) {
    const errors = rules.validateSettings(input);
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });
    const current = await this.settings();
    const next = rules.normaliseSettings({ ...current, ...input });
    const { companyId } = getTenant();
    await CompanySettings.updateOne(
      {},
      { $set: Object.fromEntries(Object.entries(next).map(([k, v]) => [`crm.${k}`, v])), $setOnInsert: { companyId } },
      { upsert: true }
    );
    return { ...next, lastAssignedOwnerId: current.lastAssignedOwnerId };
  }

  /**
   * Who a lead or a deal may be given to: the active people in the organisation who may work the CRM at all. Names
   * only - this is a pick list, not a staff record. Round robin walks them in a stable order, so they are sorted by id
   * rather than by name (a rename must not change whose turn it is).
   */
  static async owners() {
    const people = await Admin.find({ isActive: true, status: "active" })
      .select("_id name email roleKey type branchRoles")
      .sort({ _id: 1 })
      .lean();
    const customRoles = await listRoles();
    return people
      .filter((p) => {
        const role = roles.resolveRole(roles.roleKeyOf(p), customRoles);
        return roles.can(roles.grantsOf(role), "crm.view");
      })
      .map((p) => ({ id: String(p._id), name: p.name || p.email || "Someone" }));
  }

  /** The person round robin should give the next one to, and the bookkeeping that remembers it. */
  static async nextOwner({ createdBy } = {}) {
    const [settings, candidates] = await Promise.all([this.settings(), this.owners()]);
    const ownerId = rules.assignOwner({ candidates, lastOwnerId: settings.lastAssignedOwnerId, settings, createdBy });
    const owner = candidates.find((c) => c.id === ownerId) || null;
    if (ownerId && settings.assignmentMode === "round_robin") {
      const { companyId } = getTenant();
      await CompanySettings.updateOne({}, { $set: { "crm.lastAssignedOwnerId": ownerId }, $setOnInsert: { companyId } }, { upsert: true });
    }
    return { ownerId: ownerId || null, ownerName: owner ? owner.name : "" };
  }

  /** The name of one person, for the copy kept on a lead or a deal. */
  static async ownerName(ownerId) {
    if (!rules.isId(ownerId)) return "";
    const person = await Admin.findById(ownerId).select("name email").lean();
    return person ? person.name || person.email || "" : "";
  }
}

const clean = (s) => ({
  key: s.key, name: s.name, order: s.order, probability: s.probability,
  advanceOn: s.advanceOn || null, followUpDays: s.followUpDays || 0, staleDays: s.staleDays || 0, type: s.type || "open",
});

// The organisation's own roles, when it has any. Required lazily: roleModel is core and this keeps the import graph of
// a new module shallow.
async function listRoles() {
  try {
    const Role = require("../../models/core/roleModel");
    return await Role.find({ isActive: true }).lean();
  } catch {
    return [];
  }
}

module.exports = CrmSetupService;
