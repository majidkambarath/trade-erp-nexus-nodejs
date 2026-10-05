const catchAsync = require("../../utils/catchAsync");
const DocumentExpiryService = require("../../services/masters/documentExpiryService");

// GET /api/v1/document-expiry?withinDays=30&partyType=customer|vendor&includeInactive=true
exports.list = catchAsync(async (req, res) => {
  const { withinDays, partyType, includeInactive } = req.query;
  const data = await DocumentExpiryService.list({ withinDays, partyType, includeInactive: includeInactive === "true" });
  res.json({ success: true, data });
});
