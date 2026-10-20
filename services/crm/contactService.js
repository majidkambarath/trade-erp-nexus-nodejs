// Contacts: the people behind the companies.
//
// THE ONE RULE. A contact that belongs to a customer or a supplier lives in two places under the SAME _id: here, and
// in that party's own `contacts[]` array. The party's array stays AUTHORITATIVE - it is what the party form shows, what
// services/messaging/documentSource.js reads to address an e-mail, and what the shared snapshot deliberately withholds.
// So this service never writes that array by hand: it builds the next list and puts it through the existing
// `PartyMasterService.prepare` path, which already validates names, settles exactly one primary and keeps the party's
// flat contactPerson / email / phone in step (services/masters/partyMasterService.js). One set of rules, not two.
//
// The other direction is covered by `PartyMasterService.finish`, which runs after every party save in all four write
// paths, so a contact edited on the customer form reaches this collection without the customer service knowing we exist.
//
// `normalizeContacts` returns rows with NO _id (utils/partyMaster.js), so this service mints the id itself before
// writing: that is what lets the Contact row and the party's row share one, with no mapping table anywhere.
const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const Contact = require("../../models/modules/crm/contactModel");
const CrmActivity = require("../../models/modules/crm/crmActivityModel");
const PartyMaster = require("../masters/partyMasterService");
const rules = require("../../utils/crm");
const { getTenant } = require("../../utils/tenant");
const logger = require("../../utils/logger");

const fail = (message, status, code, details) => new AppError(message, status, code, details);
const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The two parties a person can work for. `field` is the id this collection stores; `model` is required lazily because
// the party models sit outside the CRM and requiring them at load time would make a new module's import graph deep.
const PARTIES = {
  customer: { field: "customerId", model: () => require("../../models/modules/customerModel"), label: "Customer" },
  vendor: { field: "vendorId", model: () => require("../../models/modules/vendorModel"), label: "Supplier" },
};

const partyOf = (kind) => PARTIES[String(kind || "").toLowerCase()] || null;

/** The five fields the party's embedded row carries; anything else is ours alone. */
const shared = (c) => ({
  ...(c?._id ? { _id: c._id } : {}),
  name: rules.text(c?.name, 100),
  designation: rules.text(c?.designation, 100),
  email: rules.text(c?.email, 120).toLowerCase(),
  phone: rules.text(c?.phone, 30),
  isPrimary: Boolean(c?.isPrimary),
});

class ContactService {
  static present(doc) {
    const c = doc?.toObject ? doc.toObject() : doc;
    if (!c) return null;
    const linked = c.customerId ? "customer" : c.vendorId ? "vendor" : null;
    return {
      ...c,
      partyKind: linked,
      partyId: linked ? String(c.customerId || c.vendorId) : null,
      // A person who belongs to nobody yet: captured from an enquiry, or entered ahead of the company record.
      unlinked: !linked,
      actions: { edit: true, delete: true, logActivity: true },
    };
  }

  /** The people, newest filters first. Capped like every other CRM list: 300, never a whole address book at once. */
  static async list(query = {}) {
    const q = {};
    if (rules.isId(query.customerId)) q.customerId = new mongoose.Types.ObjectId(rules.text(query.customerId, 24));
    if (rules.isId(query.vendorId)) q.vendorId = new mongoose.Types.ObjectId(rules.text(query.vendorId, 24));
    if (rules.isId(query.leadId)) q.leadId = new mongoose.Types.ObjectId(rules.text(query.leadId, 24));
    // "Nobody's yet" - the ones worth chasing into a real customer.
    if (rules.text(query.linked, 10) === "none") {
      q.customerId = null;
      q.vendorId = null;
    } else if (rules.text(query.linked, 10) === "customer") q.customerId = { $ne: null };
    else if (rules.text(query.linked, 10) === "vendor") q.vendorId = { $ne: null };

    const search = rules.text(query.search, 80);
    if (search) {
      const re = new RegExp(escape(search), "i");
      // How anybody actually looks for a person: the name they remember, or the number they have.
      q.$or = [{ name: re }, { email: re }, { phone: re }, { designation: re }];
    }

    const limit = Math.min(300, Math.max(1, Math.round(rules.num(query.limit) || 200)));
    const rows = await Contact.find(q).sort({ name: 1, _id: 1 }).limit(limit).lean();
    return rows.map((r) => this.present(r));
  }

  static async load(id, session) {
    if (!rules.isId(id)) throw fail("Contact not found", 404, "CONTACT_NOT_FOUND");
    const doc = await Contact.findById(rules.text(id, 24)).session(session || null);
    if (!doc) throw fail("Contact not found", 404, "CONTACT_NOT_FOUND");
    return doc;
  }

  /** One person: the facts, who they work for, and everything that has been said to them. */
  static async getById(id) {
    const doc = await this.load(id);
    const ActivityService = require("./activityService");
    const [timeline, party] = await Promise.all([
      ActivityService.timeline({ regardingId: doc._id, limit: 100 }),
      this.partyOfContact(doc),
    ]);
    return { ...this.present(doc), timeline, party };
  }

  static async partyOfContact(doc) {
    const kind = doc.customerId ? "customer" : doc.vendorId ? "vendor" : null;
    if (!kind) return null;
    const party = partyOf(kind);
    const row = await party
      .model()
      .findById(doc.customerId || doc.vendorId)
      .select("customerName vendorName customerId vendorId phone email")
      .lean();
    if (!row) return null;
    return { kind, id: String(row._id), name: row.customerName || row.vendorName || "", code: row.customerId || row.vendorId || "" };
  }

  // ---- the mirror ---------------------------------------------------------------------------------------------

  /**
   * Make this collection agree with a party's own `contacts[]`, which is the authoritative side. Called after every
   * party save (PartyMasterService.finish) and again whenever the CRM reads one party's people, so a row written by
   * some path nobody thought of still heals itself rather than quietly disagreeing for ever.
   *
   * Ids are the whole trick: the party's subdocument _id IS the Contact _id, so this is an upsert per row and a
   * delete of whatever the party no longer lists.
   */
  static async syncFromParty(party, kind, session) {
    const spec = partyOf(kind);
    if (!spec || !party?._id) return [];
    const { companyId } = getTenant();
    const rows = Array.isArray(party.contacts) ? party.contacts : [];
    const keep = [];

    for (const row of rows) {
      if (!row?._id) continue; // a row with no id cannot be mirrored: nothing to agree WITH
      keep.push(new mongoose.Types.ObjectId(String(row._id)));
      await Contact.updateOne(
        { _id: row._id },
        {
          $set: { ...shared(row), [spec.field]: party._id },
          $setOnInsert: { companyId, createdBy: "system" },
        },
        { upsert: true, session: session || undefined }
      );
    }
    // Gone from the party: gone from here. A person removed on the customer form must not linger in the CRM.
    await Contact.deleteMany({ [spec.field]: party._id, _id: { $nin: keep } }, { session: session || undefined });
    return keep;
  }

  /** One party's people, healed from the party's own array first so the two can never read differently. */
  static async forParty(kind, partyId) {
    const spec = partyOf(kind);
    if (!spec || !rules.isId(partyId)) return [];
    const party = await spec.model().findById(rules.text(partyId, 24)).select("contacts").lean();
    if (!party) return [];
    await this.syncFromParty(party, kind);
    return this.list({ [spec.field]: String(partyId), limit: 300 });
  }

  /**
   * Write a party's contact list THROUGH the party master, then mirror it back. The ids are re-attached by position
   * because `normalizeContacts` drops them, and they are minted by the caller, never by Mongoose, so the row we are
   * about to write here and the row the party stores are the same person.
   */
  static async writeParty(kind, partyId, next) {
    const spec = partyOf(kind);
    const Model = spec.model();
    const existing = await Model.findById(partyId).lean();
    if (!existing) throw fail(`${spec.label} not found`, 404, "PARTY_NOT_FOUND");

    // Only `contacts` is sent, so prepare() touches nothing else about the party (its VAT, terms, banks and
    // documents branches all test for their own key being present).
    // One primary at a time. `settlePrimary` in utils/partyMaster.js refuses two rather than guessing, so the choice
    // is made here: the row that asked for it wins and the others step down.
    // The row that asked last wins, which is the one just written: both create and update append it to the end.
    const last = next.map((r) => Boolean(r.isPrimary)).lastIndexOf(true);
    const rows = next.filter((r) => r.isPrimary).length > 1 ? next.map((r, i) => ({ ...r, isPrimary: i === last })) : next;

    const patch = await PartyMaster.prepare(kind, { contacts: rows.map(shared) }, { existing });
    patch.contacts = patch.contacts.map((row, i) => ({ ...row, _id: rows[i]._id }));

    const saved = await Model.findByIdAndUpdate(partyId, { $set: patch }, { new: true, runValidators: true });
    await this.syncFromParty(saved, kind);
    return saved;
  }

  // ---- writes -------------------------------------------------------------------------------------------------

  /** The party's current rows, ids kept, as the shape writeParty wants. */
  static async rowsOf(kind, partyId) {
    const spec = partyOf(kind);
    const party = await spec.model().findById(partyId).select("contacts").lean();
    return (party?.contacts || []).map((c) => ({ ...shared(c), _id: c._id }));
  }

  static linkOf(data) {
    if (rules.isId(data?.customerId)) return { kind: "customer", id: rules.text(data.customerId, 24) };
    if (rules.isId(data?.vendorId)) return { kind: "vendor", id: rules.text(data.vendorId, 24) };
    return null;
  }

  static async create(data = {}, by = "system") {
    const errors = rules.validateContact(data);
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });

    const { companyId } = getTenant();
    const link = this.linkOf(data);
    // Minted here, not by Mongoose: the party's row and ours must carry the same one.
    const _id = new mongoose.Types.ObjectId();
    const mine = {
      _id,
      ...shared(data),
      notes: rules.text(data.notes, 1000),
      leadId: rules.isId(data.leadId) ? new mongoose.Types.ObjectId(rules.text(data.leadId, 24)) : null,
      customerId: null,
      vendorId: null,
      companyId,
      createdBy: String(by || "system"),
    };

    if (!link) {
      const doc = await Contact.create(mine);
      return doc;
    }

    mine[partyOf(link.kind).field] = new mongoose.Types.ObjectId(link.id);
    const rows = await this.rowsOf(link.kind, link.id);
    await this.writeParty(link.kind, link.id, [...rows, { ...shared(data), _id }]);
    // syncFromParty wrote the shared fields; the CRM-only ones are ours to add.
    await Contact.updateOne({ _id }, { $set: { notes: mine.notes, leadId: mine.leadId, createdBy: mine.createdBy } });
    return this.load(_id);
  }

  static async update(id, data = {}, by = "system") {
    const doc = await this.load(id);
    const errors = rules.validateContact(data, { partial: true });
    if (errors.length) throw fail(errors[0].message, 400, errors[0].code, { errors });

    const was = doc.customerId ? { kind: "customer", id: String(doc.customerId) } : doc.vendorId ? { kind: "vendor", id: String(doc.vendorId) } : null;
    const asked = Object.prototype.hasOwnProperty.call(data, "customerId") || Object.prototype.hasOwnProperty.call(data, "vendorId");
    const now = asked ? this.linkOf(data) : was;
    const next = { ...shared({ ...shared(doc), ...data }), _id: doc._id };

    // Left a party: take the row out of its array first, or the person would be in two companies at once.
    if (was && (!now || now.id !== was.id)) {
      const rows = (await this.rowsOf(was.kind, was.id)).filter((r) => String(r._id) !== String(doc._id));
      await this.writeParty(was.kind, was.id, rows);
    }

    if (now) {
      const rows = await this.rowsOf(now.kind, now.id);
      const without = rows.filter((r) => String(r._id) !== String(doc._id));
      await this.writeParty(now.kind, now.id, [...without, next]);
    } else {
      await Contact.updateOne({ _id: doc._id }, { $set: { ...shared(next), customerId: null, vendorId: null } });
    }

    const mine = { updatedBy: String(by || "system") };
    if (Object.prototype.hasOwnProperty.call(data, "notes")) mine.notes = rules.text(data.notes, 1000);
    if (Object.prototype.hasOwnProperty.call(data, "leadId")) mine.leadId = rules.isId(data.leadId) ? new mongoose.Types.ObjectId(rules.text(data.leadId, 24)) : null;
    await Contact.updateOne({ _id: doc._id }, { $set: mine });
    return this.load(doc._id);
  }

  static async remove(id, by = "system") {
    const doc = await this.load(id);
    const link = doc.customerId ? { kind: "customer", id: String(doc.customerId) } : doc.vendorId ? { kind: "vendor", id: String(doc.vendorId) } : null;
    if (link) {
      // Taking it out of the party's array is what deletes it here, through syncFromParty.
      const rows = (await this.rowsOf(link.kind, link.id)).filter((r) => String(r._id) !== String(doc._id));
      await this.writeParty(link.kind, link.id, rows);
    } else {
      await Contact.deleteOne({ _id: doc._id });
    }
    // The calls and visits stay: what was said happened, whoever it was said to. They simply point at a person
    // who is no longer on the list, exactly as a deleted lead's history does.
    await CrmActivity.updateMany({ "regarding.kind": "contact", "regarding.id": doc._id }, { $set: { customerId: doc.customerId || null } });
    logger.debug(`[crm] contact ${doc._id} removed by ${by}`);
    return doc;
  }
}

module.exports = ContactService;
