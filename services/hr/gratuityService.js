const mongoose = require("mongoose");
const Staff = require("../../models/modules/staffModel");
const GratuityAccrual = require("../../models/modules/hr/gratuityAccrualModel");
const EmployeeContract = require("../../models/modules/hr/employeeContractModel");
const AppError = require("../../utils/AppError");
const hr = require("../../utils/hr");
const compliance = require("../../utils/compliance");
const StatutoryRuleService = require("./statutoryRuleService");
const orgLocale = require("../../utils/orgLocale");
const AccountConfigService = require("../financial/accountConfigService");
const FiscalYearService = require("../core/fiscalYearService");
const NumberSeriesService = require("../core/numberSeriesService");
const { writeEntries } = require("../financial/ledgerBalances");
const { LedgerAccount } = require("../../models/modules/financial/financialModels");
const { addDays, isCalendarDay, orgDay } = require("../../utils/documentExpiry");
const { withTransactionSession } = require("../../utils/withTransactionSession");

// The last calendar day of "YYYY-MM", as "YYYY-MM-DD" - no month-length table needed: the first of next
// month, minus one day, following the existing day-arithmetic helper rather than a new one.
// LedgerEntry.createdBy is an ObjectId (unlike Staff/EmployeeContract's own createdBy, which are plain
// strings) - a caller that passes "system" or a test's placeholder string must not fail the posting with
// a cast error. The same sentinel services/stock/productionService.js already uses for the same reason.
const SYSTEM_USER = new mongoose.Types.ObjectId("000000000000000000000000");
const asAdminId = (v) => (mongoose.Types.ObjectId.isValid(v) && String(v).length === 24 ? new mongoose.Types.ObjectId(String(v)) : SYSTEM_USER);

const lastDayOf = (month) => {
  const [y, m] = month.split("-").map(Number);
  const nextMonthFirst = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return addDays(nextMonthFirst, -1);
};

// The two accounts, with the lazy top-up for a company whose posting map predates the keys - the same
// pattern services/hr/labourCostService.js wagesAccount() and productionService.js absorbedAccount() use.
// Read OUTSIDE any session, because the top-up commits on its own.
async function accounts() {
  try {
    const [expense, provision] = await Promise.all([
      AccountConfigService.resolveAccount("gratuity-expense"),
      AccountConfigService.resolveAccount("gratuity-provision"),
    ]);
    return { expense, provision };
  } catch (err) {
    if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err;
    await require("../financial/defaultChartService").provision();
    const [expense, provision] = await Promise.all([
      AccountConfigService.resolveAccount("gratuity-expense"),
      AccountConfigService.resolveAccount("gratuity-provision"),
    ]);
    return { expense, provision };
  }
}

/**
 * The gratuity liability as an IAS 19 "if settled today" undiscounted obligation (D11, and utils/compliance.js
 * for why a full actuarial valuation is out of scope). Accrued monthly as ONE journal for the whole
 * organisation, never one posting per employee - the ledger only needs to be right in total; per-employee
 * detail is this service's own report, read by `liabilityByEmployee`.
 */
class GratuityService {
  /**
   * Every active employee's liability on a day, named (never averaged into a figure nobody can check). Also
   * what the figures are MISSING: an employee with no contract, or a contract with no basic pay, cannot be
   * costed for gratuity and is listed apart - never silently left at 0 (utils/hr.js rule 1's own reasoning,
   * restated for pay).
   */
  static async liabilityByEmployee(day) {
    const country = orgLocale.country();
    const rules = await StatutoryRuleService.rowsFor(country);
    const staff = await Staff.find({ status: "Active" }).select("_id name staffId joiningDate").lean();
    // basicPay is select: false on the schema (it is pay data) - a BARE .select("basicPay") does NOT
    // override that; only the "+field" form does, which is why this was silently returning no basic pay
    // for anyone, found by checking the actual figures rather than trusting that .select() had worked.
    const contracts = await EmployeeContract.find({ staffId: { $in: staff.map((s) => s._id) } })
      .select("staffId effectiveFrom effectiveTo +basicPay")
      .lean();
    const byStaff = new Map(staff.map((s) => [String(s._id), []]));
    for (const c of contracts) byStaff.get(String(c.staffId))?.push(c);

    const costed = [];
    const missing = [];
    for (const s of staff) {
      // joiningDate is a real Mongo Date, whose String() form is "Fri Nov 06 2020 ...", not an ISO
      // day - the exact mistake the CRM's activityReport bug already named once. orgDay() converts
      // correctly, in the organisation's own calendar.
      const serviceDays = hr.serviceDays(s.joiningDate ? orgDay(s.joiningDate) : null, day);
      const contract = hr.contractOn(byStaff.get(String(s._id)) || [], day);
      const basicPay = contract && contract.basicPay !== undefined && contract.basicPay !== null ? Number(contract.basicPay) : null;
      if (serviceDays === null || basicPay === null) {
        missing.push({ _id: s._id, name: s.name, staffId: s.staffId, reason: basicPay === null ? "NO_BASIC_PAY" : "NO_JOINING_DATE" });
        continue;
      }
      const owed = compliance.gratuityOwed({ serviceDays, basicPay, country, day, rules });
      if (owed === null) {
        missing.push({ _id: s._id, name: s.name, staffId: s.staffId, reason: "NO_RULE" });
        continue;
      }
      costed.push({ _id: s._id, name: s.name, staffId: s.staffId, serviceDays, basicPay, owed });
    }
    return {
      day, country,
      total: Math.round(costed.reduce((t, c) => t + c.owed, 0) * 100) / 100,
      employees: costed,
      missing,
    };
  }

  /** The most recent posted (never-reversed) accrual - what "last month's cumulative figure" means. */
  static async lastAccrual({ session } = {}) {
    const q = GratuityAccrual.find({ reversedAt: null }).sort({ month: -1 }).limit(1);
    const [row] = await (session ? q.session(session) : q).lean();
    return row || null;
  }

  /** What accruing a month WOULD do, with nothing written - the preview a screen shows before posting. */
  static async preview(month) {
    if (!/^\d{4}-\d{2}$/.test(String(month))) throw new AppError("Give the month as YYYY-MM", 400, "INVALID_MONTH");
    const day = lastDayOf(month);
    const liability = await this.liabilityByEmployee(day);
    const last = await this.lastAccrual();
    const amount = Math.round((liability.total - (last?.cumulativeLiability || 0)) * 100) / 100;
    return {
      month, day, cumulativeLiability: liability.total, previousCumulative: last?.cumulativeLiability || 0, amount,
      employeeCount: liability.employees.length,
      // Named, with each one's basic pay - this is why the controller strips the whole thing for a reader
      // without hr.confidential (controllers/hr/complianceController.js forReader), down to employeeCount
      // and missing.length only.
      employees: liability.employees,
      missing: liability.missing,
    };
  }

  /**
   * Post the month's accrual. Refuses if the month was already accrued (the unique index on `month` is the
   * real guarantee; the find-first check only gives a clean message instead of a duplicate-key error) and
   * if ledger posting is off (there is nothing meaningful to accrue without a ledger).
   *
   * A zero movement still WRITES the tracking row (so next month's delta reads correctly) but allocates no
   * number and posts no entry - a quiet month, the same "nothing to report" the day-end reports already
   * treat as a fact worth recording rather than an error.
   */
  static accrue = withTransactionSession(async (month, by, session) => {
    if (!/^\d{4}-\d{2}$/.test(String(month))) throw new AppError("Give the month as YYYY-MM", 400, "INVALID_MONTH");
    const day = lastDayOf(month);
    if (!isCalendarDay(day)) throw new AppError("That is not a real month", 400, "INVALID_MONTH");

    const already = await GratuityAccrual.findOne({ month }).session(session);
    if (already) throw new AppError(`${month} has already been accrued`, 409, "ALREADY_ACCRUED");

    await FiscalYearService.assertPostingAllowed(day, { session });
    const postingOn = await AccountConfigService.isPostingEnabled({ session });
    if (!postingOn) throw new AppError("Switch ledger posting on before accruing gratuity - there is no provision to carry without a ledger", 409, "LEDGER_POSTING_OFF");

    const liability = await this.liabilityByEmployee(day);
    const last = await this.lastAccrual({ session });
    const amount = Math.round((liability.total - (last?.cumulativeLiability || 0)) * 100) / 100;

    if (Math.abs(amount) < 0.005) {
      const [quiet] = await GratuityAccrual.create(
        [{ month, amount: 0, cumulativeLiability: liability.total, employeeCount: liability.employees.length, createdBy: by }],
        { session }
      );
      return { accrual: quiet, posted: false };
    }

    const { expense, provision } = await accounts(); // outside this transaction's concerns: the top-up commits on its own
    const accrualId = new mongoose.Types.ObjectId();
    const voucherNo = await NumberSeriesService.allocate("GRJ", day, { session });
    // A $in query does NOT promise its results back in the array's own order - destructuring [exp, prov]
    // straight off it silently swapped the two accounts the day this was written (found by checking the
    // actual docs, not trusting that two accounts "must" come back expense-first). Looked up by id instead.
    const byId = new Map((await LedgerAccount.find({ _id: { $in: [expense._id, provision._id] } }).select("accountName accountCode").session(session).lean()).map((a) => [String(a._id), a]));
    const exp = byId.get(String(expense._id));
    const prov = byId.get(String(provision._id));
    if (!exp || !prov) throw new AppError("The gratuity posting accounts could not be found", 500, "ACCOUNT_NOT_CONFIGURED");
    const d = new Date(day);
    const base = {
      voucherId: accrualId, voucherNo, voucherType: "gratuity", date: day,
      referenceType: "gratuity", referenceId: accrualId, referenceNo: voucherNo,
      month: d.getMonth() + 1, year: d.getFullYear(), financialYear: String(d.getFullYear()),
      createdBy: asAdminId(by), // the LEDGER row needs a real ObjectId; GratuityAccrual.postedBy below keeps the raw value
    };
    // amount > 0: the liability grew - Dr expense / Cr provision. amount < 0: it shrank (people who were
    // owed gratuity left and were paid, or a correction) - the entry simply runs the other way.
    const docs = [
      { ...base, accountId: exp._id, accountName: exp.accountName, accountCode: exp.accountCode, debitAmount: amount > 0 ? amount : 0, creditAmount: amount < 0 ? -amount : 0, narration: `Gratuity accrual ${month}` },
      { ...base, accountId: prov._id, accountName: prov.accountName, accountCode: prov.accountCode, debitAmount: amount < 0 ? -amount : 0, creditAmount: amount > 0 ? amount : 0, narration: `Gratuity accrual ${month}` },
    ];
    await writeEntries(docs, session);

    const [created] = await GratuityAccrual.create(
      [{
        _id: accrualId, month, amount, cumulativeLiability: liability.total, employeeCount: liability.employees.length,
        voucherNo, postedBy: by, createdBy: by,
      }],
      { session }
    );
    return { accrual: created, posted: true };
  });

  /** Undo a posted accrual - the same shape as reversing any other posting, never an edit in place. */
  static reverse = withTransactionSession(async (id, { reason } = {}, by, session) => {
    const row = await GratuityAccrual.findById(id).session(session);
    if (!row) throw new AppError("Accrual not found", 404, "ACCRUAL_NOT_FOUND");
    if (row.reversedAt) throw new AppError("Already reversed", 409, "ALREADY_REVERSED");
    if (!row.voucherNo) throw new AppError("A quiet month posted nothing to reverse", 409, "NOTHING_POSTED");
    await FiscalYearService.assertPostingAllowed(lastDayOf(row.month), { session });
    const FinancialService = require("../financial/financialService");
    await FinancialService.reverseLedgerEntries(row._id, session);
    row.reversedAt = new Date();
    row.reversedBy = by;
    row.reverseReason = reason;
    await row.save({ session });
    return row;
  });

  static list() {
    return GratuityAccrual.find().sort({ month: -1 }).lean();
  }
}

module.exports = GratuityService;
