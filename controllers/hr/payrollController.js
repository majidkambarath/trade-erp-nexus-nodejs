const SalaryComponentService = require("../../services/hr/salaryComponentService");
const PayrollService = require("../../services/hr/payrollService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");
const roles = require("../../utils/permissions");
const { assertPermission } = require("../../middleware/permissionGate");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const confidential = (req) => roles.can(req.admin.grants, "hr.confidential");

// Components.
exports.listComponents = catchAsync(async (req, res) => ok(res, await SalaryComponentService.list()));
exports.createComponent = catchAsync(async (req, res) => {
  const row = await SalaryComponentService.create(req.body, by(req));
  await AuditService.log({ req, action: "SALARY_COMPONENT_CREATED", entity: "SalaryComponent", entityId: row._id, summary: `${row.name} (${row.kind})` });
  ok(res, row, 201);
});
exports.updateComponent = catchAsync(async (req, res) => {
  const row = await SalaryComponentService.update(req.params.componentId, req.body, by(req));
  await AuditService.log({ req, action: "SALARY_COMPONENT_UPDATED", entity: "SalaryComponent", entityId: row._id, summary: row.name });
  ok(res, row);
});
exports.removeComponent = catchAsync(async (req, res) => {
  await SalaryComponentService.remove(req.params.componentId);
  await AuditService.log({ req, action: "SALARY_COMPONENT_DELETED", entity: "SalaryComponent", entityId: req.params.componentId, summary: "Component removed" });
  ok(res, { removed: true });
});

// A plan/run is pay data for every employee at once - it needs hr.confidential like a contract does, not
// just hr.payroll (which is the ACTION of running payroll; confidential is the gate on SEEING the figures).
const forReader = (built, canSeePay) =>
  canSeePay ? built : { period: built.period, payDate: built.payDate, assessment: built.assessment, totals: built.totals, alreadyPosted: built.alreadyPosted };

exports.plan = catchAsync(async (req, res) => {
  const built = await PayrollService.plan(req.query.period);
  ok(res, forReader(built, confidential(req)));
});

exports.post = catchAsync(async (req, res) => {
  assertPermission(req, "hr.confidential");
  assertPermission(req, "finance.create");
  const { run, employeeCount } = await PayrollService.post(req.body.period, { acknowledge: req.body.acknowledge }, by(req));
  await AuditService.log({ req, action: "PAYROLL_POSTED", entity: "PayrollRun", entityId: run._id, summary: `${run.period}: ${employeeCount} employees, net ${run.totalNet}` });
  ok(res, run, 201);
});

exports.reverse = catchAsync(async (req, res) => {
  assertPermission(req, "finance.deletePosted");
  const run = await PayrollService.reverse(req.params.runId, { reason: req.body?.reason }, by(req));
  await AuditService.log({ req, action: "PAYROLL_REVERSED", entity: "PayrollRun", entityId: run._id, summary: `${run.period} reversed` });
  ok(res, run);
});

exports.list = catchAsync(async (req, res) => ok(res, await PayrollService.list()));

exports.payslips = catchAsync(async (req, res) => {
  assertPermission(req, "hr.confidential");
  ok(res, await PayrollService.payslipsFor(req.params.runId));
});

exports.payslipsForStaff = catchAsync(async (req, res) => {
  assertPermission(req, "hr.confidential");
  ok(res, await PayrollService.payslipsForStaff(req.params.staffId));
});
