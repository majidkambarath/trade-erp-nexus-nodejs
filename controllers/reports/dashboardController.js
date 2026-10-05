const catchAsync = require("../../utils/catchAsync");
const DashboardService = require("../../services/reports/dashboardService");

// ?period=week|month|quarter, or ?month=YYYY-MM, or ?from=&to=. One part per tab of the dashboard.
const part = (name) =>
  catchAsync(async (req, res) => {
    const { period, month, from, to } = req.query;
    res.status(200).json({ success: true, data: await DashboardService[name]({ period, month, from, to }) });
  });

exports.summary = part("summary");
exports.analytics = part("analytics");
exports.sales = part("sales");
exports.inventory = part("inventory");
exports.reports = part("reports");
