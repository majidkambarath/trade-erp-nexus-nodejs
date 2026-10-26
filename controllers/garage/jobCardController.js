const JobCardService = require("../../services/garage/jobCardService");
const GarageAttachmentService = require("../../services/garage/garageAttachmentService");
const AuditService = require("../../services/core/auditService");
const roles = require("../../utils/permissions");
const AppError = require("../../utils/AppError");
const { assertPermission } = require("../../middleware/permissionGate");
const catchAsync = require("../../utils/catchAsync");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const describe = (c) => `Job card ${c.jobNo || "(draft)"}: ${c.vehicle?.plateNumber || c.vehicle?.chassisNo || ""}`;
const log = (req, action, c, summary) =>
  AuditService.log({ req, action, entity: "JobCard", entityId: c._id, summary, after: { jobNo: c.jobNo, status: c.status, invoiceStatus: c.invoiceStatus } });

// Starting or finishing a task: whoever manages the garage (garage.edit), or the technician the task is given
// to - the same shape as processOrderController.js assertMayWorkStep, for the same reason: a workshop's own
// technicians, some without any other permission, must be able to work their own job.
async function assertMayWorkTask(req) {
  if (roles.can(req.admin.grants, "garage.edit")) return;
  const card = await JobCardService.getById(req.params.id);
  const task = (card.tasks || []).find((t) => String(t._id) === String(req.params.taskId));
  if (!task || String(task.assigneeId || "") !== String(req.admin.id)) {
    throw new AppError("Only the technician this task is given to, or someone who manages the garage, can do this", 403, "PERMISSION_DENIED", { required: ["garage.edit"] });
  }
}

exports.list = catchAsync(async (req, res) => ok(res, await JobCardService.list(req.query)));
exports.board = catchAsync(async (req, res) => ok(res, await JobCardService.board({ me: req.admin?.id })));
exports.assignees = catchAsync(async (req, res) => ok(res, await JobCardService.assignees()));
exports.staff = catchAsync(async (req, res) => ok(res, await JobCardService.staffChoices()));
exports.customers = catchAsync(async (req, res) => ok(res, await JobCardService.customerChoices(req.query)));
exports.vendors = catchAsync(async (req, res) => ok(res, await JobCardService.vendorChoices(req.query)));
exports.createCustomer = catchAsync(async (req, res) => {
  const c = await JobCardService.createCustomer(req.body?.name);
  await AuditService.log({ req, action: "GARAGE_CUSTOMER_CREATED", entity: "Customer", entityId: c.id, summary: `${c.name} (${c.code}) added from the garage module` });
  ok(res, c, 201);
});
exports.analysis = catchAsync(async (req, res) => ok(res, await JobCardService.analysis(req.query)));
exports.comebackCandidates = catchAsync(async (req, res) => ok(res, await JobCardService.comebackCandidates(req.query)));
exports.committed = catchAsync(async (req, res) => ok(res, await JobCardService.committed(req.query.itemIds)));
exports.shortages = catchAsync(async (req, res) => ok(res, await JobCardService.shortages(req.params.id)));
exports.get = catchAsync(async (req, res) => ok(res, await JobCardService.getById(req.params.id)));
exports.activity = catchAsync(async (req, res) => ok(res, await AuditService.list(req, { entity: "JobCard", entityId: req.params.id, limit: 100 })));

exports.create = catchAsync(async (req, res) => {
  const c = await JobCardService.create(req.body || {}, by(req));
  await log(req, "JOB_CARD_CREATED", c, `Opened ${describe(c)}`);
  ok(res, JobCardService.present(c), 201);
});

exports.update = catchAsync(async (req, res) => {
  const c = await JobCardService.update(req.params.id, req.body || {}, by(req));
  await log(req, "JOB_CARD_UPDATED", c, `Updated ${describe(c)}`);
  ok(res, JobCardService.present(c));
});

exports.remove = catchAsync(async (req, res) => {
  const c = await JobCardService.remove(req.params.id, by(req));
  await log(req, "JOB_CARD_DELETED", c, `Deleted ${describe(c)}`);
  await GarageAttachmentService.removeAll("jobcard", c._id, req); // after the record is gone, never inside its transaction
  ok(res, JobCardService.present(c));
});

exports.recordCheckIn = catchAsync(async (req, res) => {
  const c = await JobCardService.recordCheckIn(req.params.id, req.body || {}, by(req));
  await log(req, "JOB_CARD_CHECKED_IN", c, `Check-in recorded for ${describe(c)}`);
  ok(res, JobCardService.present(c));
});

exports.sendEstimate = catchAsync(async (req, res) => {
  const c = await JobCardService.sendEstimate(req.params.id, by(req));
  await log(req, "JOB_CARD_ESTIMATE_SENT", c, `Estimate sent for ${describe(c)}`);
  ok(res, JobCardService.present(c));
});

exports.recordApproval = catchAsync(async (req, res) => {
  const c = await JobCardService.recordApproval(req.params.id, req.body || {}, by(req));
  await log(req, "JOB_CARD_APPROVED", c, `Approval recorded for ${describe(c)}`);
  ok(res, JobCardService.present(c));
});

exports.reviseEstimate = catchAsync(async (req, res) => {
  const c = await JobCardService.reviseEstimate(req.params.id, req.body || {}, by(req));
  await log(req, "JOB_CARD_ESTIMATE_REVISED", c, `Supplementary estimate on ${describe(c)}`);
  ok(res, JobCardService.present(c));
});

exports.startTask = catchAsync(async (req, res) => {
  await assertMayWorkTask(req);
  const c = await JobCardService.startTask(req.params.id, req.params.taskId, by(req));
  ok(res, JobCardService.present(c));
});

exports.completeTask = catchAsync(async (req, res) => {
  await assertMayWorkTask(req);
  const c = await JobCardService.completeTask(req.params.id, req.params.taskId, req.body || {}, by(req));
  await log(req, "JOB_CARD_TASK_DONE", c, `A task on ${describe(c)}`);
  ok(res, JobCardService.present(c));
});

exports.createInvoice = catchAsync(async (req, res) => {
  // garage.invoice gets you here, but raising the invoice really does create a Transaction, so Sales must be
  // held too - its own route key must not be a side door into a module this person was not sold.
  assertPermission(req, "sales.create", "raising the invoice from a job card creates a sales document");
  const { jobCard, invoice } = await JobCardService.createInvoice({ ...req.body, jobCardId: req.params.id }, by(req));
  await log(req, "JOB_CARD_INVOICED", jobCard, `Invoice ${invoice.transactionNo} raised from ${describe(jobCard)}`);
  ok(res, { jobCard: JobCardService.present(jobCard), invoice }, 201);
});

exports.raisePurchaseOrder = catchAsync(async (req, res) => {
  // garage.edit gets you here, but this really does create a purchase document, so Purchase must be held too
  // - the same double-assert createInvoice uses for Sales, so this route can never be a side door into a
  // module this person was not sold.
  assertPermission(req, "purchase.create", "raising a purchase order from a job card creates a purchase document");
  const { jobCard, order } = await JobCardService.raisePurchaseOrder({ ...req.body, jobCardId: req.params.id }, by(req));
  await log(req, "JOB_CARD_PURCHASE_ORDER_RAISED", jobCard, `Purchase order ${order.orderNo} raised for ${describe(jobCard)}`);
  ok(res, { jobCard: JobCardService.present(jobCard), order }, 201);
});

exports.release = catchAsync(async (req, res) => {
  const c = await JobCardService.releaseVehicle(req.params.id, req.body || {}, by(req));
  await log(req, "JOB_CARD_RELEASED", c, `Vehicle released for ${describe(c)}`);
  ok(res, JobCardService.present(c));
});

exports.cancel = catchAsync(async (req, res) => {
  const c = await JobCardService.cancel(req.params.id, req.body || {}, by(req));
  await log(req, "JOB_CARD_CANCELLED", c, `Cancelled ${describe(c)}: ${req.body?.reason || ""}`);
  ok(res, JobCardService.present(c));
});
