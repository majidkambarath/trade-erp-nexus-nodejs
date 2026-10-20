// Leads: the enquiry, who owns it, how warm it is, and the one action that turns it into business.
//
// `qualify` is the join between the CRM and the engine. It creates a real Customer - with its customer id, its ledger
// account and everything else a party gets - and a deal on the first stage of the pipeline, and leaves the lead
// pointing at both. Deliberately NOT one transaction, because CustomerService.createCustomer opens and commits its own
// session and cannot join ours: the customer is made first and written onto the lead immediately, so a retry after a
// failure further down reuses that customer instead of making a second one.
const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const Lead = require("../../models/modules/crm/leadModel");
const Opportunity = require("../../models/modules/crm/opportunityModel");
const CrmActivity = require("../../models/modules/crm/crmActivityModel");
const Customer = require("../../models/modules/customerModel");
const CustomerService = require("../customer/customerService");
const rules = require("../../utils/crm");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { todayInOrg } = require("../../utils/documentExpiry");
const { getTenant } = require("../../utils/tenant");
const NumberSeriesService = require("../core/numberSeriesService");
const CrmSetupService = require("./crmSetupService");
const ActivityService = require("./activityService");
const OpportunityService = require("./opportunityService");

const fail = (message, status, code, details) => new AppError(message, status, code, details);
const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OPEN_STATUS = ["NEW", "CONTACTED", "QUALIFIED"];

class LeadService {
  // ---- reading ------------------------------------------------------------------------------------------

  static present(doc, { today = null } = {}) {
    const l = doc?.toObject ? doc.toObject() : doc;
    const day = today || todayInOrg();
    const open = OPEN_STATUS.includes(l.status);
    return {
      ...l,
      sourceLabel: rules.SOURCE_LABEL[l.source] || l.source,
      lostLabel: l.lostReason ? rules.LOST_LABEL[l.lostReason] : null,
      idleDays: l.lastActivityDay ? Math.max(0, rules.diffDays(l.lastActivityDay, day)) : null,
      overdueAction: l.nextActionAt ? rules.diffDays(day, l.nextActionAt) < 0 : false,
      actions: {
        edit: open,
        delete: open && !l.customerId,
        qualify: open,
        lose: open,
        assign: open,
        logActivity: open,
      },
    };
  }

  static async list(query = {}) {
    const q = {};
    const status = rules.oneOf(query.status, rules.LEAD_STATUS);
    if (status) q.status = status;
    else if (rules.text(query.view, 20) === "open") q.status = { $in: OPEN_STATUS };

    const source = rules.oneOf(query.source, rules.LEAD_SOURCES);
    if (source) q.source = source;
    const band = rules.text(query.band, 10);
    if (["hot", "warm", "cold"].includes(band)) q.band = band;
    if (rules.isId(query.ownerId)) q.ownerId = rules.text(query.ownerId, 24);
    if (rules.text(query.ownerId, 20) === "none") q.ownerId = null;

    const search = rules.text(query.search, 100);
    if (search) {
      const rx = { $regex: escape(search), $options: "i" };
      q.$or = [{ name: rx }, { company: rx }, { phone: rx }, { email: rx }, { leadNo: rx }];
    }
    const from = rules.day(query.from);
    const to = rules.day(query.to);
    if (from || to) {
      q.createdAt = {};
      if (from) q.createdAt.$gte = new Date(`${from}T00:00:00.000Z`);
      if (to) q.createdAt.$lte = new Date(`${to}T23:59:59.999Z`);
    }

    const limit = Math.min(500, Math.max(1, Math.round(rules.num(query.limit) || 300)));
    const rows = await Lead.find(q).sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
    const today = todayInOrg();
    return rows.map((r) => this.present(r, { today }));
  }

  /** The cards above the list: what is in hand, what nobody has touched, what is late. */
  static async summary() {
    const today = todayInOrg();
    const [rows, overdue] = await Promise.all([
      Lead.find({}).select("status source band expectedValue nextActionAt ownerId").limit(2000).lean(),
      CrmActivity.countDocuments({ status: "OPEN", dueAt: { $lt: today }, "regarding.kind": "lead" }),
    ]);
    const open = rows.filter((r) => OPEN_STATUS.includes(r.status));
    return {
      today,
      total: rows.length,
      open: open.length,
      hot: open.filter((r) => r.band === "hot").length,
      unassigned: open.filter((r) => !r.ownerId).length,
      converted: rows.filter((r) => r.status === "CONVERTED").length,
      lost: rows.filter((r) => r.status === "LOST").length,
      openValue: rules.round2(open.reduce((t, r) => t + rules.num(r.expectedValue), 0)),
      overdueFollowUps: overdue,
    };
  }

  static async getById(id) {
    if (!rules.isId(id)) throw fail("Lead not found", 404, "LEAD_NOT_FOUND");
    const doc = await Lead.findById(id).lean();
    if (!doc) throw fail("Lead not found", 404, "LEAD_NOT_FOUND");
    const [timeline, opportunity] = await Promise.all([
      ActivityService.timeline({ regardingId: id }),
      doc.opportunityId ? Opportunity.findById(doc.opportunityId).lean() : null,
    ]);
    return { ...this.present(doc), timeline, opportunity: opportunity || null };
  }

  static async load(id, session) {
    if (!rules.isId(id)) throw fail("Lead not found", 404, "LEAD_NOT_FOUND");
    const doc = await Lead.findById(id).session(session || null);
    if (!doc) throw fail("Lead not found", 404, "LEAD_NOT_FOUND");
    return doc;
  }

  static async openOne(id, session) {
    const doc = await this.load(id, session);
    if (!OPEN_STATUS.includes(doc.status)) {
      throw fail(`${doc.leadNo || "That lead"} has already been ${doc.status.toLowerCase()}`, 409, "LEAD_CLOSED");
    }
    return doc;
  }

  /**
   * Somebody we may already know. A warning, never a refusal: the same person does enquire twice, and a CRM that
   * refuses the second enquiry loses the business. The screen shows what it found and lets the person decide.
   */
  static async possibleDuplicates({ phone, email, name }) {
    const or = [];
    const tidyPhone = rules.text(phone, 40).replace(/\s+/g, "");
    if (tidyPhone.length >= 6) or.push({ phone: { $regex: escape(tidyPhone.slice(-8)) } });
    const tidyEmail = rules.text(email, 150).toLowerCase();
    if (tidyEmail) or.push({ email: tidyEmail });
    if (!or.length) return { leads: [], customers: [] };
    const [leads, customers] = await Promise.all([
      Lead.find({ $or: or }).select("leadNo name company phone email status").limit(5).lean(),
      Customer.find({ $or: or.map((o) => (o.email ? { email: o.email } : { phone: o.phone })) })
        .select("customerId customerName phone email")
        .limit(5)
        .lean(),
    ]);
    void name;
    return { leads, customers };
  }

  // ---- writing ------------------------------------------------------------------------------------------

  /**
   * A new enquiry. The automation does three things here without being asked: it gives the lead an owner (round robin,
   * or whatever the organisation chose), it scores it, and it leaves a first follow-up due - so an enquiry can never be
   * taken and then forgotten, which is the one failure this module exists to prevent.
   */
  static create = withTransactionSession(async (data, by, session) => {
    const errors = rules.validateLead(data);
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });

    const settings = await CrmSetupService.settings({ session });
    const assigned = rules.isId(data.ownerId)
      ? { ownerId: rules.text(data.ownerId, 24), ownerName: await CrmSetupService.ownerName(data.ownerId) }
      : await CrmSetupService.nextOwner({ createdBy: by });

    const today = todayInOrg();
    const fields = {
      leadNo: await NumberSeriesService.allocate("LD", new Date(), { session }),
      name: rules.text(data.name, 150),
      company: rules.text(data.company, 150),
      phone: rules.text(data.phone, 40),
      email: rules.text(data.email, 150).toLowerCase(),
      city: rules.text(data.city, 80),
      source: rules.oneOf(data.source, rules.LEAD_SOURCES) || "other",
      sourceNote: rules.text(data.sourceNote, 200),
      interest: rules.text(data.interest, 500),
      expectedValue: rules.round2(rules.num(data.expectedValue)),
      status: "NEW",
      ownerId: assigned.ownerId,
      ownerName: assigned.ownerName,
      notes: rules.text(data.notes, 2000),
      createdBy: String(by || "system"),
      companyId: getTenant().companyId,
    };
    const { score, band } = rules.leadScore({ ...fields, contactCount: 0 }, today);
    const [doc] = await Lead.create([{ ...fields, score, band }], { session });

    if (settings.autoFollowUp !== false) {
      const [made] = await CrmActivity.create(
        [
          {
            kind: rules.oneOf(data.source, rules.LEAD_SOURCES) === "whatsapp" ? "whatsapp" : "call",
            subject: `First contact: ${doc.name}`,
            regarding: { kind: "lead", id: doc._id },
            ownerId: doc.ownerId,
            ownerName: doc.ownerName,
            dueAt: today,
            status: "OPEN",
            auto: true,
            dedupeKey: `crm_lead_first:${doc._id}`,
            createdBy: "automation",
            companyId: getTenant().companyId,
          },
        ],
        { session }
      );
      doc.nextActionAt = made.dueAt;
      await doc.save({ session });
    }
    return doc;
  });

  static update = withTransactionSession(async (id, data, by, session) => {
    const doc = await LeadService.openOne(id, session);
    const errors = rules.validateLead(data, { partial: true });
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });

    const set = {
      name: "name", company: "company", city: "city", sourceNote: "sourceNote", interest: "interest", notes: "notes",
    };
    for (const [key, field] of Object.entries(set)) {
      if (data[key] !== undefined) doc[field] = rules.text(data[key], field === "notes" ? 2000 : field === "interest" ? 500 : 200);
    }
    if (data.phone !== undefined) doc.phone = rules.text(data.phone, 40);
    if (data.email !== undefined) doc.email = rules.text(data.email, 150).toLowerCase();
    if (data.source !== undefined) doc.source = rules.oneOf(data.source, rules.LEAD_SOURCES) || doc.source;
    if (data.expectedValue !== undefined) doc.expectedValue = rules.round2(rules.num(data.expectedValue));
    if (data.status !== undefined) {
      const status = rules.oneOf(data.status, rules.LEAD_STATUS);
      // CONVERTED and LOST are the results of an action (qualify, lose), never a word typed into a form.
      if (status && OPEN_STATUS.includes(status)) doc.status = status;
    }
    if (!doc.name) throw fail("Give the person or company a name", 400, "LEAD_NAME_REQUIRED");
    const { score, band } = rules.leadScore(doc.toObject(), todayInOrg());
    doc.score = score;
    doc.band = band;
    doc.updatedBy = String(by || "system");
    await doc.save({ session });
    return doc;
  });

  static assign = withTransactionSession(async (id, ownerId, by, session) => {
    const doc = await LeadService.openOne(id, session);
    if (!rules.isId(ownerId)) throw fail("Choose the person to give it to", 400, "LEAD_OWNER_INVALID");
    const owners = await CrmSetupService.owners();
    const owner = owners.find((o) => o.id === rules.text(ownerId, 24));
    if (!owner) throw fail("That person cannot be given CRM work", 400, "LEAD_OWNER_INVALID");
    doc.ownerId = owner.id;
    doc.ownerName = owner.name;
    doc.updatedBy = String(by || "system");
    await doc.save({ session });
    await CrmActivity.updateMany(
      { "regarding.id": doc._id, status: "OPEN" },
      { $set: { ownerId: owner.id, ownerName: owner.name } },
      { session }
    );
    return doc;
  });

  static lose = withTransactionSession(async (id, input, by, session) => {
    const doc = await LeadService.openOne(id, session);
    const reason = rules.oneOf(input?.reason, rules.LOST_REASONS);
    if (!reason) throw fail("Say why the lead came to nothing", 400, "LOST_REASON_REQUIRED");
    doc.status = "LOST";
    doc.lostReason = reason;
    doc.lostNote = rules.text(input?.note, 300);
    doc.lostAt = new Date();
    doc.nextActionAt = null;
    doc.updatedBy = String(by || "system");
    await doc.save({ session });
    await CrmActivity.updateMany({ "regarding.id": doc._id, status: "OPEN" }, { $set: { status: "CANCELLED" } }, { session });
    return doc;
  });

  /**
   * Qualify: this enquiry is real business. It becomes a customer (a new one, or an existing one the person picked) and
   * a deal on the first open stage. Two steps on purpose - see the note at the top of this file - and the customer is
   * recorded on the lead the moment it exists, so this is safe to run again after a failure.
   */
  static async qualify(id, input, by) {
    const lead = await this.openOne(id);
    let customerId = lead.customerId ? String(lead.customerId) : null;

    if (!customerId && rules.isId(input?.customerId)) {
      const existing = await Customer.findById(rules.text(input.customerId, 24)).select("_id").lean();
      if (!existing) throw fail("Customer not found", 404, "CUSTOMER_NOT_FOUND");
      customerId = String(existing._id);
    }
    if (!customerId) {
      const customer = await CustomerService.createCustomer({
        customerName: rules.text(input?.customerName, 150) || rules.text(lead.company, 150) || rules.text(lead.name, 150),
        contactPerson: rules.text(lead.name, 150),
        email: rules.text(lead.email, 150),
        phone: rules.text(lead.phone, 40),
        billingAddress: rules.text(input?.billingAddress, 300),
        shippingAddress: rules.text(input?.shippingAddress, 300),
        creditLimit: rules.num(input?.creditLimit),
        status: "Active",
        salesPerson: rules.text(lead.ownerName, 150),
      });
      customerId = String(customer._id);
    }
    // Written before the deal exists: a retry must never make a second customer for one lead.
    await Lead.updateOne({ _id: lead._id }, { $set: { customerId: new mongoose.Types.ObjectId(customerId) } });

    const opportunity = await OpportunityService.create(
      {
        title: rules.text(input?.title, 150) || `${rules.text(lead.company, 150) || rules.text(lead.name, 150)} - ${rules.text(lead.interest, 60) || "enquiry"}`,
        customerId,
        leadId: String(lead._id),
        value: rules.num(input?.value) || rules.num(lead.expectedValue),
        expectedCloseDate: rules.day(input?.expectedCloseDate),
        source: lead.source,
        ownerId: lead.ownerId,
        notes: rules.text(lead.interest, 500),
      },
      by
    );

    const finished = await this.finishQualify(lead._id, opportunity._id, by);
    return { lead: finished, opportunity, customerId };
  }

  static finishQualify = withTransactionSession(async (leadId, opportunityId, by, session) => {
    const doc = await LeadService.load(leadId, session);
    doc.status = "CONVERTED";
    doc.opportunityId = opportunityId;
    doc.convertedAt = new Date();
    doc.updatedBy = String(by || "system");
    await doc.save({ session });
    // The lead's own open follow-ups move to the deal: the chasing carries on, against the deal, with nothing lost.
    await CrmActivity.updateMany(
      { "regarding.id": doc._id, status: "OPEN" },
      { $set: { "regarding.kind": "opportunity", "regarding.id": opportunityId, customerId: doc.customerId } },
      { session }
    );
    // The deal was created a moment ago and the automation left it a placeholder action, because at that instant the
    // lead's own follow-ups still pointed at the lead. Now that they have come across, the person's own next action
    // wins and the placeholder goes: a deal that has just been qualified owes one thing, not two.
    const human = await CrmActivity.countDocuments({ "regarding.id": opportunityId, status: "OPEN", auto: false }).session(session);
    if (human > 0) await CrmActivity.deleteMany({ "regarding.id": opportunityId, status: "OPEN", auto: true }, { session });

    await ActivityService.touch("lead", doc._id, session);
    await ActivityService.touch("opportunity", opportunityId, session);
    return doc;
  });

  static remove = withTransactionSession(async (id, by, session) => {
    const doc = await LeadService.load(id, session);
    if (doc.status === "CONVERTED") throw fail("A lead that became a customer stays on record", 409, "LEAD_CONVERTED");
    await CrmActivity.deleteMany({ "regarding.id": doc._id }, { session });
    await Lead.findByIdAndDelete(doc._id, { session });
    return doc;
  });
}

module.exports = LeadService;
