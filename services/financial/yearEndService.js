const mongoose = require("mongoose");
const FiscalYear = require("../../models/modules/financial/fiscalYearModel");
const { LedgerAccount, LedgerEntry, Voucher } = require("../../models/modules/financial/financialModels");
const Transaction = require("../../models/modules/transactionModel");
const Branch = require("../../models/core/branchModel");
const { BankReconSetup, BankReconciliation } = require("../../models/modules/banking/reconciliationModels");
const AccountConfigService = require("./accountConfigService");
const DefaultChartService = require("./defaultChartService");
const FinancialService = require("./financialService");
const NumberSeriesService = require("../core/numberSeriesService");
const AuditService = require("../core/auditService");
const { writeEntries } = require("./ledgerBalances");
const Y = require("../../utils/yearEnd");
const orgLocale = require("../../utils/orgLocale");
const AppError = require("../../utils/AppError");
const { round2, categoryOf } = require("../../utils/accounting");
const { getTenant } = require("../../utils/tenant");
const { allBranches, runInBranchOf, ambientTenant } = require("../../utils/tenantContext");

// Closing a fiscal year (rules in utils/yearEnd.js). One transaction does all of it: the closing entry that moves the
// year's income and expense to Retained Earnings, the lock, and the next year if it does not exist yet. Reopening takes
// the closing entry back and unlocks. The ledger is one running book, so a balance sheet account needs no entry: what
// the year closes with is what the next one opens with.

const SYSTEM_USER = new mongoose.Types.ObjectId("000000000000000000000000");
const asAdmin = (v) => (mongoose.isValidObjectId(v) ? v : SYSTEM_USER);
const sessionOf = (q, session) => (session ? q.session(session) : q);
// The branch the person is looking at, or null for every branch (getTenant() names the branch they WORK in, not this).
const viewOf = () => ambientTenant()?.branchView || null;
const dayDate = (day) => new Date(`${day}T00:00:00.000Z`); // how a day-only date is stored (utils/tz.js)

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

class YearEndService {
  static async load(id, { session } = {}) {
    if (!mongoose.isValidObjectId(id)) throw new AppError("Fiscal year not found", 404, "NOT_FOUND");
    const fy = await sessionOf(FiscalYear.findById(id), session);
    if (!fy) throw new AppError("Fiscal year not found", 404, "NOT_FOUND");
    return fy;
  }

  // The account the profit goes to. A company whose posting map was made before the key existed has it unmapped: the
  // defaults are added once and we try again, as the bank reconciliation does for bank-charges.
  static async retainedAccount({ session, req } = {}) {
    const resolve = async () => {
      const id = await AccountConfigService.resolveAccount("retained-earnings", { session });
      const acc = await sessionOf(LedgerAccount.findById(id).select("accountName accountCode").lean(), session);
      return acc ? { mapped: true, accountId: String(acc._id), accountName: acc.accountName, accountCode: acc.accountCode } : { mapped: false };
    };
    try {
      return await resolve();
    } catch (err) {
      if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err;
    }
    try {
      await DefaultChartService.provision(req);
      return await resolve();
    } catch (err) {
      if (err.code === "ACCOUNT_NOT_CONFIGURED") return { mapped: false };
      throw err;
    }
  }

  // Every income and expense balance as at the year end, per branch and cumulative (closing entries of earlier years
  // already counted, so an account closed before reads zero), with the year's own activity beside it.
  static async balances(fy, { session } = {}) {
    const aggregate = LedgerEntry.aggregate([
      { $match: { isReversed: { $ne: true }, date: { $lte: fy.endDate } } },
      {
        $group: {
          _id: { accountId: "$accountId", branchId: "$branchId" },
          accountName: { $first: "$accountName" },
          accountCode: { $first: "$accountCode" },
          debit: { $sum: "$debitAmount" },
          credit: { $sum: "$creditAmount" },
          // the year itself: inside its dates, and not a closing entry
          yearDebit: { $sum: { $cond: [{ $and: [{ $gte: ["$date", fy.startDate] }, { $ne: ["$voucherType", Y.CLOSING_VOUCHER_TYPE] }] }, "$debitAmount", 0] } },
          yearCredit: { $sum: { $cond: [{ $and: [{ $gte: ["$date", fy.startDate] }, { $ne: ["$voucherType", Y.CLOSING_VOUCHER_TYPE] }] }, "$creditAmount", 0] } },
        },
      },
      { $lookup: { from: "ledgeraccounts", localField: "_id.accountId", foreignField: "_id", as: "acc", pipeline: [{ $project: { accountType: 1, groupId: 1, accountName: 1, accountCode: 1 } }] } },
      { $lookup: { from: "accountgroups", localField: "acc.groupId", foreignField: "_id", as: "grp", pipeline: [{ $project: { category: 1 } }] } },
    ]);
    const rows = await (session ? aggregate.session(session) : aggregate);
    return rows.map((r) => ({
      accountId: r._id.accountId, branchId: r._id.branchId || Y.HEAD_OFFICE,
      accountName: r.acc?.[0]?.accountName || r.accountName, accountCode: r.acc?.[0]?.accountCode || r.accountCode || "",
      category: r.grp?.[0]?.category || categoryOf(r.acc?.[0]?.accountType),
      debit: r.debit, credit: r.credit, yearDebit: r.yearDebit, yearCredit: r.yearCredit,
    }));
  }

  // Everything the checks and the screen need, read in one place (inside the transaction when closing, so what was
  // judged is what is posted).
  static async gather(fy, { session, req, view } = {}) {
    const actorView = view !== undefined ? view : viewOf();
    const startDay = orgLocale.dayOf(fy.startDate);
    const endDay = orgLocale.dayOf(fy.endDate);

    return allBranches(async () => {
      const years = await sessionOf(FiscalYear.find({}).sort({ startDate: 1 }).lean(), session);
      const earlierOpen = years.filter((y) => y.endDate < fy.startDate && y.status !== "closed").map((y) => y.code);
      const laterClosed = years.filter((y) => y.startDate > fy.endDate && y.status === "closed").map((y) => y.code);

      // the year that follows: the one that already covers the day after this ends, else the one to create
      const range = Y.nextYearRange(startDay, endDay);
      let next = { code: null, exists: false, conflict: false, startDay: null, endDay: null };
      if (range) {
        const from = orgLocale.dayStart(range.startDay);
        const to = orgLocale.endOfDay(range.endDay);
        const covering = years.find((y) => y.startDate <= from && y.endDate >= from);
        if (covering) {
          next = { code: covering.code, exists: true, conflict: false, startDay: orgLocale.dayOf(covering.startDate), endDay: orgLocale.dayOf(covering.endDate) };
        } else {
          let code = Y.nextYearCode(fy.code, range.endDay);
          if (years.some((y) => y.code === code)) code = `${code}-${range.endDay.slice(0, 4)}`.slice(0, 20);
          next = { code, exists: false, conflict: years.some((y) => y.startDate <= to && y.endDate >= from), startDay: range.startDay, endDay: range.endDay };
        }
      }

      const within = { $gte: fy.startDate, $lte: fy.endDate };
      const [documents, vouchers, rows, postingEnabled, retained, setups] = await Promise.all([
        sessionOf(Transaction.countDocuments({ status: "DRAFT", isOpening: { $ne: true }, date: within }), session),
        sessionOf(Voucher.countDocuments({ status: { $in: ["draft", "pending"] }, date: within }), session),
        this.balances(fy, { session }),
        AccountConfigService.isPostingEnabled({ session }),
        this.retainedAccount({ session, req }),
        sessionOf(BankReconSetup.find({}).select("accountId").lean(), session),
      ]);

      // bank accounts that are reconciled at all, and how far
      let banks = [];
      if (setups.length) {
        const ids = setups.map((s) => s.accountId);
        const [accounts, latest] = await Promise.all([
          sessionOf(LedgerAccount.find({ _id: { $in: ids } }).select("accountName").lean(), session),
          sessionOf(BankReconciliation.aggregate([{ $match: { accountId: { $in: ids }, status: "completed" } }, { $group: { _id: "$accountId", asOf: { $max: "$asOf" } } }]), session),
        ]);
        const doneTo = new Map(latest.map((l) => [String(l._id), l.asOf]));
        banks = accounts.map((a) => ({ accountName: a.accountName, reconciledTo: doneTo.get(String(a._id)) || null }));
      }

      // the books balance inside every branch (a posting that does not would carry into equity unseen)
      const sums = new Map();
      for (const r of rows) {
        const s = sums.get(r.branchId) || { debit: 0, credit: 0 };
        s.debit += r.debit;
        s.credit += r.credit;
        sums.set(r.branchId, s);
      }
      const outOfBalance = [...sums.entries()].map(([branchId, s]) => ({ branchId, difference: round2(s.debit - s.credit) })).filter((x) => Math.abs(x.difference) >= 0.005);

      const plan = Y.planClosing(rows);
      const facts = {
        year: { code: fy.code, status: fy.status, startDay, endDay },
        today: orgLocale.today(), allBranches: !actorView,
        earlierOpen, laterClosed, unfinished: { documents, vouchers }, outOfBalance,
        retained, postingEnabled, banks, next, currency: orgLocale.baseCurrency(),
      };
      return { facts, plan, rows };
    });
  }

  // The figures the dialog shows: the year's own profit, anything older that was never closed, and the balance sheet
  // the next year opens with.
  static figures(plan, rows, { closed = false } = {}) {
    let yearIncome = 0;
    let yearExpenses = 0;
    let assets = 0;
    let liabilities = 0;
    let equity = 0;
    for (const r of rows) {
      if (r.category === "INCOME") yearIncome += r.yearCredit - r.yearDebit;
      else if (r.category === "EXPENSE") yearExpenses += r.yearDebit - r.yearCredit;
      else if (r.category === "ASSET") assets += r.debit - r.credit;
      else if (r.category === "LIABILITY") liabilities += r.credit - r.debit;
      else if (r.category === "EQUITY") equity += r.credit - r.debit;
    }
    yearIncome = round2(yearIncome);
    yearExpenses = round2(yearExpenses);
    const yearProfit = round2(yearIncome - yearExpenses);
    const equityAfter = round2(equity + plan.profit); // what the profit becomes once it is in equity
    return {
      income: plan.income, expenses: plan.expenses, profit: plan.profit, accounts: plan.accounts,
      yearIncome, yearExpenses, yearProfit,
      // profit of earlier periods that no closing entry ever took to equity (years locked before closing existed);
      // nothing to say about a year that is closed: its profit is in equity
      broughtForward: closed ? 0 : round2(plan.profit - yearProfit),
      carriedForward: { assets: round2(assets), liabilities: round2(liabilities), equity: equityAfter, balanced: Math.abs(assets - liabilities - equityAfter) < 0.01 },
    };
  }

  // ---------------------------------------------------------------- the screen

  // What closing (or reopening) this year would do, and what stands in the way. Read-only apart from the one-time top-up
  // of the posting map (see retainedAccount).
  static async preview(id, req) {
    const fy = await this.load(id);
    const { facts, plan, rows } = await this.gather(fy, { req });
    const close = Y.assessClose(facts);
    const reopen = Y.assessReopen({ year: facts.year, laterClosed: facts.laterClosed });
    const branches = await Branch.find({}).select("code name").lean();
    const nameOf = new Map(branches.map((b) => [b.code, b.name]));
    const figures = this.figures(plan, rows, { closed: fy.status === "closed" });
    return {
      year: { _id: fy._id, code: fy.code, status: fy.status, startDate: fy.startDate, endDate: fy.endDate, startDay: facts.year.startDay, endDay: facts.year.endDay },
      currency: facts.currency,
      ...close,
      reopen: { canReopen: reopen.canClose, blockers: reopen.blockers },
      figures,
      branches: plan.branches.map((b) => ({ branchId: b.branchId, name: nameOf.get(b.branchId) || (b.branchId === Y.HEAD_OFFICE ? "Head office" : b.branchId), income: b.income, expenses: b.expenses, profit: b.profit })),
      retained: facts.retained.mapped ? { accountName: facts.retained.accountName } : null,
      next: { code: facts.next.code, exists: facts.next.exists, startDay: facts.next.startDay, endDay: facts.next.endDay },
      willPost: Boolean(facts.postingEnabled && plan.lines > 0),
      closing: fy.closing || null,
    };
  }

  // ---------------------------------------------------------------- closing

  // acknowledge: the codes of the warnings the person was shown and accepted.
  static async close(id, { acknowledge } = {}, req) {
    const branchView = viewOf();
    const adminId = req?.admin?.id;
    // The posting map is topped up BEFORE the transaction: a transaction reads the data as it stood when it began, so a
    // mapping made inside the run would stay invisible to it.
    await this.retainedAccount({ req });
    const result = await inTransaction(async (session) => {
      const fy = await this.load(id, { session });
      // judged against the actor's own view: a person looking at one branch cannot close the whole organisation
      const { facts, plan } = await this.gather(fy, { session, req, view: branchView });
      const assessment = Y.assessClose(facts);
      if (!assessment.canClose) {
        const first = assessment.blockers[0];
        throw new AppError(first.title, 409, first.code === "ALREADY_CLOSED" ? "ALREADY_CLOSED" : "YEAR_CLOSE_BLOCKED", { checks: assessment.checks, blockers: assessment.blockers });
      }
      const pending = Y.unacknowledged(assessment, acknowledge);
      if (pending.length) {
        throw new AppError(`${pending[0].title}. Acknowledge it to close the year.`, 409, "YEAR_CLOSE_WARNINGS", { warnings: pending });
      }

      // the claim: only one of two simultaneous closings gets past this write, the other retries and finds it closed
      const claimed = await FiscalYear.findOneAndUpdate(
        { _id: fy._id, status: "open" },
        { $set: { status: "closed", closedAt: new Date(), ...(mongoose.isValidObjectId(adminId) ? { closedBy: adminId } : {}) } },
        { new: true, session }
      );
      if (!claimed) throw new AppError(`Fiscal year ${fy.code} is already closed`, 409, "ALREADY_CLOSED");

      const closing = {
        date: dayDate(facts.year.endDay), income: plan.income, expenses: plan.expenses, profit: plan.profit, accounts: plan.accounts,
        posted: false, nextYear: facts.next.code, nextYearCreated: false, acknowledged: assessment.warnings.map((w) => w.code),
      };

      // the closing entry, one balanced set of lines per branch, under one number
      if (facts.postingEnabled && plan.lines > 0) {
        const voucherId = new mongoose.Types.ObjectId();
        // numbered in head office's series whoever is closing: it is the organisation's entry
        const voucherNo = await runInBranchOf({ branchId: Y.HEAD_OFFICE }, () => NumberSeriesService.allocate("YEC", closing.date, { session, req }));
        const entries = Y.closingEntries(plan, facts.retained, { voucherId, voucherNo, date: closing.date, createdBy: asAdmin(adminId), yearCode: fy.code });
        const unbalanced = Y.unbalancedBranches(entries);
        if (unbalanced.length) throw new AppError("The closing entry does not balance", 500, "CLOSING_NOT_BALANCED", { unbalanced });
        // across branches: the plan carries each branch's own ids, which the tenant plugin keeps because the view is lifted
        await allBranches(() => writeEntries(entries, session));
        Object.assign(closing, { posted: true, voucherId, voucherNo, retainedAccountId: facts.retained.accountId, retainedAccountName: facts.retained.accountName });
      }

      // the year that follows, so posting carries on the next morning
      if (!facts.next.exists && facts.next.code) {
        const { companyId } = getTenant(req);
        await FiscalYear.create(
          [{ companyId, code: facts.next.code, startDate: orgLocale.dayStart(facts.next.startDay), endDate: orgLocale.endOfDay(facts.next.endDay), status: "open" }],
          { session }
        );
        closing.nextYearCreated = true;
      }

      await FiscalYear.updateOne({ _id: fy._id }, { $set: { closing } }, { session });
      return { yearId: fy._id, code: fy.code, closing };
    });

    await AuditService.log({
      req, action: "PERIOD_CLOSED", entity: "FiscalYear", entityId: result.yearId,
      summary: result.closing.posted
        ? `${result.code} closed; ${result.closing.profit >= 0 ? "profit" : "loss"} of ${Math.abs(result.closing.profit).toFixed(2)} moved to ${result.closing.retainedAccountName} (${result.closing.voucherNo})${result.closing.nextYearCreated ? `; ${result.closing.nextYear} created` : ""}`
        : `${result.code} closed with no closing entry${result.closing.nextYearCreated ? `; ${result.closing.nextYear} created` : ""}`,
      after: { profit: result.closing.profit, voucherNo: result.closing.voucherNo || null, acknowledged: result.closing.acknowledged },
    });
    return { ...(await this.preview(result.yearId, req)), closedNow: true };
  }

  // ---------------------------------------------------------------- reopening

  static async reopen(id, req) {
    const branchView = viewOf();
    if (branchView) {
      throw new AppError("Reopening a year covers every branch: switch to All branches first", 409, "ALL_BRANCHES_REQUIRED");
    }
    const result = await inTransaction(async (session) => {
      const fy = await this.load(id, { session });
      const { facts } = await this.gather(fy, { session, req, view: branchView });
      const assessment = Y.assessReopen({ year: facts.year, laterClosed: facts.laterClosed });
      if (!assessment.canClose) {
        const first = assessment.blockers[0];
        throw new AppError(first.title, 409, first.code === "NOT_CLOSED" ? "NOT_CLOSED" : "YEAR_REOPEN_BLOCKED", { blockers: assessment.blockers });
      }
      const before = fy.closing ? fy.closing.toObject() : null;

      // the closing entry comes back out first: its lines and their reversal stay on record, marked reversed
      if (before?.posted && before.voucherId) {
        await allBranches(() => FinancialService.reverseLedgerEntries(before.voucherId, session));
      }
      const claimed = await FiscalYear.findOneAndUpdate(
        { _id: fy._id, status: "closed" },
        { $set: { status: "open" }, $unset: { closedAt: "", closedBy: "", closing: "" } },
        { new: true, session }
      );
      if (!claimed) throw new AppError(`Fiscal year ${fy.code} is not closed`, 409, "NOT_CLOSED");
      return { yearId: fy._id, code: fy.code, before };
    });

    await AuditService.log({
      req, action: "PERIOD_REOPENED", entity: "FiscalYear", entityId: result.yearId,
      summary: result.before?.posted ? `${result.code} reopened; closing entry ${result.before.voucherNo} reversed` : `${result.code} reopened`,
      before: result.before ? { profit: result.before.profit, voucherNo: result.before.voucherNo || null } : undefined,
    });
    return { ...(await this.preview(result.yearId, req)), reopenedNow: true };
  }
}

module.exports = YearEndService;
