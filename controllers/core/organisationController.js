const catchAsync = require("../../utils/catchAsync");
const UsageService = require("../../services/core/usageService");

// Who the caller's organisation is, what its plan switches on, what it has used, and where its subscription
// stands. The screens use it to hide what the plan does not include and to warn before a subscription ends.
exports.status = catchAsync(async (req, res) => {
  res.status(200).json({ success: true, data: await UsageService.status(req.organisation) });
});
