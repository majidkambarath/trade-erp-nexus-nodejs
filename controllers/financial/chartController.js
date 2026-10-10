const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");
const fs = require("fs");
const ChartOfAccountsService = require("../../services/financial/chartOfAccountsService");
const TaxCodeService = require("../../services/financial/taxCodeService");
const AttachmentService = require("../../services/core/attachmentService");
const AccountConfigService = require("../../services/financial/accountConfigService");
const AgeingService = require("../../services/financial/ageingService");
const StatementService = require("../../services/financial/statementService");
const ReturnService = require("../../services/orderPurchase/returnService");
const AuditService = require("../../services/core/auditService");
const DefaultChartService = require("../../services/financial/defaultChartService");

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// --- chart of accounts ---
exports.getChart = catchAsync(async (req, res) => {
  // A company opening the chart for the first time starts from the default chart, not an empty page.
  await DefaultChartService.ensure(req);
  // customers/vendors get their accounts; posting is switched on (with earlier documents posted)
  await DefaultChartService.onOpenThrottled(req);
  ok(res, await ChartOfAccountsService.getChart(req, { asOf: req.query.asOf }));
});
// Adds back any default group or account that is missing. Never changes or removes anything.
exports.restoreDefaults = catchAsync(async (req, res) => {
  const made = await DefaultChartService.provision(req);
  await AuditService.log({ req, action: "DEFAULT_CHART_RESTORED", entity: "AccountGroup", summary: `${made.groups} groups, ${made.accounts} accounts added` });
  ok(res, made);
});
// The accounts a voucher may post to, flat and without balances: for the pickers on the voucher forms.
exports.listPostable = catchAsync(async (req, res) => {
  await DefaultChartService.ensure(req);
  ok(res, await ChartOfAccountsService.listPostable(req));
});
exports.createAccount = catchAsync(async (req, res) => {
  const account = await ChartOfAccountsService.createAccount(req.body, req, req.admin?.id);
  await AuditService.log({ req, action: "ACCOUNT_CREATED", entity: "LedgerAccount", entityId: account._id,
    summary: `${account.accountCode} ${account.accountName}`, after: { groupId: account.groupId, openingBalance: account.openingBalance, openingSide: account.openingSide } });
  ok(res, account, 201);
});
exports.updateAccount = catchAsync(async (req, res) => {
  const account = await ChartOfAccountsService.updateAccount(req.params.id, req.body, req);
  await AuditService.log({ req, action: "ACCOUNT_UPDATED", entity: "LedgerAccount", entityId: account._id,
    summary: `${account.accountCode} ${account.accountName}`, after: req.body });
  ok(res, account);
});
exports.getAccountLedger = catchAsync(async (req, res) =>
  ok(res, await ChartOfAccountsService.getLedger(req.params.id, { from: req.query.from, to: req.query.to }))
);

// --- tax codes ---
exports.listTaxCodes = catchAsync(async (req, res) => {
  await DefaultChartService.topUpTaxCodes(req); // an older company gets the reverse-charge starter once
  ok(res, await TaxCodeService.list(req));
});
exports.createTaxCode = catchAsync(async (req, res) => {
  if (!req.body.name || req.body.ratePercent === undefined) throw new AppError("name and ratePercent are required", 400);
  const code = await TaxCodeService.create(req.body, req);
  await AuditService.log({ req, action: "TAX_CODE_CREATED", entity: "TaxCode", entityId: code._id, summary: `${code.name} ${code.ratePercent}%` });
  ok(res, code, 201);
});
exports.updateTaxCode = catchAsync(async (req, res) => {
  const code = await TaxCodeService.update(req.params.id, req.body, req);
  await AuditService.log({ req, action: "TAX_CODE_UPDATED", entity: "TaxCode", entityId: code._id, summary: `${code.name} ${code.ratePercent}%`, after: req.body });
  ok(res, code);
});

// --- attachments ---
exports.uploadAttachment = catchAsync(async (req, res) => {
  const a = await AttachmentService.save(req.file, { uploadedBy: req.admin?.id, label: req.body.label, req });
  const ref = AttachmentService.toRef(a);
  // Optionally attach in the same request: { ownerType, ownerId }
  if (req.body.ownerType && req.body.ownerId) {
    await AttachmentService.link(a._id, { ownerType: req.body.ownerType, ownerId: req.body.ownerId, label: req.body.label }, req);
  }
  ok(res, ref, 201);
});
exports.linkAttachment = catchAsync(async (req, res) => ok(res, await AttachmentService.link(req.params.id, req.body, req)));
exports.listAttachments = catchAsync(async (req, res) => {
  const { ownerType, ownerId } = req.query;
  if (!ownerType || !ownerId) throw new AppError("ownerType and ownerId are required", 400);
  const rows = await AttachmentService.listFor(ownerType, ownerId, req);
  ok(res, rows.map((a) => ({ ...AttachmentService.toRef(a), label: a.label, uploadedAt: a.createdAt })));
});
exports.downloadAttachment = catchAsync(async (req, res) => {
  const a = await AttachmentService.get(req.params.id, req);
  const file = AttachmentService.filePath(a);
  if (!fs.existsSync(file)) throw new AppError("File is missing on the server", 410);
  res.setHeader("Content-Type", a.mimeType);
  // nosniff + attachment: the browser downloads it rather than interpreting it
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `${req.query.inline === "1" && a.mimeType !== "text/html" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.originalName)}`);
  fs.createReadStream(file).pipe(res);
});
exports.deleteAttachment = catchAsync(async (req, res) => {
  await AttachmentService.remove(req.params.id, req);
  ok(res, { deleted: true });
});

// --- settings (credit control, returns, company profile) ---
exports.getSettings = catchAsync(async (req, res) => ok(res, await AccountConfigService.getSettings(req)));
exports.updateSettings = catchAsync(async (req, res) => {
  const before = await AccountConfigService.getSettings(req);
  const after = await AccountConfigService.updateSettings(req.body, req);
  await AuditService.log({ req, action: "SETTINGS_UPDATED", entity: "CompanySettings", summary: Object.keys(req.body).join(", "), before, after });
  ok(res, after);
});

// --- party ledger reports ---
exports.getAgeing = catchAsync(async (req, res) =>
  ok(res, await AgeingService.report({ type: req.query.type || "receivable", asOf: req.query.asOf || new Date() }))
);
exports.getStatement = catchAsync(async (req, res) =>
  ok(res, await StatementService.getStatement({ partyId: req.query.partyId, partyType: req.query.partyType, from: req.query.from, to: req.query.to }))
);
exports.getReturnable = catchAsync(async (req, res) => ok(res, await ReturnService.returnable(req.params.id, { excludeId: req.query.excludeId })));

// --- audit log ---
exports.getAuditLog = catchAsync(async (req, res) => ok(res, await AuditService.list(req, req.query)));
