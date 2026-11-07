const Staff = require("../../models/modules/staffModel");
const AttendanceDay = require("../../models/modules/hr/attendanceDayModel");
const LeaveType = require("../../models/modules/hr/leaveTypeModel");
const LeaveRequest = require("../../models/modules/hr/leaveRequestModel");
const AppError = require("../../utils/AppError");
const rules = require("../../utils/hrReports");
const { isCalendarDay, orgDay, todayInOrg } = require("../../utils/documentExpiry");

// A report is a read. Nothing in this file writes, posts or stamps anything - both figures it serves are
// derived on every call, for the reason utils/leave.js already states: a stored balance drifts the moment
// anything behind it is corrected after the fact.
const MAX_RANGE_DAYS = 400; // a year and a bit: a range nobody asked for is a scan nobody wanted

class HrReportService {
  // Exposed so a pure test and a caller name the same functions - the shape hrDashboardService uses.
  static attendanceSummary = rules.attendanceSummary;
  static leaveBalanceRows = rules.leaveBalanceRows;

  /**
   * A period's muster, per employee and in total.
   *
   * The counting is a `$group` in the database, keyed on (employee, status) - deliberately NOT a read of
   * the raw rows through AttendanceService.muster, which is capped and drops the EARLIEST days of a long
   * range (its own comment says so, and calls a silent wrong answer the worst failure a muster can have).
   * It is the same aggregation hrDashboardService's attendance tile already runs, one level more detailed,
   * so this report's totals equal the Overview's figure for the same month.
   */
  static async attendance({ from, to } = {}) {
    if (!isCalendarDay(from) || !isCalendarDay(to)) throw new AppError("Give both days as YYYY-MM-DD", 400, "INVALID_RANGE");
    if (to < from) throw new AppError("The last day cannot be before the first day", 400, "INVALID_RANGE");
    if (rules.daysInRange(from, to) > MAX_RANGE_DAYS) throw new AppError(`Ask for ${MAX_RANGE_DAYS} days or fewer`, 400, "RANGE_TOO_LONG");

    const [grouped, staff] = await Promise.all([
      AttendanceDay.aggregate([
        { $match: { day: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: { staffId: "$staffId", status: "$status" },
            count: { $sum: 1 },
            // $ifNull, because hoursWorked and overtimeHours are nullable on the model: summing a null
            // makes the whole total null in Mongo rather than skipping it.
            hours: { $sum: { $ifNull: ["$hoursWorked", 0] } },
            overtime: { $sum: { $ifNull: ["$overtimeHours", 0] } },
          },
        },
      ]),
      Staff.find({ status: "Active" }).select("_id name staffId designation department").sort({ name: 1 }).lean(),
    ]);

    return rules.attendanceSummary({
      rows: grouped.map((r) => ({ staffId: r._id.staffId, status: r._id.status, count: r.count, hours: r.hours, overtime: r.overtime })),
      staff, from, to,
    });
  }

  /**
   * Everybody's leave balance on a day, in every active leave type.
   *
   * Three reads whatever the headcount - not one call of LeaveRequestService.balance per employee per
   * type, which is where a report like this usually goes wrong. The arithmetic is that same function's
   * own pure rule (utils/leave.js leaveBalance), so a figure here and the figure on the employee's own
   * screen are the same figure.
   */
  static async leaveBalances({ day } = {}) {
    const on = day || todayInOrg();
    if (!isCalendarDay(on)) throw new AppError("Give the day as YYYY-MM-DD", 400, "INVALID_DAY");

    const [staff, leaveTypes] = await Promise.all([
      Staff.find({ status: "Active" }).select("_id name staffId joiningDate").sort({ name: 1 }).lean(),
      LeaveType.find({ isActive: true }).select("_id name accrualPerMonth isPaid isActive").sort({ name: 1 }).lean(),
    ]);
    // The WHOLE history for these people, every status: leaveBalance filters to APPROVED and
    // non-cancelled itself, and pre-filtering here would quietly take over what that function was
    // written to own (its own comment says so).
    const requests = staff.length
      ? await LeaveRequest.find({ staffId: { $in: staff.map((s) => s._id) } })
          .select("staffId leaveTypeId status fromDay toDay cancelledAt").lean()
      : [];

    return rules.leaveBalanceRows({
      // orgDay(), never String(date).slice(0, 10) - a Mongo Date's string form is "Fri Nov 06 2026". The
      // same conversion gratuityService and leaveRequestService already make at their own boundary.
      staff: staff.map((s) => ({ ...s, joiningDay: s.joiningDate ? orgDay(s.joiningDate) : null })),
      leaveTypes, requests, day: on,
    });
  }
}

HrReportService.MAX_RANGE_DAYS = MAX_RANGE_DAYS;

module.exports = HrReportService;
