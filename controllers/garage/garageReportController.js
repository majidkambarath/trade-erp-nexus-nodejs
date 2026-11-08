const GarageReportService = require("../../services/garage/garageReportService");
const catchAsync = require("../../utils/catchAsync");

const ok = (res, data) => res.status(200).json({ success: true, data });

exports.overview = catchAsync(async (req, res) => ok(res, await GarageReportService.overview(req.query)));
exports.workInProgress = catchAsync(async (req, res) => ok(res, await GarageReportService.workInProgress()));
exports.profit = catchAsync(async (req, res) => ok(res, await GarageReportService.profit(req.query)));
exports.people = catchAsync(async (req, res) => ok(res, await GarageReportService.peopleAndBays(req.query)));
exports.customers = catchAsync(async (req, res) => ok(res, await GarageReportService.customers(req.query)));
exports.vehicles = catchAsync(async (req, res) => ok(res, await GarageReportService.vehicles()));
exports.insurers = catchAsync(async (req, res) => ok(res, await GarageReportService.insurers(req.query)));
