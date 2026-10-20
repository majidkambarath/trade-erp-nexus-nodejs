// Follow-ups: the calls, visits, messages and notes against a lead, a deal or a customer, and the open one that says
// what is owed next. Two kinds of writer come through here - a person logging what they did, and the automation leaving
// the next action behind when a deal enters a stage (`ensureAuto`, claimed by a dedupeKey so a replay is a no-op).
//
// `touch` is what keeps a lead or a deal honest about itself: the earliest open follow-up becomes its `nextActionAt`,
// the last completed one its `lastActivityDay`, and the completed count its `contactCount` (which the lead score
// reads). Nothing recomputes those from a request body.
const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const CrmActivity = require("../../models/modules/crm/crmActivityModel");
const Lead = require("../../models/modules/crm/leadModel");
const Opportunity = require("../../models/modules/crm/opportunityModel");
const rules = require("../../utils/crm");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { todayInOrg, toExpiryDay } = require("../../utils/documentExpiry");
const { getTenant } = require("../../utils/tenant");
const CrmSetupService = require("./crmSetupService");

const fail = (message, status, code, details) => new AppError(message, status, code, details);
const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

class ActivityService {
  static present(doc) {
    const a = doc?.toObject ? doc.toObject() : doc;
    const today = todayInOrg();
    return {
      ...a,
      dueState: rules.dueState(a, today),
      kindLabel: rules.KIND_LABEL[a.kind] || a.kind,
      actions: {
        edit: a.status === "OPEN",
        done: a.status === "OPEN",
        delete: a.status !== "DONE",
      },
    };
  }

  /**
   * The follow-up worklist. `scope: "mine"` is the only one that needs a person, and it is the default for the badge:
   * a reminder belongs to whoever owes it, not to everyone who can see the module.
   */
  static async list(query = {}, { adminId = null } = {}) {
    const q = {};
    const status = rules.oneOf(query.status, rules.ACTIVITY_STATUS);
    q.status = status || "OPEN";

    const kind = rules.oneOf(query.kind, rules.ACTIVITY_KINDS);
    if (kind) q.kind = kind;

    if (rules.text(query.scope, 20) === "mine") q.ownerId = rules.isId(adminId) ? String(adminId) : "__nobody__";
    else if (rules.isId(query.ownerId)) q.ownerId = rules.text(query.ownerId, 24);

    if (rules.isId(query.regardingId)) q["regarding.id"] = new mongoose.Types.ObjectId(rules.text(query.regardingId, 24));
    if (rules.isId(query.customerId)) q.customerId = new mongoose.Types.ObjectId(rules.text(query.customerId, 24));

    const due = rules.text(query.due, 20);
    if (["overdue", "today", "week"].includes(due)) {
      const { from, to } = rules.followUpRange(due, todayInOrg());
      const range = {};
      if (from) range.$gte = from;
      if (to) range.$lte = to;
      if (Object.keys(range).length) q.dueAt = range;
    }

    const search = rules.text(query.search, 100);
    if (search) q.subject = { $regex: escape(search), $options: "i" };

    const limit = Math.min(300, Math.max(1, Math.round(rules.num(query.limit) || 200)));
    const rows = await CrmActivity.find(q).sort({ dueAt: 1, createdAt: -1, _id: -1 }).limit(limit).lean();
    return rows.map((r) => this.present(r));
  }

  /** How many open follow-ups this person owes today or earlier: the nav badge, and nothing more. */
  static async dueCount({ adminId }) {
    if (!rules.isId(adminId)) return { count: 0 };
    const count = await CrmActivity.countDocuments({ status: "OPEN", ownerId: String(adminId), dueAt: { $lte: todayInOrg() } });
    return { count };
  }

  static async load(id, session) {
    if (!rules.isId(id)) throw fail("Follow-up not found", 404, "ACTIVITY_NOT_FOUND");
    const doc = await CrmActivity.findById(id).session(session || null);
    if (!doc) throw fail("Follow-up not found", 404, "ACTIVITY_NOT_FOUND");
    return doc;
  }

  /** The lead or deal a follow-up is about, so a request cannot point one at something in another branch. */
  static async parentOf(regarding, session) {
    const kind = rules.oneOf(regarding?.kind, rules.REGARDING_KINDS);
    const id = rules.text(regarding?.id, 24);
    if (!kind || !rules.isId(id)) throw fail("A follow-up must be about a lead, a deal or a customer", 400, "ACTIVITY_REGARDING_INVALID");
    if (kind === "lead") {
      const lead = await Lead.findById(id).session(session || null).lean();
      if (!lead) throw fail("Lead not found", 404, "LEAD_NOT_FOUND");
      return { kind, id, customerId: lead.customerId || null, ownerId: lead.ownerId || null, name: lead.name };
    }
    if (kind === "opportunity") {
      const opp = await Opportunity.findById(id).session(session || null).lean();
      if (!opp) throw fail("Deal not found", 404, "OPPORTUNITY_NOT_FOUND");
      return { kind, id, customerId: opp.customerId || null, ownerId: opp.ownerId || null, name: opp.title };
    }
    const Customer = require("../../models/modules/customerModel");
    const customer = await Customer.findById(id).select("customerName").lean();
    if (!customer) throw fail("Customer not found", 404, "CUSTOMER_NOT_FOUND");
    return { kind, id, customerId: id, ownerId: null, name: customer.customerName };
  }

  static create = withTransactionSession(async (data, by, session) => {
    const errors = rules.validateActivity(data);
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });
    const parent = await ActivityService.parentOf(data.regarding, session);

    const ownerId = rules.isId(data.ownerId) ? rules.text(data.ownerId, 24) : parent.ownerId || (rules.isId(by) ? String(by) : null);
    const [doc] = await CrmActivity.create(
      [
        {
          kind: rules.oneOf(data.kind, rules.ACTIVITY_KINDS),
          subject: rules.text(data.subject, 200),
          notes: rules.text(data.notes, 2000),
          regarding: { kind: parent.kind, id: new mongoose.Types.ObjectId(parent.id) },
          customerId: parent.customerId || null,
          ownerId,
          ownerName: await CrmSetupService.ownerName(ownerId),
          dueAt: rules.day(data.dueAt) || todayInOrg(),
          // A note is a thing that happened, not a thing to do: it is recorded as done at once, so it never sits in
          // somebody's worklist asking to be ticked off.
          status: rules.oneOf(data.kind, rules.ACTIVITY_KINDS) === "note" ? "DONE" : "OPEN",
          completedAt: rules.oneOf(data.kind, rules.ACTIVITY_KINDS) === "note" ? new Date() : null,
          outcome: rules.oneOf(data.outcome, rules.OUTCOMES),
          auto: false,
          createdBy: String(by || "system"),
          companyId: getTenant().companyId,
        },
      ],
      { session }
    );
    await ActivityService.touch(parent.kind, parent.id, session);
    return doc;
  });

  static update = withTransactionSession(async (id, data, by, session) => {
    const doc = await ActivityService.load(id, session);
    if (doc.status === "DONE") throw fail("A follow-up that is done cannot be changed", 409, "ACTIVITY_DONE");
    const errors = rules.validateActivity(data, { partial: true });
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });

    if (data.kind !== undefined) doc.kind = rules.oneOf(data.kind, rules.ACTIVITY_KINDS) || doc.kind;
    if (data.subject !== undefined) doc.subject = rules.text(data.subject, 200) || doc.subject;
    if (data.notes !== undefined) doc.notes = rules.text(data.notes, 2000);
    if (data.dueAt !== undefined) doc.dueAt = rules.day(data.dueAt) || doc.dueAt;
    if (data.ownerId !== undefined && rules.isId(data.ownerId)) {
      doc.ownerId = rules.text(data.ownerId, 24);
      doc.ownerName = await CrmSetupService.ownerName(doc.ownerId);
    }
    doc.updatedBy = String(by || "system");
    await doc.save({ session });
    await ActivityService.touch(doc.regarding.kind, doc.regarding.id, session);
    return doc;
  });

  /**
   * Done, and what happened. The outcome is recorded, and the next follow-up may be entered in the same breath - which
   * is the whole point: a person who has just rung a customer is the one who knows when to ring again, and the screen
   * offers it pre-filled rather than leaving the deal with nothing owed.
   */
  static done = withTransactionSession(async (id, input, by, session) => {
    const doc = await ActivityService.load(id, session);
    if (doc.status === "DONE") throw fail("That follow-up is already done", 409, "ACTIVITY_DONE");
    const outcome = rules.oneOf(input?.outcome, rules.OUTCOMES);
    if (!outcome) throw fail("Say what came of it", 400, "ACTIVITY_OUTCOME_INVALID");

    doc.status = "DONE";
    doc.outcome = outcome;
    doc.completedAt = new Date();
    doc.completedBy = String(by || "system");
    if (input?.notes !== undefined) doc.notes = rules.text(input.notes, 2000);
    await doc.save({ session });

    let next = null;
    const nextDay = rules.day(input?.nextDueAt);
    if (nextDay) {
      const [made] = await CrmActivity.create(
        [
          {
            kind: rules.oneOf(input?.nextKind, rules.ACTIVITY_KINDS) || doc.kind,
            subject: rules.text(input?.nextSubject, 200) || doc.subject,
            regarding: { kind: doc.regarding.kind, id: doc.regarding.id },
            customerId: doc.customerId || null,
            ownerId: doc.ownerId,
            ownerName: doc.ownerName,
            dueAt: nextDay,
            status: "OPEN",
            auto: false,
            createdBy: String(by || "system"),
            companyId: getTenant().companyId,
          },
        ],
        { session }
      );
      next = made;
    }
    await ActivityService.touch(doc.regarding.kind, doc.regarding.id, session);
    return { activity: doc, next };
  });

  static remove = withTransactionSession(async (id, by, session) => {
    const doc = await ActivityService.load(id, session);
    if (doc.status === "DONE") throw fail("A follow-up that is done is a record of what happened and stays", 409, "ACTIVITY_DONE");
    const { kind, id: parentId } = doc.regarding;
    await CrmActivity.findByIdAndDelete(doc._id, { session });
    await ActivityService.touch(kind, parentId, session);
    return doc;
  });

  /** The open follow-ups against one lead or deal. */
  static async openFor(regardingId, session) {
    if (!rules.isId(regardingId)) return [];
    return CrmActivity.find({ "regarding.id": new mongoose.Types.ObjectId(String(regardingId)), status: "OPEN" })
      .session(session || null)
      .lean();
  }

  /** Everything against one lead, deal or customer, newest first: the timeline a screen draws. */
  static async timeline({ regardingId = null, customerId = null, limit = 100 }, session) {
    const q = {};
    if (rules.isId(regardingId)) q["regarding.id"] = new mongoose.Types.ObjectId(String(regardingId));
    else if (rules.isId(customerId)) q.customerId = new mongoose.Types.ObjectId(String(customerId));
    else return [];
    const rows = await CrmActivity.find(q)
      .sort({ createdAt: -1, _id: -1 })
      .limit(Math.min(300, Math.max(1, Math.round(limit))))
      .session(session || null)
      .lean();
    return rows.map((r) => ActivityService.present(r));
  }

  /**
   * The automatic next action for a deal that has just entered a stage.
   *
   * Three rules, in this order:
   *  - a follow-up a PERSON entered always wins: the automation never argues with somebody who has decided when to
   *    ring next, so if any non-auto action is open, nothing is created;
   *  - the automation's own placeholder from the stage the deal has just LEFT is replaced, not added to - a deal that
   *    has moved to "Quotation sent" must be chased by that stage's clock, not by the one it came from;
   *  - the same stage entered twice leaves one follow-up: `dedupeKey` is read BEFORE inserting rather than relying on
   *    catching a duplicate key, because inside a transaction a duplicate key aborts the whole transaction and
   *    catching it afterwards does not bring it back (that is how an approved invoice once failed to delete).
   *    Re-entering a stage whose follow-up was cancelled when the deal closed revives it with a fresh due date.
   */
  static async ensureAuto({ opportunity, stage, settings, today, session }) {
    if (settings && settings.autoFollowUp === false) return null;
    if (!stage || stage.type !== "open") return null;

    const open = await this.openFor(opportunity._id, session);
    if (open.some((a) => !a.auto)) return null;

    const dedupeKey = `crm_stage:${opportunity._id}:${stage.key}`;
    const plan = rules.planFollowUp({ opportunity, stage, openActivities: [], settings, today, ownerId: opportunity.ownerId });
    if (!plan) return null;

    // The placeholders the automation left on earlier stages are done with.
    const stale = open.filter((a) => a.auto && a.dedupeKey !== dedupeKey).map((a) => a._id);
    if (stale.length) await CrmActivity.updateMany({ _id: { $in: stale } }, { $set: { status: "CANCELLED" } }, { session });

    const existing = await CrmActivity.findOne({ dedupeKey }).session(session || null).lean();
    if (existing) {
      if (existing.status === "OPEN") return null; // this very stage entry already left its follow-up
      await CrmActivity.updateOne(
        { _id: existing._id },
        { $set: { status: "OPEN", dueAt: plan.dueAt, ownerId: plan.ownerId, ownerName: opportunity.ownerName || "", completedAt: null, outcome: null, subject: plan.subject } },
        { session }
      );
      await this.touch("opportunity", opportunity._id, session);
      return CrmActivity.findById(existing._id).session(session || null);
    }

    const [made] = await CrmActivity.create(
      [
        {
          kind: plan.kind,
          subject: plan.subject,
          regarding: { kind: "opportunity", id: opportunity._id },
          customerId: opportunity.customerId || null,
          ownerId: plan.ownerId,
          ownerName: opportunity.ownerName || "",
          dueAt: plan.dueAt,
          status: "OPEN",
          auto: true,
          dedupeKey,
          createdBy: "automation",
          companyId: getTenant().companyId,
        },
      ],
      { session }
    );
    await this.touch("opportunity", opportunity._id, session);
    return made;
  }

  /**
   * Put back on the lead or deal what its follow-ups say about it: when the next one is due, when the last contact
   * was, and how many there have been. One query per fact, all inside the caller's session.
   */
  static async touch(kind, id, session) {
    if (!rules.isId(id)) return;
    const oid = new mongoose.Types.ObjectId(String(id));
    const [next] = await CrmActivity.find({ "regarding.id": oid, status: "OPEN" })
      .sort({ dueAt: 1 })
      .limit(1)
      .session(session || null)
      .lean();
    const [last] = await CrmActivity.find({ "regarding.id": oid, status: "DONE" })
      .sort({ completedAt: -1 })
      .limit(1)
      .session(session || null)
      .lean();
    const done = await CrmActivity.countDocuments({ "regarding.id": oid, status: "DONE" }).session(session || null);

    const set = {
      nextActionAt: next ? next.dueAt : null,
      lastActivityAt: last ? last.completedAt : null,
      lastActivityDay: last?.completedAt ? toExpiryDay(last.completedAt) : null,
    };
    if (kind === "lead") {
      await Lead.updateOne({ _id: oid }, { $set: { ...set, contactCount: done } }, { session });
      const lead = await Lead.findById(oid).session(session || null);
      if (lead) {
        const { score, band } = rules.leadScore({ ...lead.toObject(), contactCount: done }, todayInOrg());
        await Lead.updateOne({ _id: oid }, { $set: { score, band } }, { session });
      }
    } else if (kind === "opportunity") {
      await Opportunity.updateOne({ _id: oid }, { $set: set }, { session });
    }
  }
}

module.exports = ActivityService;
