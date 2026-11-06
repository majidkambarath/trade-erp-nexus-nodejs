const EmployeeDocumentService = require("../../services/hr/employeeDocumentService");
const DocumentExpiryService = require("../../services/masters/documentExpiryService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

exports.forStaff = catchAsync(async (req, res) => ok(res, await EmployeeDocumentService.forStaff(req.params.staffId)));

exports.create = catchAsync(async (req, res) => {
  const row = await EmployeeDocumentService.create(req.body, by(req));
  await AuditService.log({ req, action: "EMPLOYEE_DOCUMENT_CREATED", entity: "EmployeeDocument", entityId: row._id, summary: row.name });
  ok(res, row, 201);
});

exports.update = catchAsync(async (req, res) => {
  const row = await EmployeeDocumentService.update(req.params.id, req.body, by(req));
  await AuditService.log({ req, action: "EMPLOYEE_DOCUMENT_UPDATED", entity: "EmployeeDocument", entityId: row._id, summary: row.name });
  ok(res, row);
});

exports.remove = catchAsync(async (req, res) => {
  await EmployeeDocumentService.remove(req.params.id);
  await AuditService.log({ req, action: "EMPLOYEE_DOCUMENT_DELETED", entity: "EmployeeDocument", entityId: req.params.id, summary: "Document removed" });
  ok(res, { removed: true });
});

// The combined expiry report (customer / vendor / staff), narrowed to staff for the HR screen.
exports.expiring = catchAsync(async (req, res) => ok(res, await DocumentExpiryService.list({ ...req.query, partyType: "staff" })));
