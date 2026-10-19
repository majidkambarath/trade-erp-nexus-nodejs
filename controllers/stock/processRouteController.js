const ProcessRouteService = require("../../services/stock/processRouteService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const log = (req, action, r, summary) =>
  AuditService.log({ req, action, entity: "ProcessRoute", entityId: r._id, summary, after: { item: r.finished?.itemName, batchQty: r.batchQty, steps: (r.steps || []).map((s) => `${s.name} (${s.days || 0} d)`) } });

exports.list = catchAsync(async (req, res) => ok(res, await ProcessRouteService.list(req.query)));
exports.plan = catchAsync(async (req, res) => ok(res, await ProcessRouteService.plan(req.query)));
exports.get = catchAsync(async (req, res) => ok(res, await ProcessRouteService.getById(req.params.id)));

exports.create = catchAsync(async (req, res) => {
  const r = await ProcessRouteService.create(req.body || {}, by(req));
  await log(req, "PROCESS_ROUTE_CREATED", r, `Route for ${r.finished.itemName} saved`);
  ok(res, ProcessRouteService.present(r), 201);
});
exports.update = catchAsync(async (req, res) => {
  const r = await ProcessRouteService.update(req.params.id, req.body || {}, by(req));
  await log(req, "PROCESS_ROUTE_UPDATED", r, `Route for ${r.finished.itemName} changed`);
  ok(res, ProcessRouteService.present(r));
});
exports.remove = catchAsync(async (req, res) => {
  const r = await ProcessRouteService.remove(req.params.id, by(req));
  await log(req, "PROCESS_ROUTE_DELETED", r, `Route for ${r.finished.itemName} deleted`);
  ok(res, { _id: r._id });
});
