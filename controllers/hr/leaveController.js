const LeaveRequestService = require("../../services/hr/leaveRequestService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

exports.list = catchAsync(async (req, res) => ok(res, await LeaveRequestService.list(req.query)));
exports.get = catchAsync(async (req, res) => ok(res, await LeaveRequestService.get(req.params.id)));

exports.balance = catchAsync(async (req, res) =>
  ok(res, await LeaveRequestService.balance(req.query.staffId, req.query.leaveTypeId, { day: req.query.day }))
);

exports.submit = catchAsync(async (req, res) => {
  const row = await LeaveRequestService.submit(req.body, by(req));
  await AuditService.log({ req, action: "LEAVE_REQUEST_SUBMITTED", entity: "LeaveRequest", entityId: row._id, summary: `${row.requestNo}: ${row.fromDay} to ${row.toDay}` });
  ok(res, row, 201);
});

// Approve/reject goes through ApprovalPolicyService.judge exactly as a trade document or a voucher does
// (D13) - the queue, the limits and the separate-approver rule are the SAME code, not a parallel HR rule.
exports.decide = catchAsync(async (req, res) => {
  const row = await LeaveRequestService.decide(req.params.id, req.body, req);
  await AuditService.log({
    req,
    action: row.status === "APPROVED" ? "LEAVE_REQUEST_APPROVED" : row.status === "REJECTED" ? "LEAVE_REQUEST_REJECTED" : "LEAVE_REQUEST_FIRST_APPROVAL",
    entity: "LeaveRequest",
    entityId: row._id,
    summary: `${row.requestNo}: ${row.status}`,
  });
  ok(res, row);
});

exports.cancel = catchAsync(async (req, res) => {
  const row = await LeaveRequestService.cancel(req.params.id, by(req));
  await AuditService.log({ req, action: "LEAVE_REQUEST_CANCELLED", entity: "LeaveRequest", entityId: row._id, summary: row.requestNo });
  ok(res, row);
});
