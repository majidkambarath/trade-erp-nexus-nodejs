const VehicleService = require("../../services/garage/vehicleService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const describe = (v) => `${v.plateNumber || v.chassisNo || "vehicle"} (${[v.make, v.model].filter(Boolean).join(" ")})`;
const log = (req, action, v, summary) =>
  AuditService.log({ req, action, entity: "Vehicle", entityId: v._id, summary, after: { plateNumber: v.plateNumber, chassisNo: v.chassisNo, customerId: v.customerId } });

exports.list = catchAsync(async (req, res) => ok(res, await VehicleService.list(req.query)));
exports.find = catchAsync(async (req, res) => ok(res, await VehicleService.findByPlateOrChassis(req.query)));
exports.get = catchAsync(async (req, res) => ok(res, await VehicleService.getById(req.params.id)));
exports.activity = catchAsync(async (req, res) => ok(res, await AuditService.list(req, { entity: "Vehicle", entityId: req.params.id, limit: 100 })));

exports.create = catchAsync(async (req, res) => {
  const v = await VehicleService.create(req.body || {}, by(req));
  await log(req, "VEHICLE_CREATED", v, `Added ${describe(v)}`);
  ok(res, v, 201);
});

exports.update = catchAsync(async (req, res) => {
  const v = await VehicleService.update(req.params.id, req.body || {}, by(req));
  await log(req, "VEHICLE_UPDATED", v, `Updated ${describe(v)}`);
  ok(res, v);
});
