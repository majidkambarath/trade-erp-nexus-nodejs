const catchAsync = require("../../utils/catchAsync");
const VatReturn = require("../../services/reports/vatReturnService");
const FtaAuditFile = require("../../services/reports/ftaAuditFileService");
const DefaultChartService = require("../../services/financial/defaultChartService");
const AuditService = require("../../services/core/auditService");

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const admin = (req) => req.admin?._id || req.admin?.id || "";

// The return reads the ledger for its reconciliation: make sure earlier documents have reached it.
const live = (fn) =>
  catchAsync(async (req, res) => {
    await DefaultChartService.onOpenThrottled(req);
    ok(res, await fn(req));
  });

exports.compute = live((req) => VatReturn.compute({ from: req.query.from, to: req.query.to }));

// The FTA Audit File (FAF): generated on request, downloaded as it is, and who took it is recorded.
exports.auditFile = catchAsync(async (req, res) => {
  await DefaultChartService.onOpenThrottled(req);
  const { from, to } = req.query;
  const file = await FtaAuditFile.generate({ from, to });
  await AuditService.log({
    req, action: "FAF_GENERATED", entity: "VATReturn",
    summary: `FTA audit file for ${from} to ${to}: ${file.totals.supplies.count} supply, ${file.totals.purchases.count} purchase and ${file.totals.ledger.count} ledger line(s)`,
  });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${file.fileName}"`);
  res.status(200).send(file.text);
});

exports.detail = live((req) =>
  VatReturn.detail({ from: req.query.from, to: req.query.to, direction: req.query.direction, kind: req.query.kind, search: req.query.search, page: req.query.page, limit: req.query.limit }));

exports.list = catchAsync(async (req, res) => ok(res, await VatReturn.list()));
exports.get = catchAsync(async (req, res) => ok(res, await VatReturn.get(req.params.id)));
exports.createDraft = catchAsync(async (req, res) => ok(res, await VatReturn.createDraft({ from: req.body?.from, to: req.body?.to, notes: req.body?.notes }, admin(req)), 201));
exports.finalize = catchAsync(async (req, res) => ok(res, await VatReturn.finalize(req.params.id, admin(req), { allowUnclassified: req.body?.allowUnclassified === true })));
exports.file = catchAsync(async (req, res) => ok(res, await VatReturn.file(req.params.id, admin(req), { reference: req.body?.reference, filedOn: req.body?.filedOn })));
// Takes a finalised return back to a draft, so its period posts again (F02). A filed return refuses.
exports.reopen = catchAsync(async (req, res) => ok(res, await VatReturn.reopen(req.params.id, admin(req))));
exports.remove = catchAsync(async (req, res) => { await VatReturn.remove(req.params.id); ok(res, { deleted: true }); });
