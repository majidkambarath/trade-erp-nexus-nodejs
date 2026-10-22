const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");
const AccountGroupService = require("../../services/financial/accountGroupService");
const AccountConfigService = require("../../services/financial/accountConfigService");
const FiscalYearService = require("../../services/core/fiscalYearService");
const YearEndService = require("../../services/financial/yearEndService");
const PeriodCloseService = require("../../services/financial/periodCloseService");
const NumberSeriesService = require("../../services/core/numberSeriesService");
const VoucherTypeService = require("../../services/core/voucherTypeService");
const NumberRegisterService = require("../../services/core/numberRegisterService");
const PostingService = require("../../services/financial/postingService");
const AuditService = require("../../services/core/auditService");

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// --- account groups ---
exports.listGroups = catchAsync(async (req, res) => ok(res, await AccountGroupService.list(req)));
exports.createGroup = catchAsync(async (req, res) => {
  const { name, prefix, category } = req.body;
  if (!name || !prefix || !category) throw new AppError("name, prefix and category are required", 400);
  ok(res, await AccountGroupService.create(req.body, req), 201);
});
exports.updateGroup = catchAsync(async (req, res) =>
  ok(res, await AccountGroupService.update(req.params.id, req.body, req))
);
exports.mintAccountCode = catchAsync(async (req, res) =>
  ok(res, { accountCode: await AccountGroupService.generateNextAccountCode(req.params.id) })
);

// --- account configuration (the posting map) ---
exports.getConfiguration = catchAsync(async (req, res) => ok(res, await AccountConfigService.getConfiguration(req)));
exports.updateConfiguration = catchAsync(async (req, res) => {
  const result = await AccountConfigService.updateMappings(req.body.mappings, req);
  await AuditService.log({ req, action: "ACCOUNT_MAPPING_CHANGED", entity: "CompanySettings",
    summary: (req.body.mappings || []).map((m) => m.configKey).join(", "), after: req.body.mappings });
  ok(res, result);
});
exports.setPosting = catchAsync(async (req, res) => {
  const result = await AccountConfigService.setPostingEnabled(req.body.enabled === true, req);
  // Documents approved while posting was off get their entries now.
  const catchUp = result.ledgerPostingEnabled ? await PostingService.catchUp({ createdBy: req.admin?.id }) : null;
  await AuditService.log({ req, action: result.ledgerPostingEnabled ? "LEDGER_POSTING_ENABLED" : "LEDGER_POSTING_DISABLED", entity: "CompanySettings",
    summary: catchUp ? `${catchUp.posted} earlier document(s) posted${catchUp.failed.length ? `, ${catchUp.failed.length} could not be` : ""}` : undefined });
  ok(res, { ...result, catchUp });
});
exports.getReadiness = catchAsync(async (req, res) => ok(res, await AccountConfigService.getReadiness(req)));

// --- fiscal years ---
exports.listFiscalYears = catchAsync(async (req, res) => ok(res, await FiscalYearService.list(req)));
exports.createFiscalYear = catchAsync(async (req, res) => {
  const { code, startDate, endDate } = req.body;
  if (!code || !startDate || !endDate) throw new AppError("code, startDate and endDate are required", 400);
  const fy = await FiscalYearService.create(req.body, req);
  await AuditService.log({ req, action: "FISCAL_YEAR_CREATED", entity: "FiscalYear", entityId: fy._id, summary: fy.code });
  ok(res, fy, 201);
});
// Closing and reopening a year do more than flip a lock (services/financial/yearEndService.js): they post and
// reverse the closing entry, create the next year, and write their own audit rows.
exports.yearEnd = catchAsync(async (req, res) => ok(res, await YearEndService.preview(req.params.id, req)));
exports.closeFiscalYear = catchAsync(async (req, res) => ok(res, await YearEndService.close(req.params.id, { acknowledge: req.body?.acknowledge }, req)));
exports.reopenFiscalYear = catchAsync(async (req, res) => ok(res, await YearEndService.reopen(req.params.id, req)));
// Months inside an open year (services/financial/periodCloseService.js): a lock, with its own checks, audit rows and order.
exports.fiscalYearMonths = catchAsync(async (req, res) => ok(res, await PeriodCloseService.months(req.params.id)));
exports.monthEnd = catchAsync(async (req, res) => ok(res, await PeriodCloseService.preview(req.params.id, req.params.month)));
exports.closeMonth = catchAsync(async (req, res) => ok(res, await PeriodCloseService.close(req.params.id, req.params.month, { acknowledge: req.body?.acknowledge }, req)));
exports.reopenMonth = catchAsync(async (req, res) => ok(res, await PeriodCloseService.reopen(req.params.id, req.params.month, req)));

// --- number series ---
exports.listNumberSeries = catchAsync(async (req, res) => ok(res, await NumberSeriesService.list(req, { series: req.query.series })));

// --- voucher types: how every kind of document is named and numbered ---
exports.listVoucherTypes = catchAsync(async (req, res) =>
  ok(res, {
    types: await VoucherTypeService.list(req, { kind: req.query.kind, active: req.query.active, q: req.query.q }),
    branches: await VoucherTypeService.branches(req),
  })
);
exports.createVoucherType = catchAsync(async (req, res) => {
  const made = await VoucherTypeService.create(req.body, req);
  await AuditService.log({ req, action: "VOUCHER_TYPE_CREATED", entity: "VoucherType", entityId: made._id, summary: made.name + " (" + made.key + ")", after: made });
  ok(res, made, 201);
});
exports.updateVoucherType = catchAsync(async (req, res) => {
  const before = await VoucherTypeService.get(req.params.key, req);
  const saved = await VoucherTypeService.update(req.params.key, req.body, req);
  await AuditService.log({ req, action: "VOUCHER_TYPE_UPDATED", entity: "VoucherType", entityId: saved._id, summary: saved.name + " (" + saved.key + ")", before, after: saved });
  ok(res, saved);
});
exports.removeVoucherType = catchAsync(async (req, res) => {
  const gone = await VoucherTypeService.remove(req.params.key, req);
  await AuditService.log({ req, action: "VOUCHER_TYPE_DELETED", entity: "VoucherType", entityId: null, summary: gone.name + " (" + gone.key + ")", before: gone });
  ok(res, gone);
});
exports.voucherTypeUsage = catchAsync(async (req, res) => ok(res, await VoucherTypeService.usage(req.params.key, req)));

// --- the register of numbers given out, and whether a sequence is unbroken ---
exports.numberRegister = catchAsync(async (req, res) =>
  ok(res, {
    ...(await NumberRegisterService.list(req, req.query)),
    summary: await NumberRegisterService.summary(req, { series: req.query.series }),
  })
);
exports.numberGaps = catchAsync(async (req, res) => ok(res, await NumberRegisterService.gaps(req, req.query)));
