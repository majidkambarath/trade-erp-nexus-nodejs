const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const RecurringInvoice = require("../../models/modules/recurringInvoiceModel");
const Customer = require("../../models/modules/customerModel");
const TransactionService = require("./transactionService");
const CostCentreService = require("../financial/costCentreService");
const AuditService = require("../core/auditService");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { getTenant } = require("../../utils/tenant");
const { runInBranchOf } = require("../../utils/tenantContext");
const { todayInOrg } = require("../../utils/documentExpiry");
const rules = require("../../utils/recurring");
const S = require("./salesDocumentSupport");

// Recurring invoices (utils/recurring.js for the dates). A template makes a DRAFT sales invoice on each scheduled day; it never
// approves, posts or sends. The run claims its slot with a compare-and-set in the SAME transaction that creates the draft, so a
// run repeated (two servers, a retry) makes one invoice, and a refusal (a closed month, the plan's document limit, an item since
// removed) makes none and moves nothing: the template waits on that day, with the reason, and is tried again later.

const fail = (message, status = 400, code) => new AppError(message, status, code);
const RETRY_HOURS = 6;
const KEEP_RUNS = 24;

const scheduleOf = (t) => ({ frequency: t.frequency, interval: t.interval, startDay: t.startDay, endDay: t.endDay || undefined, maxCount: t.maxCount || undefined });

function scheduleError(err) {
  if (err.code === "INVALID_SCHEDULE") return Object.assign(fail(err.message, 400, "INVALID_SCHEDULE"), { details: { field: err.field } });
  return err;
}

/** The lines to store: priced as a quotation is (on `day`), each keeping the cost centre it was given. */
async function priceLines(data, day, session) {
  const priced = await S.priceSalesDocument({ items: data.items, charges: data.charges, discount: data.discount, date: new Date(day) }, { session });
  const lines = priced.lines.map((l, i) => {
    const centre = data.items?.[i]?.costCentreId;
    return centre ? { ...l, costCentreId: centre } : l;
  });
  return { ...priced, lines };
}

async function checkCentres(data, keep = []) {
  const ids = [data.costCentreId, ...(data.items || []).map((l) => l?.costCentreId)].filter(Boolean);
  if (ids.length) await CostCentreService.assertUsable(ids, { keep });
}

const blank = (v) => v === undefined || v === null || v === "";

class RecurringInvoiceService {
  /** What a screen reads: the schedule in words, the next dates, the last invoice made. */
  static present(t) {
    const o = typeof t.toObject === "function" ? t.toObject() : t;
    const schedule = scheduleOf(o);
    const last = (o.runs || [])[o.runs?.length - 1] || null;
    return {
      ...o,
      describe: rules.describe(schedule),
      upcoming: o.status === "ACTIVE" ? rules.upcoming(schedule, o.cursor || 0, 3, o.made || 0) : [],
      lastRun: last,
    };
  }

  static async list(filters = {}) {
    const q = {};
    if (filters.status) q.status = String(filters.status);
    if (filters.partyId && mongoose.isValidObjectId(filters.partyId)) q.partyId = filters.partyId;
    const rows = await RecurringInvoice.find(q).sort({ status: 1, nextRunDay: 1, createdAt: -1 }).limit(500).lean();
    const parties = await Customer.find({ _id: { $in: [...new Set(rows.map((r) => String(r.partyId)))] } }).select("customerName customerId").lean();
    const byId = new Map(parties.map((p) => [String(p._id), p]));
    return rows.map((r) => ({ ...this.present(r), partyName: byId.get(String(r.partyId))?.customerName || "" }));
  }

  static async getById(id) {
    if (!mongoose.isValidObjectId(id)) throw fail("Recurring invoice not found", 404, "RECURRING_NOT_FOUND");
    const t = await RecurringInvoice.findById(id).lean();
    if (!t) throw fail("Recurring invoice not found", 404, "RECURRING_NOT_FOUND");
    const [party, items] = await Promise.all([Customer.findById(t.partyId).select(`${S.CUSTOMER_FIELDS}`).lean(), S.attachStockDetails(t.items)]);
    return { ...this.present({ ...t, items }), party, partyName: party?.customerName || "" };
  }

  /** The next dates a schedule gives, for the form (nothing stored). */
  static preview(query = {}) {
    try {
      const schedule = rules.validateSchedule(query);
      return { describe: rules.describe(schedule), upcoming: rules.upcoming(schedule, 0, Math.min(12, Number(query.n) || 3)) };
    } catch (err) {
      throw scheduleError(err);
    }
  }

  static create = withTransactionSession(async (data, by, session) => {
    const name = String(data?.name || "").trim();
    if (!name) throw fail("Give the recurring invoice a name", 400, "NAME_REQUIRED");
    await S.loadCustomer(data.partyId, { session });
    let schedule;
    try {
      schedule = rules.validateSchedule(data);
    } catch (err) {
      throw scheduleError(err);
    }
    await checkCentres(data);
    const priced = await priceLines(data, schedule.startDay, session);
    const nextRunDay = rules.nextRun(schedule, 0, 0);
    const { companyId, branchId } = getTenant();
    const [doc] = await RecurringInvoice.create(
      [{
        companyId, branchId, name, partyId: data.partyId,
        items: priced.lines, charges: priced.charges, discount: Number(data.discount) || 0, pricing: priced.pricing, totalAmount: priced.totalAmount,
        ...(blank(data.costCentreId) ? {} : { costCentreId: data.costCentreId }),
        notes: data.notes || "", terms: data.terms || "",
        ...schedule, cursor: 0, made: 0, nextRunDay, status: nextRunDay ? "ACTIVE" : "ENDED",
        createdBy: by, updatedBy: by,
      }],
      { session }
    );
    return doc;
  });

  static update = withTransactionSession(async (id, data, by, session) => {
    const doc = await RecurringInvoice.findById(id).session(session);
    if (!doc) throw fail("Recurring invoice not found", 404, "RECURRING_NOT_FOUND");
    if (data.name !== undefined) {
      const name = String(data.name || "").trim();
      if (!name) throw fail("Give the recurring invoice a name", 400, "NAME_REQUIRED");
      doc.name = name;
    }
    if (data.partyId && String(data.partyId) !== String(doc.partyId)) {
      await S.loadCustomer(data.partyId, { session });
      doc.partyId = data.partyId;
    }
    const keep = [doc.costCentreId, ...doc.items.map((l) => l.costCentreId)].filter(Boolean).map(String);
    await checkCentres(data, keep);
    if (data.costCentreId !== undefined) doc.costCentreId = blank(data.costCentreId) ? undefined : data.costCentreId;

    const scheduleTouched = ["frequency", "interval", "startDay", "endDay", "maxCount"].some((k) => data[k] !== undefined);
    if (scheduleTouched) {
      let schedule;
      try {
        schedule = rules.validateSchedule({ ...scheduleOf(doc), ...data });
      } catch (err) {
        throw scheduleError(err);
      }
      Object.assign(doc, { frequency: schedule.frequency, interval: schedule.interval, startDay: schedule.startDay, endDay: schedule.endDay, maxCount: schedule.maxCount });
      // carry on after the last invoice made, never make a date again
      const lastDay = doc.runs.length ? doc.runs[doc.runs.length - 1].day : null;
      doc.cursor = rules.cursorAfter(schedule, lastDay);
      doc.nextRunDay = rules.nextRun(schedule, doc.cursor, doc.made);
      if (!doc.nextRunDay) doc.status = "ENDED";
      else if (doc.status === "ENDED") doc.status = "ACTIVE";
      doc.lastError = undefined;
      doc.retryAfter = null;
    }
    if (data.items || data.charges !== undefined || data.discount !== undefined) {
      const priced = await priceLines(
        {
          items: data.items || doc.items.map((l) => ({ ...S.toPricingInput(l.toObject()), costCentreId: l.costCentreId })),
          charges: data.charges ?? doc.charges.map((c) => c.toObject()),
          discount: data.discount ?? doc.discount,
        },
        doc.nextRunDay || doc.startDay,
        session
      );
      doc.items = priced.lines;
      doc.charges = priced.charges;
      doc.pricing = priced.pricing;
      doc.totalAmount = priced.totalAmount;
      doc.discount = Number(data.discount ?? doc.discount) || 0;
      // a refused run may succeed now (an item replaced): try again at once
      doc.retryAfter = null;
    }
    for (const k of ["notes", "terms"]) if (data[k] !== undefined) doc[k] = data[k] || "";
    doc.updatedBy = by;
    await doc.save({ session });
    return doc;
  });

  static async pause(id, by) {
    const doc = await RecurringInvoice.findOneAndUpdate({ _id: id, status: "ACTIVE" }, { $set: { status: "PAUSED", updatedBy: by } }, { new: true });
    if (doc) return doc;
    return this.refuseState(id, "pause");
  }

  /** Carries on from the first scheduled day on or after today; the days the pause skipped are not invoiced. */
  static async resume(id, by) {
    const doc = await RecurringInvoice.findById(id);
    if (!doc) throw fail("Recurring invoice not found", 404, "RECURRING_NOT_FOUND");
    if (doc.status !== "PAUSED") return this.refuseState(id, "resume");
    const schedule = scheduleOf(doc);
    const k = rules.resumeFrom(schedule, doc.cursor, todayInOrg(), doc.made);
    doc.cursor = k ?? doc.cursor;
    doc.nextRunDay = k === null ? null : rules.runDay(schedule, k);
    doc.status = k === null ? "ENDED" : "ACTIVE";
    doc.lastError = undefined;
    doc.retryAfter = null;
    doc.updatedBy = by;
    await doc.save();
    return doc;
  }

  static async refuseState(id, action) {
    const doc = await RecurringInvoice.findById(id).lean();
    if (!doc) throw fail("Recurring invoice not found", 404, "RECURRING_NOT_FOUND");
    if (doc.status === "ENDED") throw fail(`${doc.name} has finished: no more invoices are due`, 409, "RECURRING_ENDED");
    throw fail(`${doc.name} is ${doc.status === "PAUSED" ? "paused" : "running"}: it cannot be ${action === "pause" ? "paused" : "resumed"}`, 409, "RECURRING_STATE");
  }

  static async remove(id) {
    const doc = await RecurringInvoice.findByIdAndDelete(id).lean();
    if (!doc) throw fail("Recurring invoice not found", 404, "RECURRING_NOT_FOUND");
    return doc; // the drafts it made stay: they are invoices in their own right
  }

  /**
   * Make the invoice for one slot. Returns { made: true, invoice } or { made: false } when somebody else made it first.
   * Throws a refusal from the invoice itself (the period lock, the plan limit...), with nothing written.
   */
  static runSlot = withTransactionSession(async (id, k, by, session) => {
    const t = await RecurringInvoice.findById(id).session(session);
    if (!t || t.status !== "ACTIVE" || t.cursor !== k) return { made: false };
    const schedule = scheduleOf(t);
    if (!rules.withinSchedule(schedule, k, t.made)) return { made: false };
    const day = rules.runDay(schedule, k);
    const nextRunDay = rules.nextRun(schedule, k + 1, t.made + 1);
    // the claim: only one run moves the cursor past k
    const claimed = await RecurringInvoice.updateOne(
      { _id: t._id, cursor: k, made: t.made, status: "ACTIVE" },
      { $set: { cursor: k + 1, made: t.made + 1, nextRunDay, status: nextRunDay ? "ACTIVE" : "ENDED", retryAfter: null }, $unset: { lastError: 1 } },
      { session }
    );
    if (claimed.modifiedCount !== 1) return { made: false };

    const invoice = await runInBranchOf(t, () =>
      TransactionService.createTransaction(
        {
          type: "sales_order",
          partyId: t.partyId,
          partyType: "Customer",
          date: new Date(day),
          status: "DRAFT",
          items: t.items.map((l) => {
            const line = l.toObject();
            return { ...S.toPricingInput(line), ...(line.costCentreId ? { costCentreId: line.costCentreId } : {}) };
          }),
          charges: t.charges.map((c) => c.toObject()),
          discount: t.discount,
          ...(t.costCentreId ? { costCentreId: t.costCentreId } : {}),
          terms: t.terms,
          notes: `Recurring: ${t.name}${t.notes ? `. ${t.notes}` : ""}`,
          recurringRef: { id: t._id, name: t.name },
        },
        by,
        session
      )
    );
    await RecurringInvoice.updateOne(
      { _id: t._id },
      { $push: { runs: { $each: [{ day, transactionId: invoice._id, transactionNo: invoice.transactionNo, at: new Date() }], $slice: -KEEP_RUNS } } },
      { session }
    );
    return { made: true, invoice, day };
  });

  /** Records why a run could not be made, and when to try again. */
  static async recordFailure(t, day, err, now = new Date()) {
    await RecurringInvoice.updateOne(
      { _id: t._id },
      { $set: { lastError: { day, message: String(err?.message || err).slice(0, 500), at: now }, retryAfter: new Date(now.getTime() + RETRY_HOURS * 3600000) } }
    );
  }

  /** "Make the next one now": the next scheduled invoice, made today rather than on its day (it keeps its scheduled date). */
  static async runNow(id, by) {
    const t = await RecurringInvoice.findById(id).lean();
    if (!t) throw fail("Recurring invoice not found", 404, "RECURRING_NOT_FOUND");
    if (t.status !== "ACTIVE") return this.refuseState(id, "run");
    const day = rules.runDay(scheduleOf(t), t.cursor);
    try {
      const out = await this.runSlot(String(t._id), t.cursor, by);
      if (!out.made) throw fail("That invoice was just made by someone else", 409, "RECURRING_STATE");
      await AuditService.log({ action: "RECURRING_INVOICE_RUN", entity: "RecurringInvoice", entityId: t._id, summary: `${t.name}: draft ${out.invoice.transactionNo} made for ${day}` });
      return out;
    } catch (err) {
      if (err?.code !== "RECURRING_STATE") await this.recordFailure(t, day, err);
      throw err;
    }
  }

  /**
   * The background pass for the organisation in scope: every running template whose day has come, in every branch, up to 12
   * missed runs each (each dated its own day). One failing never stops the others.
   */
  static async runDue(now = new Date()) {
    const today = todayInOrg(now);
    const due = await RecurringInvoice.find({
      status: "ACTIVE", nextRunDay: { $ne: null, $lte: today },
      $or: [{ retryAfter: null }, { retryAfter: { $exists: false } }, { retryAfter: { $lte: now } }],
    }).limit(200).lean();
    const out = { checked: due.length, made: 0, failed: 0 };
    for (const t of due) {
      for (const slot of rules.dueRuns(scheduleOf(t), t.cursor, today, 12, t.made)) {
        try {
          const r = await this.runSlot(String(t._id), slot.k, "system");
          if (!r.made) break;
          out.made += 1;
          await AuditService.log({ action: "RECURRING_INVOICE_RUN", entity: "RecurringInvoice", entityId: t._id, summary: `${t.name}: draft ${r.invoice.transactionNo} made for ${slot.day}` });
        } catch (err) {
          out.failed += 1;
          await this.recordFailure(t, slot.day, err, now);
          break;
        }
      }
    }
    return out;
  }
}

module.exports = RecurringInvoiceService;
