const ProcessOrderService = require("../../services/stock/processOrderService");
const AuditService = require("../../services/core/auditService");
const roles = require("../../utils/permissions");
const AppError = require("../../utils/AppError");
const { assertPermission } = require("../../middleware/permissionGate");
const catchAsync = require("../../utils/catchAsync");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const describe = (o) => `Process order ${o.processNo || "(draft)"}: ${o.finished?.itemName} x ${o.finished?.qty}`;
const log = (req, action, o, summary) =>
  AuditService.log({ req, action, entity: "ProcessOrder", entityId: o._id, summary, after: { processNo: o.processNo, status: o.status, steps: (o.steps || []).map((s) => `${s.seq}. ${s.name}: ${s.status}`) } });

// Starting or finishing a step: whoever manages stock (inventory.adjust), or the person the step is given to.
async function assertMayWorkStep(req) {
  if (roles.can(req.admin.grants, "inventory.adjust")) return;
  const o = await ProcessOrderService.getById(req.params.id);
  const step = (o.steps || []).find((s) => String(s._id) === String(req.params.stepId));
  if (!step || String(step.assigneeId || "") !== String(req.admin.id)) {
    throw new AppError("Only the person this step is given to, or someone who manages stock, can do this", 403, "PERMISSION_DENIED", { required: ["inventory.adjust"] });
  }
}

exports.list = catchAsync(async (req, res) => ok(res, await ProcessOrderService.list(req.query)));
exports.board = catchAsync(async (req, res) => ok(res, await ProcessOrderService.board({ me: req.admin?.id })));
exports.assignees = catchAsync(async (req, res) => ok(res, await ProcessOrderService.assignees()));
exports.lastSteps = catchAsync(async (req, res) => ok(res, await ProcessOrderService.lastSteps(req.query.stockId)));
exports.myWork = catchAsync(async (req, res) => ok(res, { count: await ProcessOrderService.myWorkCount(req.admin?.id) }));
exports.analysis = catchAsync(async (req, res) => ok(res, await ProcessOrderService.analysis(req.query)));
exports.expenseVouchers = catchAsync(async (req, res) => ok(res, await ProcessOrderService.expenseVouchers(req.query)));
exports.get = catchAsync(async (req, res) => ok(res, await ProcessOrderService.getById(req.params.id)));
exports.activity = catchAsync(async (req, res) => ok(res, await AuditService.list(req, { entity: "ProcessOrder", entityId: req.params.id, limit: 100 })));

exports.create = catchAsync(async (req, res) => {
  const o = await ProcessOrderService.create(req.body || {}, by(req));
  await log(req, "PROCESS_ORDER_CREATED", o, `${describe(o)} saved as draft`);
  ok(res, ProcessOrderService.present(o), 201);
});
exports.update = catchAsync(async (req, res) => {
  const o = await ProcessOrderService.update(req.params.id, req.body || {}, by(req));
  await log(req, "PROCESS_ORDER_UPDATED", o, `${describe(o)} edited`);
  ok(res, ProcessOrderService.present(o));
});
exports.remove = catchAsync(async (req, res) => {
  const o = await ProcessOrderService.remove(req.params.id, by(req));
  await log(req, "PROCESS_ORDER_DELETED", o, `${describe(o)} (draft) deleted`);
  ok(res, { _id: o._id });
});
exports.release = catchAsync(async (req, res) => {
  const o = await ProcessOrderService.release(req.params.id, by(req));
  await log(req, "PROCESS_ORDER_RELEASED", o, `${describe(o)} released`);
  ok(res, ProcessOrderService.present(o));
});
exports.cancel = catchAsync(async (req, res) => {
  const o = await ProcessOrderService.cancel(req.params.id, by(req));
  await log(req, "PROCESS_ORDER_CANCELLED", o, `${describe(o)} cancelled`);
  ok(res, ProcessOrderService.present(o));
});
exports.startStep = catchAsync(async (req, res) => {
  await assertMayWorkStep(req);
  const o = await ProcessOrderService.startStep(req.params.id, req.params.stepId, by(req));
  await log(req, "PROCESS_STEP_STARTED", o, `${describe(o)}: a step started`);
  ok(res, ProcessOrderService.present(o));
});
exports.completeStep = catchAsync(async (req, res) => {
  await assertMayWorkStep(req);
  const o = await ProcessOrderService.completeStep(req.params.id, req.params.stepId, req.body || {}, by(req));
  await log(req, "PROCESS_STEP_DONE", o, `${describe(o)}: a step done (${req.body?.qtyDone} good${req.body?.qtyRejected ? `, ${req.body.qtyRejected} rejected` : ""})`);
  ok(res, ProcessOrderService.present(o));
});
exports.sendStep = catchAsync(async (req, res) => {
  const { order, jobWork } = await ProcessOrderService.sendStep(req.params.id, req.params.stepId, req.body || {}, by(req));
  await log(req, "PROCESS_STEP_SENT", order, `${describe(order)}: sent to the job worker on ${jobWork.jobWorkNo}`);
  ok(res, { ...ProcessOrderService.present(order), jobWork: { _id: jobWork._id, jobWorkNo: jobWork.jobWorkNo } });
});
// A cost taken from an expense voucher reads a voucher, which is finance's to see.
exports.addCost = catchAsync(async (req, res) => {
  if (req.body?.voucherId) assertPermission(req, "finance.view", "a cost taken from an expense voucher reads that voucher");
  const o = await ProcessOrderService.addCost(req.params.id, req.body || {}, by(req));
  const c = o.costs[o.costs.length - 1];
  await log(req, "PROCESS_COST_ADDED", o, `${describe(o)}: cost ${c.accountName} ${c.amount}${c.voucherNo ? ` from ${c.voucherNo}` : ""}${c.stepName ? ` (${c.stepName})` : ""}`);
  ok(res, ProcessOrderService.present(o));
});
exports.removeCost = catchAsync(async (req, res) => {
  const o = await ProcessOrderService.removeCost(req.params.id, req.params.costId, by(req));
  await log(req, "PROCESS_COST_REMOVED", o, `${describe(o)}: a recorded cost removed`);
  ok(res, ProcessOrderService.present(o));
});
// Costs moved into the product on finishing change the books as an expense voucher does (the rule of a production).
exports.finish = catchAsync(async (req, res) => {
  // without a list, the costs recorded on the order are moved in
  const moving = Array.isArray(req.body?.costs) ? req.body.costs.some((c) => c && (c.accountId || c.amount)) : (await ProcessOrderService.getById(req.params.id)).costs?.length > 0;
  if (moving) assertPermission(req, "finance.create", "moving expenses into a product's cost changes the books");
  const { order, production } = await ProcessOrderService.finish(req.params.id, req.body || {}, by(req));
  await log(req, "PROCESS_ORDER_COMPLETED", order, `${describe(order)} finished: ${production.productionNo} posted, unit cost ${production.totals.unitCost}`);
  ok(res, { ...ProcessOrderService.present(order), production: { _id: production._id, productionNo: production.productionNo, totals: production.totals } });
});
exports.reopen = catchAsync(async (req, res) => {
  const current = await ProcessOrderService.getById(req.params.id);
  if (current.productionId) assertPermission(req, "finance.deletePosted", "reopening reverses the posted production");
  const o = await ProcessOrderService.reopen(req.params.id, { reason: req.body?.reason }, by(req));
  await log(req, "PROCESS_ORDER_REOPENED", o, `${describe(o)} reopened`);
  ok(res, ProcessOrderService.present(o));
});
