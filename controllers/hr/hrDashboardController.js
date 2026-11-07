const HrDashboardService = require("../../services/hr/hrDashboardService");
const catchAsync = require("../../utils/catchAsync");
const rules = require("../../utils/hrDashboard");
const roles = require("../../utils/permissions");

// Who may see a figure. `hr.confidential` is NOT the route's gate - the same request answers differently
// depending on who asked, exactly as contracts.list, the gratuity preview and the payroll plan already do.
const confidential = (req) => roles.can(req.admin.grants, "hr.confidential");

exports.overview = catchAsync(async (req, res) => {
  const data = await HrDashboardService.overview({ month: req.query.month, months: req.query.months });
  res.status(200).json({ success: true, data: rules.forReader(data, confidential(req)) });
});
