const mongoose = require("mongoose");
const FiscalYear = require("../../models/modules/financial/fiscalYearModel");
const { LedgerEntry, Voucher } = require("../../models/modules/financial/financialModels");
const Transaction = require("../../models/modules/transactionModel");
const AccountConfigService = require("./accountConfigService");
const YearEndService = require("./yearEndService");
const FiscalYearService = require("../core/fiscalYearService");
const AuditService = require("../core/auditService");
const P = require("../../utils/periodClose");
const Y = require("../../utils/yearEnd");
const orgLocale = require("../../utils/orgLocale");
const AppError = require("../../utils/AppError");
const { round2 } = require("../../utils/accounting");
const { allBranches, ambientTenant } = require("../../utils/tenantContext");

// Closing a month inside an open fiscal year (rules in utils/periodClose.js). A month close is a LOCK: it posts nothing,
// it moves no profit to equity (that is the year's closing entry) and it writes one field, FiscalYear.lockedThrough, that
// the period lock (FiscalYearService.assertPostingAllowed) reads. Months are closed in order and only the latest closed
// month is reopened. It covers every branch, because a fiscal year is the organisation's, so it is done from the
// all-branches view (read it with ambientTenant(): getTenant() does NOT carry branchView).

const sessionOf = (q, session) => (session ? q.session(session) : q);
// The branch the person is looking at, or null for every branch.
const viewOf = () => ambientTenant()?.branchView || null;

async function inTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

class PeriodCloseService {
  // The year as the pure rules read it (its days in the organisation's zone, the month lock, who closed what).
  static periodOf(fy) {
    return FiscalYearService.periodView(fy, fy.companyId);
  }

  static async monthOf(fy, key) {
    const month = P.findMonth(this.periodOf(fy), key);
    if (!month) throw new AppError(`${key} is not a month of ${fy.code}`, 404, "MONTH_NOT_FOUND");
    return month;
  }

  // ---------------------------------------------------------------- the list

  // A year's months and where each stands. Read-only; any signed-in person who can see Fiscal years may ask.
  static async months(id) {
    const fy = await YearEndService.load(id);
    const v = this.periodOf(fy);
    return {
      year: { _id: fy._id, code: fy.code, status: fy.status, startDay: v.startDay, endDay: v.endDay, lockedThrough: v.lockedThroughDay },
      months: P.monthStates(v),
    };
  }

  // ---------------------------------------------------------------- what the checks read

  // Everything the checks and the screen need for one month, read in one place (inside the transaction when closing, so
  // what was judged is what is locked). `stock` is the stock check when the caller already has it; `light` reads only
  // the years (what reopening needs: it asks about order, not about the month's contents).
  static async gather(fy, month, { session, view, stock, light = false } = {}) {
    const actorView = view !== undefined ? view : viewOf();
    const v = this.periodOf(fy);
    const from = orgLocale.dayStart(month.startDay);
    const to = orgLocale.endOfDay(month.endDay);

    return allBranches(async () => {
      const years = (await sessionOf(FiscalYear.find({}).sort({ startDate: 1 }).lean(), session)).map((y) => ({ ...FiscalYearService.periodView(y, fy.companyId), startDate: y.startDate, endDate: y.endDate }));
      // years before this one that are not locked right to their last day: a month needs the books before it final
      const earlierYears = years.filter((y) => y.endDate < fy.startDate && !P.fullyLocked(y)).map((y) => y.code);
      // years after this one that hold any lock, which were locked on the premise that this year stays as it is
      const laterYears = years.filter((y) => y.startDate > fy.endDate && P.anyLocked(y)).map((y) => y.code);

      const within = { $gte: from, $lte: to };
      const [documents, vouchers, sums, postingEnabled, banks, stockFacts] = light ? [0, 0, [], true, [], null] : await Promise.all([
        sessionOf(Transaction.countDocuments({ status: "DRAFT", isOpening: { $ne: true }, date: within }), session),
        sessionOf(Voucher.countDocuments({ status: { $in: ["draft", "pending"] }, date: within }), session),
        sessionOf(LedgerEntry.aggregate([
          { $match: { isReversed: { $ne: true }, date: { $lte: to } } },
          { $group: { _id: "$branchId", debit: { $sum: "$debitAmount" }, credit: { $sum: "$creditAmount" } } },
        ]), session),
        AccountConfigService.isPostingEnabled({ session }),
        YearEndService.banks({ session }),
        stock !== undefined ? stock : YearEndService.stockFacts(month.endDay),
      ]);

      // the books balance inside every branch, up to the end of the month (a posting that does not would be locked in unseen)
      const byBranch = new Map();
      for (const r of sums) {
        const key = r._id || Y.HEAD_OFFICE;
        const s = byBranch.get(key) || { debit: 0, credit: 0 };
        s.debit += r.debit;
        s.credit += r.credit;
        byBranch.set(key, s);
      }
      const outOfBalance = [...byBranch.entries()].map(([branchId, s]) => ({ branchId, difference: round2(s.debit - s.credit) })).filter((x) => Math.abs(x.difference) >= 0.005);

      const facts = {
        year: { code: v.code, status: v.status, startDay: v.startDay, endDay: v.endDay, lockedThroughDay: v.lockedThroughDay },
        month, today: orgLocale.today(), allBranches: !actorView,
        earlierYears, laterYears, unfinished: { documents, vouchers }, outOfBalance,
        postingEnabled, banks, stock: stockFacts, currency: orgLocale.baseCurrency(),
      };
      return { facts, v };
    });
  }

  // ---------------------------------------------------------------- the screen

  // What closing (or reopening) this month would do, and what stands in the way. Read-only.
  static async preview(id, key) {
    const fy = await YearEndService.load(id);
    const month = await this.monthOf(fy, key);
    const { facts, v } = await this.gather(fy, month);
    const close = P.assessMonthClose(facts);
    const reopen = P.assessMonthReopen(facts);
    const state = P.monthStates(v).find((m) => m.key === month.key);
    return {
      year: { _id: fy._id, code: fy.code, status: fy.status, startDay: v.startDay, endDay: v.endDay, lockedThrough: v.lockedThroughDay },
      month: state,
      currency: facts.currency,
      ...close,
      reopen: { canReopen: reopen.canClose, blockers: reopen.blockers, checks: reopen.checks },
      stock: facts.stock || null,
    };
  }

  // ---------------------------------------------------------------- closing

  // acknowledge: the codes of the warnings the person was shown and accepted.
  static async close(id, key, { acknowledge } = {}, req) {
    const branchView = viewOf();
    const adminId = req?.admin?.id;
    const adminName = req?.admin?.name || req?.admin?.email || null;
    // The stock check is a long aggregate and only ever a warning: read it before the transaction starts.
    const month0 = await this.monthOf(await YearEndService.load(id), key);
    const stock = await YearEndService.stockFacts(month0.endDay);

    const result = await inTransaction(async (session) => {
      const fy = await YearEndService.load(id, { session });
      const month = await this.monthOf(fy, key);
      // judged against the actor's own view: a person looking at one branch cannot lock the whole organisation
      const { facts } = await this.gather(fy, month, { session, view: branchView, stock });
      const assessment = P.assessMonthClose(facts);
      if (!assessment.canClose) {
        const first = assessment.blockers[0];
        const code = ["ALREADY_CLOSED", "YEAR_CLOSED"].includes(first.code) ? first.code : "MONTH_CLOSE_BLOCKED";
        throw new AppError(first.title, 409, code, { checks: assessment.checks, blockers: assessment.blockers });
      }
      const pending = Y.unacknowledged(assessment, acknowledge);
      if (pending.length) {
        throw new AppError(`${pending[0].title}. Acknowledge it to close the month.`, 409, "MONTH_CLOSE_WARNINGS", { warnings: pending });
      }

      // the claim: only one of two simultaneous closings gets past this write (it also fails if the lock moved meanwhile)
      const claimed = await FiscalYear.findOneAndUpdate(
        { _id: fy._id, status: "open", lockedThrough: fy.lockedThrough || null },
        {
          $set: { lockedThrough: month.endDay },
          $push: {
            monthCloses: {
              month: month.key, closedAt: new Date(), closedByName: adminName, acknowledged: assessment.warnings.map((w) => w.code),
              ...(mongoose.isValidObjectId(adminId) ? { closedBy: adminId } : {}),
            },
          },
        },
        { new: true, session }
      );
      if (!claimed) throw new AppError(`${month.label} is already closed`, 409, "ALREADY_CLOSED");
      return { yearId: fy._id, code: fy.code, month, acknowledged: assessment.warnings.map((w) => w.code), stock: facts.stock };
    });

    await AuditService.log({
      req, action: "PERIOD_MONTH_CLOSED", entity: "FiscalYear", entityId: result.yearId,
      summary: `${result.month.label} closed (${result.code}); posting is closed up to ${Y.longDay(result.month.endDay)}`,
      after: { month: result.month.key, lockedThrough: result.month.endDay, acknowledged: result.acknowledged, stockDifference: result.stock?.difference ?? null },
    });
    return { ...(await this.months(result.yearId)), closedNow: true, monthKey: result.month.key };
  }

  // ---------------------------------------------------------------- reopening

  static async reopen(id, key, req) {
    if (viewOf()) {
      throw new AppError("Reopening a month covers every branch: switch to All branches first", 409, "ALL_BRANCHES_REQUIRED");
    }
    const result = await inTransaction(async (session) => {
      const fy = await YearEndService.load(id, { session });
      const month = await this.monthOf(fy, key);
      const { facts, v } = await this.gather(fy, month, { session, view: null, light: true });
      const assessment = P.assessMonthReopen(facts);
      if (!assessment.canClose) {
        const first = assessment.blockers[0];
        const code = ["NOT_CLOSED", "YEAR_CLOSED"].includes(first.code) ? first.code : "MONTH_REOPEN_BLOCKED";
        throw new AppError(first.title, 409, code, { blockers: assessment.blockers });
      }
      // the lock falls back to the end of the month before it, or goes if this was the first
      const months = P.monthsOf(v.startDay, v.endDay);
      const at = months.findIndex((m) => m.key === month.key);
      const before = at > 0 ? months[at - 1].endDay : null;
      const claimed = await FiscalYear.findOneAndUpdate(
        { _id: fy._id, status: "open", lockedThrough: month.endDay },
        { ...(before ? { $set: { lockedThrough: before } } : { $unset: { lockedThrough: "" } }), $pull: { monthCloses: { month: month.key } } },
        { new: true, session }
      );
      if (!claimed) throw new AppError(`${month.label} is not closed`, 409, "NOT_CLOSED");
      return { yearId: fy._id, code: fy.code, month, lockedThrough: before };
    });

    await AuditService.log({
      req, action: "PERIOD_MONTH_REOPENED", entity: "FiscalYear", entityId: result.yearId,
      summary: `${result.month.label} reopened (${result.code}); ${result.lockedThrough ? `posting is closed up to ${Y.longDay(result.lockedThrough)}` : "no month is closed"}`,
      before: { month: result.month.key, lockedThrough: result.month.endDay },
      after: { lockedThrough: result.lockedThrough },
    });
    return { ...(await this.months(result.yearId)), reopenedNow: true, monthKey: result.month.key };
  }
}

module.exports = PeriodCloseService;
