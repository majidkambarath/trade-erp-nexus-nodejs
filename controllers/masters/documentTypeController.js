const catchAsync = require("../../utils/catchAsync");
const DocumentTypeService = require("../../services/masters/documentTypeService");
const AuditService = require("../../services/core/auditService");

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

exports.list = catchAsync(async (req, res) => ok(res, await DocumentTypeService.list(req, { active: req.query.active, q: req.query.q })));
exports.get = catchAsync(async (req, res) => ok(res, await DocumentTypeService.get(req.params.id, req)));
exports.create = catchAsync(async (req, res) => {
  const type = await DocumentTypeService.create(req.body, req);
  await AuditService.log({ req, action: "DOCUMENT_TYPE_CREATED", entity: "DocumentType", entityId: type._id, summary: `${type.code} ${type.name}` });
  ok(res, type, 201);
});
exports.update = catchAsync(async (req, res) => {
  const type = await DocumentTypeService.update(req.params.id, req.body, req);
  await AuditService.log({ req, action: "DOCUMENT_TYPE_UPDATED", entity: "DocumentType", entityId: type._id, summary: `${type.code} ${type.name}`, after: req.body });
  ok(res, type);
});
exports.remove = catchAsync(async (req, res) => {
  await DocumentTypeService.remove(req.params.id, req);
  await AuditService.log({ req, action: "DOCUMENT_TYPE_DELETED", entity: "DocumentType", entityId: req.params.id });
  ok(res, { deleted: true });
});
