const catchAsync = require("../../utils/catchAsync");
const GstReturn = require("../../services/reports/gstReturnService");
const DefaultChartService = require("../../services/financial/defaultChartService");

const ok = (res, data) => res.status(200).json({ success: true, data });

// The return reads the ledger for its reconciliation: make sure earlier documents have reached it.
const live = (fn) =>
  catchAsync(async (req, res) => {
    await DefaultChartService.onOpenThrottled(req);
    ok(res, await fn(req));
  });

exports.gstr1 = live((req) => GstReturn.gstr1({ from: req.query.from, to: req.query.to }));
exports.gstr3b = live((req) => GstReturn.gstr3b({ from: req.query.from, to: req.query.to }));
