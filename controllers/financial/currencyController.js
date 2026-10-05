const catchAsync = require("../../utils/catchAsync");
const CurrencyService = require("../../services/financial/currencyService");
const FxVoucherService = require("../../services/financial/fxVoucherService");
const AppError = require("../../utils/AppError");

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// The currency master and its rate history.
exports.list = catchAsync(async (req, res) => ok(res, await CurrencyService.list(req)));
exports.create = catchAsync(async (req, res) => ok(res, await CurrencyService.create(req.body, req), 201));
exports.update = catchAsync(async (req, res) => ok(res, await CurrencyService.update(req.params.code, req.body, req)));
exports.remove = catchAsync(async (req, res) => ok(res, await CurrencyService.remove(req.params.code, req)));

exports.rates = catchAsync(async (req, res) => ok(res, await CurrencyService.rateHistory(req.params.code, req, req.query)));
exports.addRate = catchAsync(async (req, res) => ok(res, await CurrencyService.addRate(req.params.code, req.body, req), 201));

// The rate a voucher dated `date` would be made at, with the tolerance the form checks a typed rate against.
exports.rate = catchAsync(async (req, res) => {
  if (!req.query.code) throw new AppError("Say which currency (code=USD)", 400, "INVALID_CURRENCY_CODE");
  const [found, settings, currency] = await Promise.all([
    CurrencyService.rateOn(req.query.code, req.query.date, { req }),
    CurrencyService.getSettings(req),
    CurrencyService.get(req.query.code, { req }),
  ]);
  ok(res, {
    code: found.code, date: found.forDay, rate: found.rate, rateDate: found.rateDay, source: found.source,
    isActive: currency ? currency.isActive : false, decimals: currency?.decimals ?? 2, symbol: currency?.symbol || "",
    tolerancePercent: settings.fxTolerancePercent,
  });
});

exports.getSettings = catchAsync(async (req, res) => ok(res, await CurrencyService.getSettings(req)));
exports.updateSettings = catchAsync(async (req, res) => ok(res, await CurrencyService.updateSettings(req.body, req)));

// Foreign-currency receipts and payments in a period.
exports.register = catchAsync(async (req, res) => ok(res, await FxVoucherService.register(req, req.query)));
