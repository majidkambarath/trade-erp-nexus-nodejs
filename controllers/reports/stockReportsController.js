const catchAsync = require("../../utils/catchAsync");
const StockReports = require("../../services/reports/stockReportsService");

const ok = (res, data) => res.status(200).json({ success: true, data });
const flag = (v) => v === true || v === "true" || v === "1";

exports.lookups = catchAsync(async (req, res) => ok(res, await StockReports.lookups()));

exports.valuation = catchAsync(async (req, res) =>
  ok(res, await StockReports.valuation({
    asOn: req.query.asOn, categoryId: req.query.categoryId, search: req.query.search,
    groupBy: req.query.groupBy, includeZero: flag(req.query.includeZero),
  })));

exports.movement = catchAsync(async (req, res) =>
  ok(res, await StockReports.movement({
    from: req.query.from, to: req.query.to, categoryId: req.query.categoryId, search: req.query.search, includeZero: flag(req.query.includeZero),
  })));

exports.itemLedger = catchAsync(async (req, res) =>
  ok(res, await StockReports.itemLedger({ itemId: req.query.itemId, from: req.query.from, to: req.query.to })));

exports.salesAnalysis = catchAsync(async (req, res) =>
  ok(res, await StockReports.salesAnalysis({
    from: req.query.from, to: req.query.to, groupBy: req.query.groupBy, direction: req.query.direction,
    categoryId: req.query.categoryId, search: req.query.search,
  })));

exports.expiry = catchAsync(async (req, res) =>
  ok(res, await StockReports.expiry({ withinDays: req.query.withinDays, categoryId: req.query.categoryId, search: req.query.search })));

exports.slowMoving = catchAsync(async (req, res) =>
  ok(res, await StockReports.slowMoving({ days: req.query.days, categoryId: req.query.categoryId, search: req.query.search })));

exports.reorder = catchAsync(async (req, res) =>
  ok(res, await StockReports.reorder({ categoryId: req.query.categoryId, search: req.query.search })));
