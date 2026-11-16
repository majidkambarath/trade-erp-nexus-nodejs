const catchAsync = require("../../utils/catchAsync");
const OnboardingService = require("../../services/core/onboardingService");

exports.checklist = catchAsync(async (req, res) => {
  res.status(200).json({ success: true, data: await OnboardingService.checklist(req) });
});
