const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");
const AccountGroupService = require("../../services/financial/accountGroupService");
const AccountConfigService = require("../../services/financial/accountConfigService");
const FiscalYearService = require("../../services/core/fiscalYearService");
const YearEndService = require("../../services/financial/yearEndService");
const NumberSeriesService = require("../../services/core/numberSeriesService");
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

// --- number series ---
exports.listNumberSeries = catchAsync(async (req, res) => ok(res, await NumberSeriesService.list(req)));
