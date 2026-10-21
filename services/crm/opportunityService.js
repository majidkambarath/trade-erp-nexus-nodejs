// A deal: the pipeline, and what a person may do to one by hand. The automation's half lives in crmHooks.js, but both
// go through `enterStage` here, so a stage entered by a document and a stage entered by a person leave exactly the same
// trail behind - the probability, the day it moved, and the next follow-up.
const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const Opportunity = require("../../models/modules/crm/opportunityModel");
const Lead = require("../../models/modules/crm/leadModel");
const Customer = require("../../models/modules/customerModel");
const rules = require("../../utils/crm");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { todayInOrg } = require("../../utils/documentExpiry");
const { getTenant } = require("../../utils/tenant");
const NumberSeriesService = require("../core/numberSeriesService");
const CrmSetupService = require("./crmSetupService");
const ActivityService = require("./activityService");

const fail = (message, status, code, details) => new AppError(message, status, code, details);
const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

class OpportunityService {
  // ---- reading ------------------------------------------------------------------------------------------

  static present(doc, { stages = [], settings = rules.DEFAULT_SETTINGS, today = null } = {}) {
    const o = doc?.toObject ? doc.toObject() : doc;
    const day = today || todayInOrg();
    const stage = rules.stageByKey(stages, o.stageKey);
    const stale = rules.staleOf(o, settings, stages, day);
    return {
      ...o,
      stage: stage || null,
      stageOrder: stage ? stage.order : 0,
      daysInStage: o.stageSinceDay ? Math.max(0, rules.diffDays(o.stageSinceDay, day)) : 0,
      stale,
      weighted: rules.round2((rules.num(o.value) * rules.num(stage ? stage.probability : o.probability)) / 100),
      overdueAction: o.nextActionAt ? rules.diffDays(day, o.nextActionAt) < 0 : false,
      actions: {
        edit: o.status === "OPEN",
        delete: o.status === "OPEN",
        move: o.status === "OPEN",
        win: o.status === "OPEN",
        lose: o.status === "OPEN",
        reopen: o.status !== "OPEN",
        assign: true,
      },
    };
  }

  static async list(query = {}) {
    const [stages, settings] = await Promise.all([CrmSetupService.stages(), CrmSetupService.settings()]);
    const q = {};
    const status = rules.oneOf(query.status, rules.OPPORTUNITY_STATUS);
    if (status) q.status = status;
    const stageKey = rules.text(query.stageKey, 40);
    if (stageKey && stages.some((s) => s.key === stageKey)) q.stageKey = stageKey;
    if (rules.isId(query.ownerId)) q.ownerId = rules.text(query.ownerId, 24);
    if (rules.isId(query.customerId)) q.customerId = new mongoose.Types.ObjectId(rules.text(query.customerId, 24));
    const source = rules.oneOf(query.source, rules.LEAD_SOURCES);
    if (source) q.source = source;

    const search = rules.text(query.search, 100);
    if (search) {
      const rx = { $regex: escape(search), $options: "i" };
      q.$or = [{ title: rx }, { customerName: rx }, { opportunityNo: rx }];
    }
    const from = rules.day(query.from);
    const to = rules.day(query.to);
    if (from || to) {
      q.createdAt = {};
      if (from) q.createdAt.$gte = new Date(`${from}T00:00:00.000Z`);
      if (to) q.createdAt.$lte = new Date(`${to}T23:59:59.999Z`);
    }

    const limit = Math.min(500, Math.max(1, Math.round(rules.num(query.limit) || 300)));
    const rows = await Opportunity.find(q).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
    const today = todayInOrg();
    return rows.map((r) => this.present(r, { stages, settings, today }));
  }

  /** The board: every stage with the deals on it, and what the pipeline is worth. */
  /**
   * The customers a deal can be opened on: an id, a name and a code, and nothing else. The deal form used to read the
   * customer master itself, which asks for a Sales permission - a CRM-only organisation has none to give - and hands
   * over the whole record, credit limit and balance included, to a person who only wanted to choose one. This is the
   * CRM's own narrow read (like `owners`): enough to pick, no more.
   */
  static async customerChoices(query = {}) {
    const q = {};
    const search = rules.text(query.search, 80);
    if (search) {
      const rx = { $regex: escape(search), $options: "i" };
      q.$or = [{ customerName: rx }, { customerId: rx }];
    }
    if (rules.text(query.status, 10) !== "all") q.status = { $ne: "Inactive" };
    const limit = Math.min(500, Math.max(1, Math.round(rules.num(query.limit) || 200)));
    const rows = await Customer.find(q).select("customerName customerId status").sort({ customerName: 1, _id: 1 }).limit(limit).lean();
    return rows.map((r) => ({ id: String(r._id), name: r.customerName || "", code: r.customerId || "", active: r.status !== "Inactive" }));
  }

  static async pipeline(query = {}) {
    const [stages, settings] = await Promise.all([CrmSetupService.stages(), CrmSetupService.settings()]);
    const q = { status: "OPEN" };
    if (rules.isId(query.ownerId)) q.ownerId = rules.text(query.ownerId, 24);
    const rows = await Opportunity.find(q).sort({ stageSinceDay: 1, createdAt: -1 }).limit(500).lean();
    const today = todayInOrg();
    const deals = rows.map((r) => this.present(r, { stages, settings, today }));
    const totals = rules.weightedValue(rows, stages);
    return {
      today,
      stages: rules.funnel(stages, rows).map((s) => ({ ...s, deals: deals.filter((d) => d.stageKey === s.key) })),
      totals: {
        ...totals,
        count: deals.length,
        stale: deals.filter((d) => d.stale.isStale).length,
        overdueAction: deals.filter((d) => d.overdueAction).length,
      },
    };
  }

  static async getById(id) {
    const [stages, settings] = await Promise.all([CrmSetupService.stages(), CrmSetupService.settings()]);
    if (!rules.isId(id)) throw fail("Deal not found", 404, "OPPORTUNITY_NOT_FOUND");
    const doc = await Opportunity.findById(id).lean();
    if (!doc) throw fail("Deal not found", 404, "OPPORTUNITY_NOT_FOUND");
    const [timeline, customer] = await Promise.all([
      ActivityService.timeline({ regardingId: id }),
      Customer.findById(doc.customerId).select("customerName phone email creditLimit paymentTerms").lean(),
    ]);
    return { ...this.present(doc, { stages, settings }), timeline, customer: customer || null, pipeline: stages };
  }

  static async load(id, session) {
    if (!rules.isId(id)) throw fail("Deal not found", 404, "OPPORTUNITY_NOT_FOUND");
    const doc = await Opportunity.findById(id).session(session || null);
    if (!doc) throw fail("Deal not found", 404, "OPPORTUNITY_NOT_FOUND");
    return doc;
  }

  static async openOne(id, session) {
    const doc = await this.load(id, session);
    if (doc.status !== "OPEN") throw fail(`${doc.opportunityNo || "That deal"} is already ${doc.status.toLowerCase()}`, 409, "OPPORTUNITY_CLOSED");
    return doc;
  }

  // ---- writing ------------------------------------------------------------------------------------------

  static create = withTransactionSession(async (data, by, session) => {
    const stages = await CrmSetupService.stages({ session });
    const errors = rules.validateOpportunity(data, { stages });
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });

    const customer = await Customer.findById(rules.text(data.customerId, 24)).select("customerName").lean();
    if (!customer) throw fail("Customer not found", 404, "CUSTOMER_NOT_FOUND");

    const first = stages.filter((s) => s.type === "open").sort((a, b) => a.order - b.order)[0];
    if (!first) throw fail("This organisation's pipeline has no open stage to put a deal on", 409, "STAGE_NOT_FOUND");
    const stage = rules.stageByKey(stages, rules.text(data.stageKey, 40)) || first;

    const ownerId = rules.isId(data.ownerId) ? rules.text(data.ownerId, 24) : rules.isId(by) ? String(by) : null;
    const today = todayInOrg();
    const [doc] = await Opportunity.create(
      [
        {
          opportunityNo: await NumberSeriesService.allocate("OPP", new Date(), { session }),
          title: rules.text(data.title, 150),
          customerId: customer._id,
          customerName: customer.customerName || "",
          leadId: rules.isId(data.leadId) ? new mongoose.Types.ObjectId(rules.text(data.leadId, 24)) : null,
          stageKey: stage.key,
          stageName: stage.name,
          probability: stage.probability,
          stageSinceDay: today,
          value: rules.round2(rules.num(data.value)),
          expectedCloseDate: rules.day(data.expectedCloseDate),
          status: "OPEN",
          source: rules.oneOf(data.source, rules.LEAD_SOURCES) || "other",
          openedDay: today,
          ownerId,
          ownerName: await CrmSetupService.ownerName(ownerId),
          notes: rules.text(data.notes, 2000),
          createdBy: String(by || "system"),
          companyId: getTenant().companyId,
        },
      ],
      { session }
    );
    // A new deal gets its first next action straight away: the point of the module is that nothing is ever left with
    // nobody owing anything.
    await ActivityService.ensureAuto({ opportunity: doc, stage, settings: await CrmSetupService.settings({ session }), today, session });
    return doc;
  });

  static update = withTransactionSession(async (id, data, by, session) => {
    const doc = await OpportunityService.openOne(id, session);
    const stages = await CrmSetupService.stages({ session });
    const errors = rules.validateOpportunity(data, { stages, partial: true });
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });

    if (data.title !== undefined) doc.title = rules.text(data.title, 150) || doc.title;
    if (data.value !== undefined) doc.value = rules.round2(rules.num(data.value));
    if (data.expectedCloseDate !== undefined) doc.expectedCloseDate = rules.day(data.expectedCloseDate);
    if (data.source !== undefined) doc.source = rules.oneOf(data.source, rules.LEAD_SOURCES) || doc.source;
    if (data.notes !== undefined) doc.notes = rules.text(data.notes, 2000);
    if (data.customerId !== undefined && rules.isId(data.customerId)) {
      const customer = await Customer.findById(rules.text(data.customerId, 24)).select("customerName").lean();
      if (!customer) throw fail("Customer not found", 404, "CUSTOMER_NOT_FOUND");
      doc.customerId = customer._id;
      doc.customerName = customer.customerName || "";
    }
    doc.updatedBy = String(by || "system");
    await doc.save({ session });
    return doc;
  });

  /**
   * Where a deal goes, by hand or because a document moved it. Everything a stage change means is here: the copies a
   * list reads (name, probability), the day it moved, whether the deal is now closed, and the next follow-up.
   */
  static async enterStage(doc, stage, { by = "system", session, today = null } = {}) {
    const settings = await CrmSetupService.settings({ session });
    const day = today || todayInOrg();
    doc.stageKey = stage.key;
    doc.stageName = stage.name;
    doc.probability = stage.probability;
    doc.stageSinceDay = day;
    doc.status = stage.type === "won" ? "WON" : stage.type === "lost" ? "LOST" : "OPEN";
    doc.closedDay = stage.type === "open" ? null : day;
    if (stage.type === "open") doc.lostReason = null;
    doc.updatedBy = String(by || "system");
    await doc.save({ session });

    if (stage.type === "open") {
      await ActivityService.ensureAuto({ opportunity: doc, stage, settings, today: day, session });
    } else {
      // A closed deal owes nobody anything: its open reminders are cancelled rather than left to go overdue.
      const CrmActivity = require("../../models/modules/crm/crmActivityModel");
      await CrmActivity.updateMany({ "regarding.id": doc._id, status: "OPEN" }, { $set: { status: "CANCELLED" } }, { session });
      await ActivityService.touch("opportunity", doc._id, session);
    }
    return doc;
  }

  static moveStage = withTransactionSession(async (id, input, by, session) => {
    const doc = await OpportunityService.openOne(id, session);
    const stages = await CrmSetupService.stages({ session });
    const stage = rules.stageByKey(stages, rules.text(input?.stageKey, 40));
    if (!stage) throw fail("That stage is not in this organisation's pipeline", 400, "STAGE_NOT_FOUND");
    if (stage.type === "lost" && !rules.oneOf(input?.lostReason, rules.LOST_REASONS)) {
      throw fail("Say why the deal was lost", 400, "LOST_REASON_REQUIRED");
    }
    if (stage.type === "lost") {
      doc.lostReason = rules.oneOf(input.lostReason, rules.LOST_REASONS);
      doc.lostNote = rules.text(input?.lostNote, 300);
    }
    // The note is recorded by the controller's audit row; the stage change itself needs only where it is going.
    return OpportunityService.enterStage(doc, stage, { by, session });
  });

  static lose = withTransactionSession(async (id, input, by, session) => {
    const doc = await OpportunityService.openOne(id, session);
    const reason = rules.oneOf(input?.reason, rules.LOST_REASONS);
    if (!reason) throw fail("Say why the deal was lost", 400, "LOST_REASON_REQUIRED");
    const stages = await CrmSetupService.stages({ session });
    const lost = stages.find((s) => s.type === "lost");
    if (!lost) throw fail("This organisation's pipeline has no lost stage", 409, "STAGE_NOT_FOUND");
    doc.lostReason = reason;
    doc.lostNote = rules.text(input?.note, 300);
    return OpportunityService.enterStage(doc, lost, { by, session });
  });

  static win = withTransactionSession(async (id, input, by, session) => {
    const doc = await OpportunityService.openOne(id, session);
    const stages = await CrmSetupService.stages({ session });
    const won = stages.find((s) => s.type === "won");
    if (!won) throw fail("This organisation's pipeline has no won stage", 409, "STAGE_NOT_FOUND");
    if (input?.value !== undefined) doc.value = rules.round2(rules.num(input.value));
    return OpportunityService.enterStage(doc, won, { by, session });
  });

  /** A closed deal that was closed too early. It goes back to the last open stage, not to the beginning. */
  static reopen = withTransactionSession(async (id, by, session) => {
    const doc = await OpportunityService.load(id, session);
    if (doc.status === "OPEN") throw fail("That deal is already open", 409, "OPPORTUNITY_OPEN");
    const stages = await CrmSetupService.stages({ session });
    const open = stages.filter((s) => s.type === "open").sort((a, b) => b.order - a.order)[0];
    if (!open) throw fail("This organisation's pipeline has no open stage", 409, "STAGE_NOT_FOUND");
    doc.lostReason = null;
    doc.lostNote = "";
    return OpportunityService.enterStage(doc, open, { by, session });
  });

  static assign = withTransactionSession(async (id, ownerId, by, session) => {
    const doc = await OpportunityService.load(id, session);
    if (!rules.isId(ownerId)) throw fail("Choose the person to give it to", 400, "OPPORTUNITY_OWNER_INVALID");
    const owners = await CrmSetupService.owners();
    const owner = owners.find((o) => o.id === rules.text(ownerId, 24));
    if (!owner) throw fail("That person cannot be given CRM work", 400, "OPPORTUNITY_OWNER_INVALID");
    doc.ownerId = owner.id;
    doc.ownerName = owner.name;
    doc.updatedBy = String(by || "system");
    await doc.save({ session });
    const CrmActivity = require("../../models/modules/crm/crmActivityModel");
    // The open follow-ups go with it: a deal handed over with somebody else's reminders on it is a deal nobody chases.
    await CrmActivity.updateMany(
      { "regarding.id": doc._id, status: "OPEN" },
      { $set: { ownerId: owner.id, ownerName: owner.name } },
      { session }
    );
    return doc;
  });

  static remove = withTransactionSession(async (id, by, session) => {
    const doc = await OpportunityService.load(id, session);
    if (doc.status === "WON") throw fail("A won deal is a record of what happened and stays", 409, "OPPORTUNITY_WON");
    const CrmActivity = require("../../models/modules/crm/crmActivityModel");
    await CrmActivity.deleteMany({ "regarding.id": doc._id }, { session });
    await Lead.updateMany({ opportunityId: doc._id }, { $set: { opportunityId: null } }, { session });
    await Opportunity.findByIdAndDelete(doc._id, { session });
    return doc;
  });
}

module.exports = OpportunityService;
