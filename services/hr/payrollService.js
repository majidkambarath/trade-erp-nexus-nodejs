const mongoose = require("mongoose");
const Staff = require("../../models/modules/staffModel");
const EmployeeContract = require("../../models/modules/hr/employeeContractModel");
const PayrollRun = require("../../models/modules/hr/payrollRunModel");
const Payslip = require("../../models/modules/hr/payslipModel");
const AppError = require("../../utils/AppError");
const hr = require("../../utils/hr");
const payroll = require("../../utils/payroll");
const orgLocale = require("../../utils/orgLocale");
const SalaryComponentService = require("./salaryComponentService");
const StatutoryRuleService = require("./statutoryRuleService");
const AccountConfigService = require("../financial/accountConfigService");
const FiscalYearService = require("../core/fiscalYearService");
const NumberSeriesService = require("../core/numberSeriesService");
const { writeEntries } = require("../financial/ledgerBalances");
const { LedgerAccount } = require("../../models/modules/financial/financialModels");
const { orgDay } = require("../../utils/documentExpiry");
const { withTransactionSession } = require("../../utils/withTransactionSession");

const SYSTEM_USER = new mongoose.Types.ObjectId("000000000000000000000000");
const asAdminId = (v) => (mongoose.Types.ObjectId.isValid(v) && String(v).length === 24 ? new mongoose.Types.ObjectId(String(v)) : SYSTEM_USER);

// The three accounts a run can touch by default, with the lazy top-up for a company whose posting map
// predates the keys - the same pattern gratuityService.js and labourCostService.js already use. Read
// OUTSIDE any session, because the top-up commits on its own.
async function defaultAccounts() {
  const keys = ["salary-expense", "statutory-deductions-payable", "salaries-payable"];
  try {
    const [expense, deductions, payable] = await Promise.all(keys.map((k) => AccountConfigService.resolveAccount(k)));
    return { expense, deductions, payable };
  } catch (err) {
    if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err;
    await require("../financial/defaultChartService").provision();
    const [expense, deductions, payable] = await Promise.all(keys.map((k) => AccountConfigService.resolveAccount(k)));
    return { expense, deductions, payable };
  }
}

/**
 * Payroll: a run is posted like a year's closing entry (D14) - one operation for the WHOLE organisation
 * at once, numbered through the series `PAY`, never one Voucher per employee. Per-employee detail is the
 * Payslip rows, which the ledger never carries (D11's own reasoning, restated here).
 */
class PayrollService {
  /** Build the whole run's figures WITHOUT writing anything - what both plan() and post() share, so a
   * preview and the actual post can never disagree about what would happen. */
  static async build(period, { session } = {}) {
    if (!/^\d{4}-\d{2}$/.test(String(period))) throw new AppError("Give the period as YYYY-MM", 400, "INVALID_PERIOD");
    const days = payroll.periodDays(period);
    if (!days) throw new AppError("That is not a real period", 400, "INVALID_PERIOD");
    const payDate = days.lastDay;

    const country = orgLocale.country();
    const [staff, components] = await Promise.all([
      Staff.find().select("_id name staffId status joiningDate exitDate").lean(),
      SalaryComponentService.forCountry(country),
    ]);
    const statutoryKeys = components.flatMap((c) => [c.statutoryKey, c.capBaseKey, c.eligibleUpToKey]).filter(Boolean);
    const [rulesByKey, contracts] = await Promise.all([
      StatutoryRuleService.valuesOn(statutoryKeys, { country, day: payDate }),
      EmployeeContract.find({ staffId: { $in: staff.map((s) => s._id) } }).select("staffId effectiveFrom effectiveTo +basicPay +allowances").lean(),
    ]);
    const byStaff = new Map(staff.map((s) => [String(s._id), []]));
    for (const c of contracts) byStaff.get(String(c.staffId))?.push(c);

    const employees = [];
    for (const s of staff) {
      const joiningDay = s.joiningDate ? orgDay(s.joiningDate) : null;
      const exitDay = s.exitDate ? orgDay(s.exitDate) : null;
      const factor = payroll.prorationFactor({ period, joiningDay, exitDay });
      if (factor === null) continue; // not employed at any point during this period at all

      const contract = hr.contractOn(byStaff.get(String(s._id)) || [], payDate);
      const base = {
        staffId: s._id, staffName: s.name, factor,
        joinedMidPeriod: Boolean(joiningDay && joiningDay > days.firstDay && joiningDay <= days.lastDay),
        exitedMidPeriod: Boolean(exitDay && exitDay >= days.firstDay && exitDay < days.lastDay),
      };
      if (!contract) { employees.push({ ...base, hasContract: false, netPay: null, slip: null }); continue; }

      const slip = payroll.payslipFor({ contract, components, rulesByKey, factor });
      employees.push({ ...base, hasContract: slip !== null, netPay: slip?.netPay ?? null, slip, branchId: s.branchId || "main" });
    }

    const already = await PayrollRun.findOne({ period, status: "POSTED" }).session(session || null).lean();
    const assessment = payroll.assessPayroll({ period, alreadyPosted: Boolean(already), employees });

    const paid = employees.filter((e) => e.slip);
    const totals = {
      employeeCount: paid.length,
      gross: round2(paid.reduce((t, e) => t + e.slip.grossPay, 0)),
      earnings: round2(paid.reduce((t, e) => t + e.slip.totalEarnings, 0)),
      deductions: round2(paid.reduce((t, e) => t + e.slip.totalDeductions, 0)),
      net: round2(paid.reduce((t, e) => t + e.slip.netPay, 0)),
    };
    return { period, payDate, employees, components, assessment, totals, alreadyPosted: Boolean(already) };
  }

  /** The preview a screen shows before posting - nothing written. */
  static async plan(period) {
    return this.build(period);
  }

  /** Post the period. Refused outright on a blocker; a warning must be ticked by name (`acknowledge`). */
  static post = withTransactionSession(async (period, { acknowledge } = {}, by, session) => {
    const built = await this.build(period, { session });
    if (!built.assessment.canClose) {
      const first = built.assessment.blockers[0];
      throw new AppError(first.title, 409, first.code, { checks: built.assessment.checks });
    }
    const left = payroll.unacknowledged(built.assessment, acknowledge);
    if (left.length) {
      throw new AppError("This run has warnings that have not been acknowledged", 409, "PAYROLL_WARNINGS", { warnings: left });
    }

    await FiscalYearService.assertPostingAllowed(built.payDate, { session });

    const paid = built.employees.filter((e) => e.slip);
    const { expense, deductions: deductionsAccount, payable } = await defaultAccounts(); // outside this transaction's concerns
    const byComponentId = new Map(built.components.map((c) => [String(c._id), c]));

    // Roll up by account FIRST (D11/D14's own reasoning: the ledger is right in total, never one posting
    // per employee) - a component's own accountId override is resolved per component, everything else
    // falls to the three defaults above.
    const debitTotals = new Map(); // accountId -> amount, the expense side
    const creditTotals = new Map(); // accountId -> amount, the liability side
    const add = (map, accountId, amount) => { if (amount) map.set(String(accountId), round2((map.get(String(accountId)) || 0) + amount)); };

    for (const e of paid) {
      add(debitTotals, expense._id, e.slip.grossPay);
      for (const earn of e.slip.earnings) {
        const comp = earn.componentId && byComponentId.get(String(earn.componentId));
        add(debitTotals, comp?.accountId || expense._id, earn.amount);
      }
      for (const ded of e.slip.deductions) {
        const comp = ded.componentId && byComponentId.get(String(ded.componentId));
        add(creditTotals, comp?.accountId || deductionsAccount._id, ded.amount);
      }
      add(creditTotals, payable._id, e.slip.netPay);
    }

    const accountIds = [...new Set([...debitTotals.keys(), ...creditTotals.keys()])];
    const accounts = await LedgerAccount.find({ _id: { $in: accountIds } }).select("accountName accountCode").session(session).lean();
    const byAccount = new Map(accounts.map((a) => [String(a._id), a]));

    const runId = new mongoose.Types.ObjectId();
    const voucherNo = await NumberSeriesService.allocate("PAY", built.payDate, { session });
    const d = new Date(built.payDate);
    const base = {
      voucherId: runId, voucherNo, voucherType: "payroll", date: built.payDate,
      referenceType: "payroll", referenceId: runId, referenceNo: voucherNo,
      month: d.getMonth() + 1, year: d.getFullYear(), financialYear: String(d.getFullYear()),
      createdBy: asAdminId(by), narration: `Payroll ${period}`,
    };
    const docs = [];
    for (const [accId, amount] of debitTotals) {
      const a = byAccount.get(accId);
      if (a) docs.push({ ...base, accountId: a._id, accountName: a.accountName, accountCode: a.accountCode, debitAmount: amount, creditAmount: 0 });
    }
    for (const [accId, amount] of creditTotals) {
      const a = byAccount.get(accId);
      if (a) docs.push({ ...base, accountId: a._id, accountName: a.accountName, accountCode: a.accountCode, debitAmount: 0, creditAmount: amount });
    }
    await writeEntries(docs, session);

    const [run] = await PayrollRun.create([{
      _id: runId, period, payDate: built.payDate, status: "POSTED",
      employeeCount: built.totals.employeeCount, totalGross: built.totals.gross, totalEarnings: built.totals.earnings,
      totalDeductions: built.totals.deductions, totalNet: built.totals.net,
      voucherNo, acknowledged: acknowledge || [], postedBy: by, createdBy: by,
    }], { session });

    await Payslip.insertMany(paid.map((e) => ({
      runId, period, staffId: e.staffId, staffName: e.staffName, branchId: e.branchId || "main",
      basicPay: e.slip.basicPay, grossPay: e.slip.grossPay, earnings: e.slip.earnings, deductions: e.slip.deductions,
      totalEarnings: e.slip.totalEarnings, totalDeductions: e.slip.totalDeductions, netPay: e.slip.netPay,
      proratedFactor: e.factor,
    })), { session });

    return { run, employeeCount: paid.length };
  });

  static reverse = withTransactionSession(async (id, { reason } = {}, by, session) => {
    const run = await PayrollRun.findById(id).session(session);
    if (!run) throw new AppError("Run not found", 404, "RUN_NOT_FOUND");
    if (run.status === "REVERSED") throw new AppError("Already reversed", 409, "ALREADY_REVERSED");
    await FiscalYearService.assertPostingAllowed(run.payDate, { session });
    const FinancialService = require("../financial/financialService");
    await FinancialService.reverseLedgerEntries(run._id, session);
    run.status = "REVERSED";
    run.reversedAt = new Date();
    run.reversedBy = by;
    run.reverseReason = reason;
    await run.save({ session });
    return run;
  });

  static list() {
    return PayrollRun.find().sort({ period: -1 }).lean();
  }

  static payslipsFor(runId) {
    return Payslip.find({ runId }).sort({ staffName: 1 }).lean();
  }

  static payslipsForStaff(staffId) {
    return Payslip.find({ staffId }).sort({ period: -1 }).lean();
  }
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

module.exports = PayrollService;
