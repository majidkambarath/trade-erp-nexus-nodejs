const JobWorkService = require("../../services/stock/jobWorkService");
const AuditService = require("../../services/core/auditService");
const ProductionOrder = require("../../models/modules/productionOrderModel");
const { assertPermission } = require("../../middleware/permissionGate");
const catchAsync = require("../../utils/catchAsync");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const describe = (o) => `Job work ${o.jobWorkNo || "(draft)"} with ${o.jobWorker?.name || "a job worker"}`;
const snapshot = (o) => ({
  jobWorkNo: o.jobWorkNo, status: o.status, jobWorker: o.jobWorker?.name, date: o.date, returnBy: o.returnBy, purpose: o.purpose,
  lines: (o.lines || []).map((l) => ({ sent: l.rawItemId, qty: l.qtySent, back: l.finishedItemId })),
});
const log = (req, action, o, summary) => AuditService.log({ req, action, entity: "JobWorkOrder", entityId: o._id, summary, after: snapshot(o) });

exports.list = catchAsync(async (req, res) => ok(res, await JobWorkService.list(req.query)));
exports.withJobWorker = catchAsync(async (req, res) => ok(res, Object.fromEntries(await JobWorkService.withJobWorker())));
exports.get = catchAsync(async (req, res) => ok(res, await JobWorkService.getById(req.params.id)));
exports.activity = catchAsync(async (req, res) => ok(res, await AuditService.list(req, { entity: "JobWorkOrder", entityId: req.params.id, limit: 100 })));

exports.create = catchAsync(async (req, res) => {
  const o = await JobWorkService.create(req.body || {}, by(req));
  await log(req, "JOB_WORK_CREATED", o, `${describe(o)} saved as draft`);
  ok(res, JobWorkService.present(o), 201);
});
exports.update = catchAsync(async (req, res) => {
  const o = await JobWorkService.update(req.params.id, req.body || {}, by(req));
  await log(req, "JOB_WORK_UPDATED", o, `${describe(o)} edited`);
  ok(res, JobWorkService.present(o));
});
exports.remove = catchAsync(async (req, res) => {
  const o = await JobWorkService.remove(req.params.id, by(req));
  await log(req, "JOB_WORK_DELETED", o, `${describe(o)} (draft) deleted`);
  ok(res, { _id: o._id });
});
exports.send = catchAsync(async (req, res) => {
  const o = await JobWorkService.send(req.params.id, by(req));
  await log(req, "JOB_WORK_SENT", o, `${describe(o)} sent on challan ${o.jobWorkNo}`);
  ok(res, JobWorkService.present(o));
});
exports.cancel = catchAsync(async (req, res) => {
  const o = await JobWorkService.cancel(req.params.id, by(req));
  await log(req, "JOB_WORK_CANCELLED", o, `${describe(o)} cancelled`);
  ok(res, JobWorkService.present(o));
});

// Costs moved into stock on a receipt change the books as an expense voucher does: Finance Add is needed for them,
// and Finance Delete-posted to take such a receipt back (the same rule as a production).
exports.receive = catchAsync(async (req, res) => {
  if ((req.body?.costs || []).some((c) => c && (c.accountId || c.amount))) assertPermission(req, "finance.create", "moving expenses into a product's cost changes the books");
  const { order, productions } = await JobWorkService.receive(req.params.id, req.body || {}, by(req));
  await log(req, "JOB_WORK_RECEIVED", order, `${describe(order)}: received back${productions.length ? `, ${productions.map((p) => p.no).join(", ")} posted` : " (returned unprocessed)"}`);
  ok(res, { ...JobWorkService.present(order), productions });
});
exports.reverseReceipt = catchAsync(async (req, res) => {
  const current = await JobWorkService.getById(req.params.id);
  const receipt = (current.receipts || []).find((r) => String(r._id) === String(req.params.receiptId));
  const ids = (receipt?.productions || []).map((p) => p.id);
  if (ids.length && (await ProductionOrder.exists({ _id: { $in: ids }, "costs.0": { $exists: true } }))) {
    assertPermission(req, "finance.deletePosted", "the receipt moved expenses into stock");
  }
  const o = await JobWorkService.reverseReceipt(req.params.id, req.params.receiptId, { reason: req.body?.reason }, by(req));
  await log(req, "JOB_WORK_RECEIPT_REVERSED", o, `${describe(o)}: a receipt was reversed${req.body?.reason ? `: ${req.body.reason}` : ""}`);
  ok(res, JobWorkService.present(o));
});
