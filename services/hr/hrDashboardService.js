const Staff = require("../../models/modules/staffModel");
const AttendanceDay = require("../../models/modules/hr/attendanceDayModel");
const LeaveRequest = require("../../models/modules/hr/leaveRequestModel");
const PayrollRun = require("../../models/modules/hr/payrollRunModel");
const Payslip = require("../../models/modules/hr/payslipModel");
const StaffChecklistItem = require("../../models/modules/hr/staffChecklistModel");
const StaffService = require("../staff/staffService");
const ContractService = require("./contractService");
const GratuityService = require("./gratuityService");
const EmiratisationService = require("./emiratisationService");
const DocumentExpiryService = require("../masters/documentExpiryService");
const { DepartmentService } = require("./timeSetupService");
const rules = require("../../utils/hrDashboard");
const orgLocale = require("../../utils/orgLocale");
const { orgDay, todayInOrg } = require("../../utils/documentExpiry");

/**
 * The HR MIS dashboard: one read that answers the whole Overview screen.
 *
 * NOTHING HERE INVENTS A FIGURE. Every number is either read from the service that owns it
 * (ContractService.coverage, GratuityService, EmiratisationService, DocumentExpiryService,
 * StaffService.getStaffStats) or comes from one grouped query below that uses the same definitions - so a
 * card on this screen can never disagree with the page it links to. The arithmetic that shapes them lives
 * in utils/hrDashboard.js as pure functions, hung on this class as statics so it is tested without Mongo:
 * the same split services/reports/dashboardService.js already uses.
 *
 * The reader split is NOT here. `hr.confidential` is never a route gate for a read - the same request
 * answers differently depending on who asked - so the controller shapes the response with
 * rules.forReader(data, confidential). See the comment in routes/hr/complianceRoutes.js.
 */

// Most HR date fields are ALREADY "YYYY-MM-DD" / "YYYY-MM" strings (AttendanceDay.day,
// LeaveRequest.fromDay/toDay, PayrollRun.period, Payslip.period), so they bucket with a plain string
// comparison and need no timezone at all. Only the real Dates - Staff.joiningDate/exitDate - go through
// orgDay(), and never String(date).slice(0, 10).
const monthOf = (day) => String(day || "").slice(0, 7);

/** The attendance split for one month, as one grouped pass. */
async function attendanceFor(month) {
  const rows = await AttendanceDay.aggregate([
    { $match: { day: { $regex: `^${month}-` } } },
    { $group: { _id: "$status", count: { $sum: 1 }, hours: { $sum: { $ifNull: ["$hoursWorked", 0] } }, overtime: { $sum: { $ifNull: ["$overtimeHours", 0] } } } },
  ]);
  return rules.attendanceSplit(rows.map((r) => ({ status: r._id, count: r.count, hours: r.hours, overtime: r.overtime })));
}

/** Who is on approved leave today, and what is still waiting to be decided. */
async function leaveNow(today) {
  const [onLeave, pending] = await Promise.all([
    LeaveRequest.countDocuments({ status: "APPROVED", fromDay: { $lte: today }, toDay: { $gte: today } }),
    LeaveRequest.countDocuments({ status: "PENDING" }),
  ]);
  return { onLeaveToday: onLeave, pending };
}

/**
 * Payroll cost per department for a month. Payslip carries no departmentId, so this joins to Staff in
 * code - a Map rather than a $lookup, which is cheaper and keeps the department fallback rules in one
 * place (utils/hrDashboard.js byDepartment).
 */
async function costByDepartment(month) {
  const slips = await Payslip.find({ period: month }).select("staffId grossPay").lean();
  if (!slips.length) return [];
  const staff = await Staff.find({ _id: { $in: [...new Set(slips.map((s) => String(s.staffId)))] } })
    .select("department departmentId")
    .lean();
  const by = new Map(staff.map((s) => [String(s._id), s]));
  return rules.byDepartment(
    slips.map((s) => ({ ...by.get(String(s.staffId)), gross: s.grossPay })),
    { amountOf: (r) => r.gross }
  );
}

/** Headcount by department, over the people actually on the books. */
async function headcountByDepartment() {
  const staff = await Staff.find({ status: "Active" }).select("department departmentId").lean();
  return rules.byDepartment(staff);
}

/** Onboarding and exit items somebody still owes, and how many are late. */
async function checklistLoad(today) {
  const rows = await StaffChecklistItem.aggregate([
    { $match: { status: "OPEN" } },
    { $group: { _id: "$listType", open: { $sum: 1 }, late: { $sum: { $cond: [{ $and: [{ $ne: ["$dueAt", null] }, { $lt: ["$dueAt", today] }] }, 1, 0] } } } },
  ]);
  const out = { onboarding: { open: 0, late: 0 }, exit: { open: 0, late: 0 } };
  for (const r of rows) if (out[r._id]) out[r._id] = { open: r.open, late: r.late };
  return out;
}

class HrDashboardService {
  // the shaping, exposed so the arithmetic is tested without a database
  static resolvePeriod = rules.resolvePeriod;
  static headcountFlow = rules.headcountFlow;
  static byDepartment = rules.byDepartment;
  static attendanceSplit = rules.attendanceSplit;
  static costByMonth = rules.costByMonth;
  static labourFlow = rules.labourFlow;
  static forReader = rules.forReader;

  /**
   * The whole screen. One Promise.all rather than sequential awaits, as the trade dashboard does.
   * `query` takes `{ month, months }`; the period always ends today for the month in progress.
   */
  static async overview(query = {}) {
    const today = todayInOrg();
    const p = rules.resolvePeriod(query, today);

    const [stats, coverage, staffDates, attendance, leave, runs, byDept, headByDept, gratuityRows, emiratisation, documents, checklists, departments] =
      await Promise.all([
        StaffService.getStaffStats(),
        ContractService.coverage({ day: today }),
        // joiningDate / exitDate are real Dates: the only fields here that need orgDay()
        Staff.find({}).select("joiningDate exitDate").lean(),
        attendanceFor(p.month),
        leaveNow(today),
        PayrollRun.find({ status: "POSTED" }).sort({ period: -1 }).select("period status totalGross totalNet totalDeductions employeeCount").lean(),
        costByDepartment(p.month),
        headcountByDepartment(),
        GratuityService.list(),
        EmiratisationService.status({ day: today }),
        DocumentExpiryService.list({ partyType: "staff", withinDays: 30 }),
        checklistLoad(today),
        // Only to put a NAME on a department bucket keyed by its id. A missing master is not a
        // failed dashboard: the bucket keeps whatever name its rows carried.
        DepartmentService.list().catch(() => []),
      ]);

    const byMonth = rules.costByMonth(runs, p.months);
    const thisMonth = byMonth.at(-1) || { gross: 0, employees: 0, ran: false };
    const previous = byMonth.at(-2) || { gross: 0 };
    const liveGratuity = (gratuityRows || []).find((g) => !g.reversedAt) || null;
    const names = new Map((departments || []).map((d) => [String(d._id), d.name]));
    const named = (rows) => rows.map((r) => ({ ...r, name: names.get(r.key) || r.name }));

    return {
      currency: orgLocale.baseCurrency(),
      period: { month: p.month, from: p.from, to: p.to, months: p.months, previousMonth: p.previousMonth },
      generatedAt: new Date().toISOString(),
      confidential: true, // the controller turns this off and strips, never the other way round
      headcount: {
        active: stats?.activeStaff || 0,
        total: stats?.totalStaff || 0,
        inactive: stats?.inactiveStaff || 0,
        costed: coverage?.costed || 0,
        missingCostRate: coverage?.missing?.length || 0,
        missing: coverage?.missing || [],
        byDepartment: named(headByDept),
        flow: rules.headcountFlow(staffDates, p.months, { dayOf: orgDay }),
      },
      attendance,
      leave,
      cost: {
        byMonth,
        thisMonth: thisMonth.gross,
        previousMonth: previous.gross,
        changePct: rules.change(thisMonth.gross, previous.gross),
        ran: thisMonth.ran,
        employees: thisMonth.employees,
        perEmployee: thisMonth.employees > 0 ? thisMonth.gross / thisMonth.employees : null,
        byDepartment: named(byDept),
      },
      // Labour on work costed in the period is its own read and its own wave - see the note in
      // utils/hrDashboard.js labourFlow for why there is no organisation-wide idle figure to show yet.
      labour: rules.labourFlow({}),
      gratuity: liveGratuity
        ? { liability: liveGratuity.cumulativeLiability, month: liveGratuity.month, employeeCount: liveGratuity.employeeCount, missingCount: 0 }
        : null,
      emiratisation,
      documents: documents?.summary || { expired: 0, expiringSoon: 0, total: 0 },
      checklists,
    };
  }
}

module.exports = HrDashboardService;
