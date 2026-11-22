const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const RecurringVoucher = require("../../models/modules/financial/recurringVoucherModel");
const { Voucher, LedgerAccount } = require("../../models/modules/financial/financialModels");
const Admin = require("../../models/core/adminModel");
const FinancialService = require("./financialService");
const LedgerVoucherService = require("./ledgerVoucherService");
const CostCentreService = require("./costCentreService");
const AuditService = require("../core/auditService");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { getTenant } = require("../../utils/tenant");
const { runInBranchOf } = require("../../utils/tenantContext");
const { todayInOrg } = require("../../utils/documentExpiry");
const rules = require("../../utils/recurring");

// Recurring journal and expense vouchers (utils/recurring.js for the dates). A template makes a PENDING voucher on each scheduled day:
// numbered, dated that day and audited like any voucher, but posting NOTHING until a person approves it (FinancialService.createVoucher
// with `holdFor: "recurring"`). The run claims its slot with a compare-and-set in the SAME transaction that makes the voucher, so a run
// repeated (two servers, a retry) makes one voucher, and a refusal (a closed month, an account switched off, the owner removed) makes
// none and moves nothing: the template waits on that day, with the reason, and is tried again later.

const fail = (message, status = 400, code) => new AppError(message, status, code);
const RETRY_HOURS = 6;
const KEEP_RUNS = 24;
const KINDS = ["journal", "expense"];
const MODES = ["cash", "bank"];
const NOUN = "voucher";

const scheduleOf = (t) => ({ frequency: t.frequency, interval: t.interval, startDay: t.startDay, endDay: t.endDay || undefined, maxCount: t.maxCount || undefined });
const blank = (v) => v === undefined || v === null || v === "";
const num = (v) => (blank(v) ? 0 : Number(v));
const text = (v, max) => String(v ?? "").trim().slice(0, max);

function scheduleError(err) {
  if (err.code === "INVALID_SCHEDULE") return Object.assign(fail(err.message, 400, "INVALID_SCHEDULE"), { details: { field: err.field } });
  return err;
}

/** The voucher body a run hands to createVoucher, dated the slot's day. */
function bodyFor(t, day) {
  const base = { date: new Date(day), ...(t.costCentreId ? { costCentreId: t.costCentreId } : {}) };
  const narration = `Recurring: ${t.name}${t.narration ? `. ${t.narration}` : ""}`;
  if (t.kind === "journal") {
    return {
      ...base, voucherType: "journal", narration,
      lines: (t.lines || []).map((l) => ({ accountId: l.accountId, debit: l.debit || 0, credit: l.credit || 0, narration: l.narration || undefined, ...(l.costCentreId ? { costCentreId: l.costCentreId } : {}) })),
    };
  }
  return {
    ...base, voucherType: "expense", ledgerBased: true, narration, description: t.description, amount: t.amount,
    expenseAccountId: t.expenseAccountId, ...(t.taxCodeId ? { taxCodeId: t.taxCodeId } : {}), ...(t.vendorId ? { vendorId: t.vendorId } : {}), ...(t.partyName ? { partyName: t.partyName } : {}),
    paymentMode: t.paymentMode,
    paymentDetails: { ...(t.paymentAccountId ? { accountId: t.paymentAccountId } : {}), ...(t.paymentReference ? { reference: t.paymentReference } : {}) },
  };
}

/** What a template stores, cleaned and checked by the processors a real save uses (so a template that could never post is refused now). */
async function payloadOf(data, kind, session) {
  const out = { narration: text(data.narration, 500) };
  if (!blank(data.costCentreId)) out.costCentreId = data.costCentreId;
  if (kind === "journal") {
    const lines = (Array.isArray(data.lines) ? data.lines : [])
      .map((l) => ({ accountId: l?.accountId, debit: num(l?.debit), credit: num(l?.credit), narration: text(l?.narration, 300), costCentreId: blank(l?.costCentreId) ? undefined : l.costCentreId }))
      .filter((l) => l.accountId || l.debit || l.credit);
    const checked = await LedgerVoucherService.processJournal({ date: new Date(), narration: out.narration, lines }, session);
    return { ...out, lines: lines.map((l) => ({ ...l, narration: l.narration || undefined })), totalAmount: checked.totalAmount };
  }
  const mode = text(data.paymentMode || "cash", 20);
  if (!MODES.includes(mode)) throw fail("A recurring expense is paid in cash or from a bank account: a transfer needs a reference and a cheque a number, which change every time.", 400, "RECURRING_PAYMENT_MODE");
  const expense = {
    expenseAccountId: data.expenseAccountId, description: text(data.description, 300), amount: num(data.amount),
    ...(blank(data.taxCodeId) ? {} : { taxCodeId: data.taxCodeId }), ...(blank(data.vendorId) ? {} : { vendorId: data.vendorId }), partyName: text(data.partyName, 150) || undefined,
    paymentMode: mode, paymentAccountId: blank(data.paymentAccountId) ? undefined : data.paymentAccountId, paymentReference: text(data.paymentReference, 100) || undefined,
  };
  // the same processor a save uses: the account, the tax code (reverse charge is refused), the payment account
  await LedgerVoucherService.processExpense(
    { ...expense, date: new Date(), narration: out.narration, ledgerBased: true, paymentDetails: { accountId: expense.paymentAccountId, reference: expense.paymentReference } },
    session, { PaymentModeService: require("../banking/paymentModeService") }
  );
  return { ...out, ...expense, totalAmount: expense.amount };
}

async function checkCentres(data, keep = []) {
  const ids = [data.costCentreId, ...(Array.isArray(data.lines) ? data.lines.map((l) => l?.costCentreId) : [])].filter((x) => !blank(x));
  if (ids.length) await CostCentreService.assertUsable(ids, { keep });
}

class RecurringVoucherService {
  /** What a screen reads: the schedule in words, the next dates, the last voucher made. */
  static present(t) {
    const o = typeof t.toObject === "function" ? t.toObject() : t;
    const schedule = scheduleOf(o);
    const last = (o.runs || [])[o.runs?.length - 1] || null;
    return { ...o, describe: rules.describe(schedule), upcoming: o.status === "ACTIVE" ? rules.upcoming(schedule, o.cursor || 0, 3, o.made || 0) : [], lastRun: last };
  }

  static async list(filters = {}) {
    const q = {};
    if (filters.status) q.status = String(filters.status);
    if (KINDS.includes(filters.kind)) q.kind = filters.kind;
    const rows = await RecurringVoucher.find(q).sort({ status: 1, nextRunDay: 1, createdAt: -1 }).limit(500).lean();
    const ids = [...new Set(rows.flatMap((r) => [r.expenseAccountId, r.paymentAccountId]).filter(Boolean).map(String))];
    const accounts = ids.length ? await LedgerAccount.find({ _id: { $in: ids } }).select("accountName").lean() : [];
    const names = new Map(accounts.map((a) => [String(a._id), a.accountName]));
    return rows.map((r) => ({ ...this.present(r), accountName: r.expenseAccountId ? names.get(String(r.expenseAccountId)) || "" : "", lineCount: r.lines?.length || 0 }));
  }

  static async getById(id) {
    if (!mongoose.isValidObjectId(id)) throw fail("Recurring voucher not found", 404, "RECURRING_NOT_FOUND");
    const t = await RecurringVoucher.findById(id).lean();
    if (!t) throw fail("Recurring voucher not found", 404, "RECURRING_NOT_FOUND");
    return this.present(t);
  }

  /** The next dates a schedule gives, for the form (nothing stored). */
  static preview(query = {}) {
    try {
      const schedule = rules.validateSchedule(query, NOUN);
      return { describe: rules.describe(schedule), upcoming: rules.upcoming(schedule, 0, Math.min(12, Number(query.n) || 3)) };
    } catch (err) {
      throw scheduleError(err);
    }
  }

  static create = withTransactionSession(async (data, by, session) => {
    const name = text(data?.name, 100);
    if (!name) throw fail("Give the recurring voucher a name", 400, "NAME_REQUIRED");
    if (!KINDS.includes(data?.kind)) throw fail("Choose a journal or an expense", 400, "INVALID_KIND");
    if (!mongoose.isValidObjectId(by)) throw fail("A recurring voucher is made by a signed-in person", 400, "OWNER_REQUIRED");
    let schedule;
    try {
      schedule = rules.validateSchedule(data, NOUN);
    } catch (err) {
      throw scheduleError(err);
    }
    await checkCentres(data);
    const payload = await payloadOf(data, data.kind, session);
    const nextRunDay = rules.nextRun(schedule, 0, 0);
    const { companyId, branchId } = getTenant();
    const [doc] = await RecurringVoucher.create(
      [{ companyId, branchId, name, kind: data.kind, ownerId: by, ...payload, ...schedule, cursor: 0, made: 0, nextRunDay, status: nextRunDay ? "ACTIVE" : "ENDED", createdBy: String(by), updatedBy: String(by) }],
      { session }
    );
    return doc;
  });

  static update = withTransactionSession(async (id, data, by, session) => {
    const doc = await RecurringVoucher.findById(id).session(session);
    if (!doc) throw fail("Recurring voucher not found", 404, "RECURRING_NOT_FOUND");
    if (data.name !== undefined) {
      const name = text(data.name, 100);
      if (!name) throw fail("Give the recurring voucher a name", 400, "NAME_REQUIRED");
      doc.name = name;
    }
    const keep = [doc.costCentreId, ...(doc.lines || []).map((l) => l.costCentreId)].filter(Boolean).map(String);
    await checkCentres(data, keep);

    const scheduleTouched = ["frequency", "interval", "startDay", "endDay", "maxCount"].some((k) => data[k] !== undefined);
    if (scheduleTouched) {
      let schedule;
      try {
        schedule = rules.validateSchedule({ ...scheduleOf(doc), ...data }, NOUN);
      } catch (err) {
        throw scheduleError(err);
      }
      Object.assign(doc, { frequency: schedule.frequency, interval: schedule.interval, startDay: schedule.startDay, endDay: schedule.endDay, maxCount: schedule.maxCount });
      // carry on after the last voucher made, never make a date again
      const lastDay = doc.runs.length ? doc.runs[doc.runs.length - 1].day : null;
      doc.cursor = rules.cursorAfter(schedule, lastDay);
      doc.nextRunDay = rules.nextRun(schedule, doc.cursor, doc.made);
      if (!doc.nextRunDay) doc.status = "ENDED";
      else if (doc.status === "ENDED") doc.status = "ACTIVE";
      doc.lastError = undefined;
      doc.retryAfter = null;
    }
    const payloadKeys = doc.kind === "journal" ? ["lines", "narration", "costCentreId"] : ["expenseAccountId", "description", "amount", "taxCodeId", "vendorId", "partyName", "paymentMode", "paymentAccountId", "paymentReference", "narration", "costCentreId"];
    if (payloadKeys.some((k) => data[k] !== undefined)) {
      // a kind never changes: the whole payload is checked again as it would be saved
      const current = doc.toObject();
      const merged = {};
      for (const k of payloadKeys) merged[k] = data[k] !== undefined ? data[k] : current[k];
      const payload = await payloadOf(merged, doc.kind, session);
      for (const k of payloadKeys) doc.set(k, payload[k] === undefined ? undefined : payload[k]);
      doc.totalAmount = payload.totalAmount;
      doc.retryAfter = null; // a refused run may succeed now (an account switched back on): try again at once
    }
    // saved again by somebody: the vouchers are made as them from now on (the way out of OWNER_INACTIVE)
    if (mongoose.isValidObjectId(by)) doc.ownerId = by;
    doc.updatedBy = String(by);
    await doc.save({ session });
    return doc;
  });

  static async pause(id, by) {
    const doc = await RecurringVoucher.findOneAndUpdate({ _id: id, status: "ACTIVE" }, { $set: { status: "PAUSED", updatedBy: String(by) } }, { new: true });
    if (doc) return doc;
    return this.refuseState(id, "pause");
  }

  /** Carries on from the first scheduled day on or after today; the days the pause skipped are not made. */
  static async resume(id, by) {
    const doc = await RecurringVoucher.findById(id);
    if (!doc) throw fail("Recurring voucher not found", 404, "RECURRING_NOT_FOUND");
    if (doc.status !== "PAUSED") return this.refuseState(id, "resume");
    const schedule = scheduleOf(doc);
    const k = rules.resumeFrom(schedule, doc.cursor, todayInOrg(), doc.made);
    doc.cursor = k ?? doc.cursor;
    doc.nextRunDay = k === null ? null : rules.runDay(schedule, k);
    doc.status = k === null ? "ENDED" : "ACTIVE";
    doc.lastError = undefined;
    doc.retryAfter = null;
    doc.updatedBy = String(by);
    await doc.save();
    return doc;
  }

  static async refuseState(id, action) {
    const doc = await RecurringVoucher.findById(id).lean();
    if (!doc) throw fail("Recurring voucher not found", 404, "RECURRING_NOT_FOUND");
    if (doc.status === "ENDED") throw fail(`${doc.name} has finished: no more vouchers are due`, 409, "RECURRING_ENDED");
    throw fail(`${doc.name} is ${doc.status === "PAUSED" ? "paused" : "running"}: it cannot be ${action === "pause" ? "paused" : "resumed"}`, 409, "RECURRING_STATE");
  }

  static async remove(id) {
    const doc = await RecurringVoucher.findByIdAndDelete(id).lean();
    if (!doc) throw fail("Recurring voucher not found", 404, "RECURRING_NOT_FOUND");
    return doc; // the vouchers it made stay: they are vouchers in their own right
  }

  /**
   * Make the voucher for one slot. Returns { made: true, voucher } or { made: false } when somebody else made it first.
   * Throws a refusal from the voucher itself (the period lock, an account switched off...), with nothing written.
   */
  static runSlot = withTransactionSession(async (id, k, session) => {
    const t = await RecurringVoucher.findById(id).session(session);
    if (!t || t.status !== "ACTIVE" || t.cursor !== k) return { made: false };
    const schedule = scheduleOf(t);
    if (!rules.withinSchedule(schedule, k, t.made)) return { made: false };
    const day = rules.runDay(schedule, k);
    const nextRunDay = rules.nextRun(schedule, k + 1, t.made + 1);
    // the claim: only one run moves the cursor past k
    const claimed = await RecurringVoucher.updateOne(
      { _id: t._id, cursor: k, made: t.made, status: "ACTIVE" },
      { $set: { cursor: k + 1, made: t.made + 1, nextRunDay, status: nextRunDay ? "ACTIVE" : "ENDED", retryAfter: null }, $unset: { lastError: 1 } },
      { session }
    );
    if (claimed.modifiedCount !== 1) return { made: false };

    const owner = await Admin.findById(t.ownerId).select("isActive status").session(session).lean();
    if (!owner || owner.isActive === false || (owner.status && owner.status !== "active")) {
      throw fail("The person who set this up no longer has an active account. Open the recurring voucher and save it again from your own account.", 409, "OWNER_INACTIVE");
    }

    const voucher = await runInBranchOf(t, async () => {
      const made = await FinancialService.createVoucher(bodyFor(t.toObject(), day), t.ownerId, session, { holdFor: "recurring" });
      await Voucher.updateOne({ _id: made._id }, { $set: { recurringRef: { id: t._id, name: t.name } } }, { session });
      return made;
    });
    await RecurringVoucher.updateOne(
      { _id: t._id },
      { $push: { runs: { $each: [{ day, voucherId: voucher._id, voucherNo: voucher.voucherNo, at: new Date() }], $slice: -KEEP_RUNS } } },
      { session }
    );
    return { made: true, voucher, day };
  });

  /** Records why a run could not be made, and when to try again. */
  static async recordFailure(t, day, err, now = new Date()) {
    await RecurringVoucher.updateOne(
      { _id: t._id },
      { $set: { lastError: { day, message: String(err?.message || err).slice(0, 500), at: now }, retryAfter: new Date(now.getTime() + RETRY_HOURS * 3600000) } }
    );
  }

  /** "Make the next one now": the next scheduled voucher, made today rather than on its day (it keeps its scheduled date). */
  static async runNow(id) {
    const t = await RecurringVoucher.findById(id).lean();
    if (!t) throw fail("Recurring voucher not found", 404, "RECURRING_NOT_FOUND");
    if (t.status !== "ACTIVE") return this.refuseState(id, "run");
    const day = rules.runDay(scheduleOf(t), t.cursor);
    try {
      const out = await this.runSlot(String(t._id), t.cursor);
      if (!out.made) throw fail("That voucher was just made by someone else", 409, "RECURRING_STATE");
      await AuditService.log({ action: "RECURRING_VOUCHER_RUN", entity: "RecurringVoucher", entityId: t._id, summary: `${t.name}: voucher ${out.voucher.voucherNo} made for ${day}, waiting for approval` });
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
    const due = await RecurringVoucher.find({
      status: "ACTIVE", nextRunDay: { $ne: null, $lte: today },
      $or: [{ retryAfter: null }, { retryAfter: { $exists: false } }, { retryAfter: { $lte: now } }],
    }).limit(200).lean();
    const out = { checked: due.length, made: 0, failed: 0 };
    for (const t of due) {
      for (const slot of rules.dueRuns(scheduleOf(t), t.cursor, today, 12, t.made)) {
        try {
          const r = await this.runSlot(String(t._id), slot.k);
          if (!r.made) break;
          out.made += 1;
          await AuditService.log({ action: "RECURRING_VOUCHER_RUN", entity: "RecurringVoucher", entityId: t._id, summary: `${t.name}: voucher ${r.voucher.voucherNo} made for ${slot.day}, waiting for approval` });
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

RecurringVoucherService.KINDS = KINDS;
module.exports = RecurringVoucherService;
