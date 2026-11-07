const { ChecklistService, AppraisalService } = require("../../services/hr/talentService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");
const roles = require("../../utils/permissions");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const confidential = (req) => roles.can(req.admin.grants, "hr.confidential");

// Checklists.
exports.checklistForStaff = catchAsync(async (req, res) => ok(res, await ChecklistService.forStaff(req.params.staffId)));

exports.startChecklist = catchAsync(async (req, res) => {
  const rows = await ChecklistService.start(req.body, by(req));
  await AuditService.log({ req, action: "CHECKLIST_STARTED", entity: "StaffChecklistItem", entityId: rows[0]?._id, summary: `${req.body.listType} checklist for employee ${req.body.staffId}` });
  ok(res, rows, 201);
});

exports.addChecklistItem = catchAsync(async (req, res) => {
  const row = await ChecklistService.addItem(req.body, by(req));
  await AuditService.log({ req, action: "CHECKLIST_ITEM_ADDED", entity: "StaffChecklistItem", entityId: row._id, summary: row.subject });
  ok(res, row, 201);
});

exports.markChecklistItemDone = catchAsync(async (req, res) => {
  const row = await ChecklistService.markDone(req.params.itemId, by(req));
  await AuditService.log({ req, action: "CHECKLIST_ITEM_DONE", entity: "StaffChecklistItem", entityId: row._id, summary: row.subject });
  ok(res, row);
});

exports.removeChecklistItem = catchAsync(async (req, res) => {
  await ChecklistService.remove(req.params.itemId);
  await AuditService.log({ req, action: "CHECKLIST_ITEM_DELETED", entity: "StaffChecklistItem", entityId: req.params.itemId, summary: "Removed" });
  ok(res, { removed: true });
});

// Appraisals - the pay-at-review figure is confidential, the same gate a contract's own pay figures use.
exports.appraisalsForStaff = catchAsync(async (req, res) => ok(res, await AppraisalService.withContext(req.params.staffId, { confidential: confidential(req) })));

exports.createAppraisal = catchAsync(async (req, res) => {
  const row = await AppraisalService.create({ ...req.body, staffId: req.params.staffId }, by(req));
  await AuditService.log({ req, action: "APPRAISAL_CREATED", entity: "Appraisal", entityId: row._id, summary: `${row.periodLabel} for employee ${req.params.staffId}` });
  ok(res, row, 201);
});
