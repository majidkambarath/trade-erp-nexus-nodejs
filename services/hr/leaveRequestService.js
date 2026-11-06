const LeaveRequest = require("../../models/modules/hr/leaveRequestModel");
const LeaveType = require("../../models/modules/hr/leaveTypeModel");
const Staff = require("../../models/modules/staffModel");
const AppError = require("../../utils/AppError");
const rules = require("../../utils/leave");
const hr = require("../../utils/hr");
const ApprovalPolicyService = require("../core/approvalPolicyService");
const NumberSeriesService = require("../core/numberSeriesService");
const AttendanceService = require("./attendanceService");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { todayInOrg, orgDay } = require("../../utils/documentExpiry");

/**
 * Leave requests. Judged by ApprovalPolicyService.judge, the SAME function a trade document or a voucher
 * is judged by (D13) - with `amount: 0`, so a role's MONEY limit (utils/approvalRules.js) never blocks a
 * leave approval, while `separateApprover` still means exactly what it already means: whoever submitted a
 * request is not the one who decides it.
 */
class LeaveRequestService {
  static async submit(data, by) {
    const errors = rules.validateLeaveRequest(data);
    if (errors.length) throw new AppError(errors[0].message, 400, errors[0].code, { errors, field: errors[0].field });

    return withTransactionSession(async (session) => {
      const [staff, leaveType] = await Promise.all([
        Staff.findById(data.staffId).select("name staffId").session(session),
        LeaveType.findById(data.leaveTypeId).select("name").session(session),
      ]);
      if (!staff) throw new AppError("Employee not found", 404, "STAFF_NOT_FOUND");
      if (!leaveType) throw new AppError("Leave type not found", 404, "LEAVE_TYPE_NOT_FOUND");

      const requestNo = await NumberSeriesService.allocate("LV", new Date(data.fromDay), { session });
      const [created] = await LeaveRequest.create(
        [{
          requestNo, staffId: staff._id, staffName: staff.name, leaveTypeId: leaveType._id, leaveTypeName: leaveType.name,
          fromDay: data.fromDay, toDay: data.toDay, reason: data.reason, status: "PENDING", createdBy: by,
        }],
        { session }
      );
      return created;
    })();
  }

  /** The balance today - accrued since joining, less what approved-and-live requests have consumed. Reuses
   * utils/leave.js leaveBalance (D13's own derive-not-store rule): a stored figure drifts the moment a
   * request is corrected after the fact. */
  static async balance(staffId, leaveTypeId, { day } = {}) {
    const [staff, requests] = await Promise.all([
      Staff.findById(staffId).select("joiningDate").lean(),
      LeaveRequest.find({ staffId, leaveTypeId }).select("status fromDay toDay cancelledAt").lean(),
    ]);
    const leaveType = await LeaveType.findById(leaveTypeId).select("accrualPerMonth").lean();
    if (!staff || !leaveType) return null;
    return rules.leaveBalance({
      // orgDay(), never String(date).slice(0, 10) - a real Mongo Date's string form is "Fri Nov 06
      // 2026", not an ISO day (the exact mistake already found and fixed in gratuityService.js today).
      joiningDay: staff.joiningDate ? orgDay(staff.joiningDate) : null,
      today: day || todayInOrg(), accrualPerMonth: leaveType.accrualPerMonth, requests,
    });
  }

  static list({ staffId, status } = {}) {
    const q = {};
    if (staffId) q.staffId = staffId;
    if (status) q.status = status;
    return LeaveRequest.find(q).sort({ createdAt: -1 }).limit(500).lean();
  }

  static get(id) {
    return LeaveRequest.findById(id).lean();
  }

  static decide = withTransactionSession(async (id, { action, reason } = {}, req, session) => {
    const row = await LeaveRequest.findById(id).session(session);
    if (!row) throw new AppError("Request not found", 404, "REQUEST_NOT_FOUND");
    if (row.status !== "PENDING") throw new AppError(`This request is already ${row.status.toLowerCase()}`, 409, "NOT_PENDING");

    if (action === "reject") {
      row.status = "REJECTED";
      row.rejectReason = reason;
      row.decidedBy = req.admin?.id;
      row.decidedAt = new Date();
      await row.save({ session });
      return row;
    }

    const verdict = await ApprovalPolicyService.judge({ amount: 0, preparedBy: row.createdBy, approvals: row.approvals, req, session });
    if (verdict.approval) row.approvals = [...(row.approvals || []), verdict.approval];
    if (verdict.final) {
      row.status = "APPROVED";
      row.decidedBy = req.admin?.id;
      row.decidedAt = new Date();
    }
    await row.save({ session });
    return row;
  });

  static cancel = withTransactionSession(async (id, by, session) => {
    const row = await LeaveRequest.findById(id).session(session);
    if (!row) throw new AppError("Request not found", 404, "REQUEST_NOT_FOUND");
    if (row.status === "CANCELLED") throw new AppError("Already cancelled", 409, "ALREADY_CANCELLED");
    row.status = "CANCELLED";
    row.cancelledAt = new Date();
    row.cancelledBy = by;
    await row.save({ session });
    return row;
  });
}

module.exports = LeaveRequestService;
