const catchAsync = require("../../utils/catchAsync");
const ApprovalQueueService = require("../../services/core/approvalQueueService");

// What is waiting for the signed-in person's decision. Read-only: approving goes through the same routes as ever
// (PATCH /transactions/transactions/:id/process, PATCH /vouchers/vouchers/:id/approve), which judge every approve themselves.
const flag = (v) => ["1", "true", "yes"].includes(String(v ?? "").toLowerCase());

exports.waiting = catchAsync(async (req, res) => {
  const data = await ApprovalQueueService.waiting(req, { countOnly: flag(req.query.countOnly) });
  res.status(200).json({ success: true, data });
});
