const GarageSetupService = require("../../services/garage/garageSetupService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

exports.listBays = catchAsync(async (req, res) => ok(res, await GarageSetupService.listBays(req.query)));
exports.createBay = catchAsync(async (req, res) => {
  const bay = await GarageSetupService.createBay(req.body || {}, by(req));
  await AuditService.log({ req, action: "GARAGE_BAY_CREATED", entity: "Bay", entityId: bay._id, summary: `Added bay ${bay.name}` });
  ok(res, bay, 201);
});
exports.updateBay = catchAsync(async (req, res) => {
  const bay = await GarageSetupService.updateBay(req.params.bayId, req.body || {}, by(req));
  await AuditService.log({ req, action: "GARAGE_BAY_UPDATED", entity: "Bay", entityId: bay._id, summary: `Updated bay ${bay.name}` });
  ok(res, bay);
});

exports.listServices = catchAsync(async (req, res) => ok(res, await GarageSetupService.listServices(req.query)));
exports.createService = catchAsync(async (req, res) => {
  const svc = await GarageSetupService.createService(req.body || {}, by(req));
  await AuditService.log({ req, action: "GARAGE_SERVICE_CREATED", entity: "GarageService", entityId: svc._id, summary: `Added standard job ${svc.name}` });
  ok(res, svc, 201);
});
exports.updateService = catchAsync(async (req, res) => {
  const svc = await GarageSetupService.updateService(req.params.serviceId, req.body || {}, by(req));
  await AuditService.log({ req, action: "GARAGE_SERVICE_UPDATED", entity: "GarageService", entityId: svc._id, summary: `Updated standard job ${svc.name}` });
  ok(res, svc);
});
exports.plan = catchAsync(async (req, res) => ok(res, await GarageSetupService.plan(req.query)));
