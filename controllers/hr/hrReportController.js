const HrReportService = require("../../services/hr/hrReportService");
const catchAsync = require("../../utils/catchAsync");

const ok = (res, data) => res.status(200).json({ success: true, data });

// HRMS > Reports' two derived reports. Both are reads, so there is no AuditService.log here: an audit row
// per report opened is noise, and the trail exists for changes.
//
// Neither needs a forReader split, unlike gratuity and payroll next door: a muster and a leave balance
// carry no wage. What they DO carry is who was absent and who has leave left, which is why each is gated
// on its own key at the route (hr.attendance / hr.leave) rather than on hr.view - the clerk who keeps the
// directory tidy is not thereby somebody who reads the whole workforce's absence record.

exports.attendance = catchAsync(async (req, res) => ok(res, await HrReportService.attendance(req.query)));

exports.leaveBalances = catchAsync(async (req, res) => ok(res, await HrReportService.leaveBalances(req.query)));
