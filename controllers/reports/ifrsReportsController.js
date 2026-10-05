const catchAsync = require("../../utils/catchAsync");
const IfrsReports = require("../../services/reports/ifrsReportsService");

const ok = (res, data) => res.status(200).json({ success: true, data });

// Every statement takes ?from=&to=&compare=prior-year|prior-period|none (the position and the
// notes take ?asAt= for the end date; `from` there only marks where "profit for the period"
// starts). Dates are YYYY-MM-DD, Dubai calendar days.
const query = (req) => ({ from: req.query.from, to: req.query.to, asAt: req.query.asAt, compare: req.query.compare });

exports.financialPosition = catchAsync(async (req, res) => ok(res, await IfrsReports.financialPosition(query(req))));
exports.profitOrLoss = catchAsync(async (req, res) => ok(res, await IfrsReports.profitOrLoss(query(req))));
exports.changesInEquity = catchAsync(async (req, res) => ok(res, await IfrsReports.changesInEquity(query(req))));
exports.cashFlows = catchAsync(async (req, res) => ok(res, await IfrsReports.cashFlows(query(req))));
exports.notes = catchAsync(async (req, res) => ok(res, await IfrsReports.notes(query(req))));
