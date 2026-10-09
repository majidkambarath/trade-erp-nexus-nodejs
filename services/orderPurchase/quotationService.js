const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const Quotation = require("../../models/modules/quotationModel");
const Customer = require("../../models/modules/customerModel");
const NumberSeriesService = require("../core/numberSeriesService");
const TransactionService = require("./transactionService");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { getTenant } = require("../../utils/tenant");
const { todayInOrg } = require("../../utils/documentExpiry");
const {
  QUOTATION_ACTIONS, QUOTATION_CONVERTIBLE, QUOTATION_REVISABLE, QUOTATION_EDITABLE,
  quotationExpiry, defaultValidUntil, revisionNumber,
} = require("../../utils/salesDocuments");
const S = require("./salesDocumentSupport");

// A quotation is an offer. It posts nothing and moves no stock; when the customer accepts, it is
// converted into a DRAFT sales order (the invoice), priced by the same code at that day's tax rates.
//
// Lifecycle:  DRAFT -> SENT -> ACCEPTED -> CONVERTED        SENT / ACCEPTED -> REJECTED
//             SENT | ACCEPTED | REJECTED -> (revise) -> SUPERSEDED, and a new DRAFT revision
// A SENT quotation past its validity is reported as EXPIRED; that is read from the date, never stored,
// so no job has to run for it to be true.

const fail = (message, status, code) => new AppError(message, status, code);

// What a screen needs to know about one quotation, decided here so the rules live in one place.
function present(q, now = new Date()) {
  const expiry = quotationExpiry(q, now);
  return {
    ...q,
    expired: expiry.expired,
    daysLeft: expiry.daysLeft,
    displayStatus: expiry.expired ? "EXPIRED" : q.status,
    actions: {
      edit: QUOTATION_EDITABLE.includes(q.status),
      delete: q.status === "DRAFT",
      send: QUOTATION_ACTIONS.send.from.includes(q.status),
      accept: QUOTATION_ACTIONS.accept.from.includes(q.status) && !expiry.expired,
      reject: QUOTATION_ACTIONS.reject.from.includes(q.status),
      convert: QUOTATION_CONVERTIBLE.includes(q.status) && !expiry.expired,
      revise: QUOTATION_REVISABLE.includes(q.status),
    },
  };
}

const todayDate = (now = new Date()) => new Date(todayInOrg(now));

class QuotationService {
  // ---- reading -----------------------------------------------------------------------------

  static async list(filters = {}) {
    const { companyId } = getTenant();
    const q = { companyId };
    const today = todayDate();

    // EXPIRED is not stored: a SENT quotation whose last valid day has passed. SENT means still open.
    if (filters.status === "EXPIRED") Object.assign(q, { status: "SENT", validUntil: { $lt: today } });
    else if (filters.status === "SENT") Object.assign(q, { status: "SENT", validUntil: { $gte: today } });
    else if (filters.status) q.status = String(filters.status);

    if (filters.partyId) {
      if (!S.isId(filters.partyId)) throw fail("Invalid customer", 400);
      q.partyId = new mongoose.Types.ObjectId(filters.partyId);
    }
    const dateFrom = S.dayToDate(filters.dateFrom);
    const dateTo = S.dayToDate(filters.dateTo);
    if (dateFrom || dateTo) q.date = { ...(dateFrom && { $gte: dateFrom }), ...(dateTo && { $lte: new Date(dateTo.getTime() + 86399999) }) };

    if (filters.search) {
      const r = new RegExp(S.escapeRegex(filters.search), "i");
      const parties = await Customer.find({ $or: [{ customerName: r }, { customerId: r }] }).select("_id").limit(200).lean();
      q.$or = [{ quotationNo: r }, { reference: r }, { notes: r }, { "items.description": r }, { partyId: { $in: parties.map((p) => p._id) } }];
    }

    const { page, limit, skip } = S.pageOf(filters);
    const [rows, total] = await Promise.all([
      Quotation.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Quotation.countDocuments(q),
    ]);
    const parties = await Customer.find({ _id: { $in: rows.map((r) => r.partyId) } }).select("customerId customerName").lean();
    const byId = new Map(parties.map((p) => [String(p._id), p]));
    return {
      rows: rows.map((r) => ({ ...present(r), party: byId.get(String(r.partyId)) || null })),
      pagination: { current: page, pages: Math.ceil(total / limit), total, limit },
    };
  }

  // Counts and values by what the screen shows (EXPIRED split out of SENT), for the tiles and tabs.
  static async summary() {
    const { companyId } = getTenant();
    const today = todayDate();
    const rows = await Quotation.aggregate([
      { $match: { companyId } },
      {
        $group: {
          _id: { $cond: [{ $and: [{ $eq: ["$status", "SENT"] }, { $lt: ["$validUntil", today] }] }, "EXPIRED", "$status"] },
          count: { $sum: 1 },
          value: { $sum: "$totalAmount" },
        },
      },
    ]);
    const by = Object.fromEntries(rows.map((r) => [r._id, { count: r.count, value: Math.round(r.value * 100) / 100 }]));
    const get = (k) => by[k] || { count: 0, value: 0 };
    // Of the offers that reached a verdict, how many won. Drafts, open and superseded ones have no verdict yet.
    const won = get("ACCEPTED").count + get("CONVERTED").count;
    const decided = won + get("REJECTED").count + get("EXPIRED").count;
    // Offers still open that run out within a week: the ones worth a call today.
    const [soon] = await Quotation.aggregate([
      { $match: { companyId, status: "SENT", validUntil: { $gte: today, $lte: new Date(today.getTime() + 7 * 86400000) } } },
      { $group: { _id: null, count: { $sum: 1 }, value: { $sum: "$totalAmount" } } },
    ]);
    return {
      byStatus: by,
      total: rows.reduce((t, r) => t + r.count, 0),
      winRate: decided ? Math.round((won / decided) * 1000) / 10 : null,
      expiringSoon: { count: soon?.count || 0, value: Math.round((soon?.value || 0) * 100) / 100 },
    };
  }

  static async getById(id) {
    if (!S.isId(id)) throw fail("Invalid quotation id", 400);
    const q = await Quotation.findById(id).lean();
    if (!q) throw fail("Quotation not found", 404, "QUOTATION_NOT_FOUND");
    const [party, items] = await Promise.all([Customer.findById(q.partyId).select(S.CUSTOMER_FIELDS).lean(), S.attachStockDetails(q.items)]);
    return { ...present({ ...q, items }), party };
  }

  // ---- writing -----------------------------------------------------------------------------

  static create = withTransactionSession(async (data, createdBy, session) => {
    await S.loadCustomer(data.partyId, { session });
    const date = S.dayToDate(data.date) || new Date(todayInOrg());
    const validUntil = S.dayToDate(data.validUntil) || new Date(defaultValidUntil(todayInOrg(date)));
    if (validUntil < date) throw fail("The quotation cannot be valid for a period that ends before its date", 400, "INVALID_VALIDITY");
    const priced = await S.priceDocument({ items: data.items, charges: data.charges, discount: data.discount, date }, { session });

    const { companyId, branchId } = getTenant();
    const quotationNo = await NumberSeriesService.allocate("QT", date, { session });
    const [doc] = await Quotation.create(
      [{
        companyId, branchId, quotationNo, revision: 0,
        partyId: data.partyId, date, validUntil, reference: data.reference || "",
        status: "DRAFT",
        items: priced.lines, charges: priced.charges, discount: Number(data.discount) || 0,
        pricing: priced.pricing, totalAmount: priced.totalAmount,
        terms: data.terms || "", notes: data.notes || "", createdBy,
      }],
      { session }
    );
    return doc;
  });

  // Only a draft can be edited: once an offer has gone out it is changed by revising it, which keeps
  // what the customer was actually quoted.
  static update = withTransactionSession(async (id, data, createdBy, session) => {
    const doc = await Quotation.findById(id).session(session);
    if (!doc) throw fail("Quotation not found", 404, "QUOTATION_NOT_FOUND");
    if (!QUOTATION_EDITABLE.includes(doc.status)) {
      throw fail(`${doc.quotationNo} has been ${doc.status === "SENT" ? "sent" : doc.status.toLowerCase()}. Revise it to change what was offered.`, 409, "QUOTATION_NOT_EDITABLE");
    }
    if (data.partyId && String(data.partyId) !== String(doc.partyId)) {
      await S.loadCustomer(data.partyId, { session });
      doc.partyId = data.partyId;
    }
    const date = data.date ? S.dayToDate(data.date) : doc.date;
    const validUntil = data.validUntil ? S.dayToDate(data.validUntil) : doc.validUntil;
    if (!date || !validUntil) throw fail("Enter a valid date and validity", 400, "INVALID_DATE");
    if (validUntil < date) throw fail("The quotation cannot be valid for a period that ends before its date", 400, "INVALID_VALIDITY");

    const repriceable = data.items || data.charges !== undefined || data.discount !== undefined || data.date;
    if (repriceable) {
      const priced = await S.priceDocument(
        {
          items: data.items || doc.items.map((l) => S.toPricingInput(l.toObject())),
          charges: data.charges ?? doc.charges.map((c) => c.toObject()),
          discount: data.discount ?? doc.discount,
          date,
        },
        { session }
      );
      doc.items = priced.lines;
      doc.charges = priced.charges;
      doc.pricing = priced.pricing;
      doc.totalAmount = priced.totalAmount;
      doc.discount = Number(data.discount ?? doc.discount) || 0;
    }
    doc.date = date;
    doc.validUntil = validUntil;
    for (const k of ["reference", "terms", "notes"]) if (data[k] !== undefined) doc[k] = data[k] || "";
    await doc.save({ session });
    return doc;
  });

  static remove = withTransactionSession(async (id, createdBy, session) => {
    const doc = await Quotation.findById(id).session(session);
    if (!doc) throw fail("Quotation not found", 404, "QUOTATION_NOT_FOUND");
    if (doc.status !== "DRAFT") throw fail(`${doc.quotationNo} has been ${doc.status.toLowerCase()} and cannot be deleted`, 409, "QUOTATION_NOT_DELETABLE");

    // A discarded revision puts the offer it replaced back as it was.
    if (doc.revisionOf?.id) {
      await Quotation.updateOne(
        { _id: doc.revisionOf.id, status: "SUPERSEDED", "supersededBy.id": doc._id },
        { $set: { status: doc.statusBeforeSupersede || "SENT" }, $unset: { supersededBy: 1, statusBeforeSupersede: 1 } },
        { session }
      );
    }
    await Quotation.deleteOne({ _id: doc._id }, { session });
    return { quotationNo: doc.quotationNo, status: doc.status, totalAmount: doc.totalAmount };
  });

  // ---- the customer's answer ----------------------------------------------------------------

  static transition = withTransactionSession(async (id, action, input, createdBy, session) => {
    const rule = QUOTATION_ACTIONS[action];
    if (!rule) throw fail(`Unknown action '${action}'`, 400, "INVALID_ACTION");
    const doc = await Quotation.findById(id).session(session);
    if (!doc) throw fail("Quotation not found", 404, "QUOTATION_NOT_FOUND");
    if (!rule.from.includes(doc.status)) {
      throw fail(`${doc.quotationNo} is ${doc.status.toLowerCase()}; it cannot be ${action === "send" ? "sent" : action + "ed"} from there`, 409, "QUOTATION_STATE");
    }
    const now = new Date();
    const expiry = quotationExpiry(doc, now);
    if (action === "send") {
      if (!doc.items.length) throw fail("A quotation with no items cannot be sent", 400, "ITEMS_REQUIRED");
      if (expiry.daysLeft !== null && expiry.daysLeft < 0) throw fail("Its validity has already passed. Change the 'valid until' date first.", 409, "QUOTATION_EXPIRED");
      doc.sentAt = now;
    }
    if (action === "accept") {
      if (expiry.expired) throw fail(`${doc.quotationNo} expired on ${expiry.validDay}. Revise it to offer it again.`, 409, "QUOTATION_EXPIRED");
      doc.acceptedAt = now;
      doc.acceptedBy = String(input?.acceptedBy || "").trim();
    }
    if (action === "reject") {
      doc.rejectedAt = now;
      doc.rejectionReason = String(input?.reason || "").trim();
    }
    doc.status = rule.to;
    await doc.save({ session });
    return doc;
  });

  // Revise: a new draft with the same lines, priced again at today's rates and valid from today.
  // The offer it replaces is marked SUPERSEDED at once so only one version can be accepted; if the
  // revision is discarded, the original is put back (see remove).
  static revise = withTransactionSession(async (id, createdBy, session) => {
    const old = await Quotation.findById(id).session(session);
    if (!old) throw fail("Quotation not found", 404, "QUOTATION_NOT_FOUND");
    if (!QUOTATION_REVISABLE.includes(old.status)) {
      throw fail(`${old.quotationNo} is ${old.status.toLowerCase()} and cannot be revised`, 409, "QUOTATION_STATE");
    }
    const today = todayInOrg();
    const date = new Date(today);
    const priced = await S.priceDocument(
      {
        items: old.items.map((l) => S.toPricingInput(l.toObject())),
        charges: old.charges.map((c) => c.toObject()),
        discount: old.discount,
        date,
      },
      { session }
    );
    const revision = old.revision + 1;
    const { companyId, branchId } = getTenant();
    const [next] = await Quotation.create(
      [{
        companyId, branchId, quotationNo: revisionNumber(old.quotationNo, revision), revision,
        revisionOf: { kind: "quotation", id: old._id, no: old.quotationNo },
        partyId: old.partyId, date, validUntil: new Date(defaultValidUntil(today)), reference: old.reference,
        status: "DRAFT",
        items: priced.lines, charges: priced.charges, discount: old.discount, pricing: priced.pricing, totalAmount: priced.totalAmount,
        terms: old.terms, notes: old.notes, createdBy,
      }],
      { session }
    );
    old.statusBeforeSupersede = old.status;
    old.status = "SUPERSEDED";
    old.supersededBy = { kind: "quotation", id: next._id, no: next.quotationNo };
    await old.save({ session });
    return { revision: next, superseded: old };
  });

  // ---- becoming an invoice -------------------------------------------------------------------

  // The customer ordered: raise the sales order (a DRAFT invoice) in the same transaction, so there
  // is never an accepted quotation with half an order behind it, or an order with the offer still open.
  // The order is priced afresh on its own date, so it follows the tax rate in force then; the lines,
  // prices and discounts are the offer's.
  static convertToSalesOrder = withTransactionSession(async (id, input, createdBy, session) => {
    const doc = await Quotation.findById(id).session(session);
    if (!doc) throw fail("Quotation not found", 404, "QUOTATION_NOT_FOUND");
    if (!QUOTATION_CONVERTIBLE.includes(doc.status)) {
      const why = doc.status === "CONVERTED" ? `already became ${doc.convertedTo?.no || "an order"}` : `is ${doc.status.toLowerCase()}`;
      throw fail(`${doc.quotationNo} ${why}`, 409, "QUOTATION_STATE");
    }
    const expiry = quotationExpiry(doc);
    if (expiry.expired) throw fail(`${doc.quotationNo} expired on ${expiry.validDay}. Revise it to offer it again.`, 409, "QUOTATION_EXPIRED");

    const date = input?.date ? S.dayToDate(input.date) : new Date(todayInOrg());
    if (!date) throw fail("Enter a valid date", 400, "INVALID_DATE");

    const salesOrder = await TransactionService.createTransaction(
      {
        type: "sales_order",
        partyId: doc.partyId,
        partyType: "Customer",
        date,
        items: doc.items.map((l) => S.toPricingInput(l.toObject())),
        charges: doc.charges.map((c) => c.toObject()),
        discount: doc.discount,
        terms: doc.terms,
        notes: `From quotation ${doc.quotationNo}${doc.notes ? `. ${doc.notes}` : ""}`,
        lpono: doc.reference || null,
        quoteRef: doc.quotationNo,
        status: "DRAFT",
      },
      createdBy,
      session
    );

    doc.status = "CONVERTED";
    doc.convertedTo = { kind: "sales_order", id: salesOrder._id, no: salesOrder.transactionNo };
    doc.convertedAt = new Date();
    if (!doc.acceptedAt) {
      // ordering is accepting, whether or not anyone pressed Accept first
      doc.acceptedAt = doc.convertedAt;
      doc.acceptedBy = doc.acceptedBy || String(input?.acceptedBy || "").trim();
    }
    await doc.save({ session });
    return { quotation: doc, salesOrder };
  });
}

QuotationService.present = present;

module.exports = QuotationService;
