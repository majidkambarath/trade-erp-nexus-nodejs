const catchAsync = require("../../utils/catchAsync");
const LedgerReports = require("../../services/reports/ledgerReportsService");
const DefaultChartService = require("../../services/financial/defaultChartService");

const ok = (res, data) => res.status(200).json({ success: true, data });
const flag = (v) => v === true || v === "true" || v === "1";

// A report is only as complete as the ledger behind it. Before reading, make sure a company that
// never chose otherwise has ledger posting on and its earlier approved documents posted (at most
// once a minute), so a report is never empty just because nobody opened the chart first.
const read = (fn) =>
  catchAsync(async (req, res) => {
    await DefaultChartService.onOpenThrottled(req);
    ok(res, await fn(req));
  });

exports.generalLedger = read((req) =>
  LedgerReports.generalLedger({ from: req.query.from, to: req.query.to, category: req.query.category, includeZero: flag(req.query.includeZero), includeClosing: flag(req.query.includeClosing) }));

exports.profitAndLoss = read((req) => LedgerReports.profitAndLoss({ from: req.query.from, to: req.query.to }));

exports.dayBook = read((req) =>
  LedgerReports.dayBook({
    from: req.query.from, to: req.query.to, type: req.query.type, search: req.query.search,
    page: req.query.page, limit: req.query.limit, includeLines: flag(req.query.includeLines),
  }));

exports.voucherImpact = read((req) => LedgerReports.voucherImpact(req.params.id));

exports.cashBook = read((req) => LedgerReports.cashBook({ from: req.query.from, to: req.query.to, kind: req.query.kind }));

exports.cashFlow = read((req) => LedgerReports.cashFlow({ from: req.query.from, to: req.query.to }));

exports.partyBalances = read((req) =>
  LedgerReports.partyBalances({ type: req.query.type, asOn: req.query.asOn, includeZero: flag(req.query.includeZero) }));
