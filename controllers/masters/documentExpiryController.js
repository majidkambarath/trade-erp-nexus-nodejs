const catchAsync = require("../../utils/catchAsync");
const DocumentExpiryService = require("../../services/masters/documentExpiryService");
const { assertPermission } = require("../../middleware/permissionGate");

// GET /api/v1/document-expiry?withinDays=30&partyType=customer|vendor|staff&includeInactive=true
//
// Open to sales, purchase and accounts (routes/masters/documentExpiryRoutes.js) for the documents of customers and vendors. With no
// partyType it lists those two and nothing else. An employee's documents are HR's: asking for `staff` by name needs hr.view, the same
// permission as an employee's own documents screen.
exports.list = catchAsync(async (req, res) => {
  const { withinDays, partyType, includeInactive } = req.query;
  if (String(partyType || "").toLowerCase() === "staff") assertPermission(req, "hr.view");
  const data = await DocumentExpiryService.list({ withinDays, partyType, includeInactive: includeInactive === "true" });
  res.json({ success: true, data });
});
