const AssetAssignmentService = require("../../services/hr/assetAssignmentService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

exports.list = catchAsync(async (req, res) => ok(res, await AssetAssignmentService.list(req.query)));
exports.forStaff = catchAsync(async (req, res) => ok(res, await AssetAssignmentService.forStaff(req.params.staffId)));

exports.issue = catchAsync(async (req, res) => {
  const row = await AssetAssignmentService.issue(req.body, by(req));
  await AuditService.log({ req, action: "ASSET_ISSUED", entity: "AssetAssignment", entityId: row._id, summary: row.assetName });
  ok(res, row, 201);
});

exports.markReturned = catchAsync(async (req, res) => {
  const row = await AssetAssignmentService.markReturned(req.params.assetId, req.body, by(req));
  await AuditService.log({ req, action: "ASSET_RETURNED", entity: "AssetAssignment", entityId: row._id, summary: row.assetName });
  ok(res, row);
});

exports.remove = catchAsync(async (req, res) => {
  await AssetAssignmentService.remove(req.params.assetId);
  await AuditService.log({ req, action: "ASSET_ASSIGNMENT_DELETED", entity: "AssetAssignment", entityId: req.params.assetId, summary: "Removed" });
  ok(res, { removed: true });
});
