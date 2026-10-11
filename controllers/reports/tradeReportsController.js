const catchAsync = require("../../utils/catchAsync");
const TradeReports = require("../../services/reports/tradeReportsService");

const ok = (res, data) => res.status(200).json({ success: true, data });
const flag = (v) => v === true || v === "true" || v === "1";

exports.summary = catchAsync(async (req, res) =>
  ok(res, await TradeReports.summary({
    direction: req.query.direction, from: req.query.from, to: req.query.to, groupBy: req.query.groupBy,
    partyId: req.query.partyId, itemId: req.query.itemId, categoryId: req.query.categoryId, search: req.query.search,
    monthly: flag(req.query.monthly),
  })));

exports.register = catchAsync(async (req, res) =>
  ok(res, await TradeReports.register({
    direction: req.query.direction, from: req.query.from, to: req.query.to,
    partyId: req.query.partyId, itemId: req.query.itemId, categoryId: req.query.categoryId, search: req.query.search,
    page: req.query.page, limit: req.query.limit,
  })));

exports.partyMovement = catchAsync(async (req, res) =>
  ok(res, await TradeReports.partyMovement({
    type: req.query.type, from: req.query.from, to: req.query.to, search: req.query.search, includeZero: flag(req.query.includeZero),
  })));
