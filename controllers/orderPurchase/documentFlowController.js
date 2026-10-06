const DocumentFlowService = require("../../services/orderPurchase/documentFlowService");
const catchAsync = require("../../utils/catchAsync");

// One customer's quotations, orders and delivery notes, joined into deals.
exports.customer = catchAsync(async (req, res) => {
  res.status(200).json({ success: true, data: await DocumentFlowService.forCustomer(req.params.id) });
});
