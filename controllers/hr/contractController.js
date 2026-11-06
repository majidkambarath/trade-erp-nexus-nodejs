const ContractService = require("../../services/hr/contractService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");
const roles = require("../../utils/permissions");

// Who may read pay. `hr.view` sees the directory; `hr.confidential` is what sees a number. A read without it
// still returns the history (when somebody was on what terms is an ordinary part of a personnel file) but
// with every money figure stripped - ContractService.list does that, this controller only decides WHICH way.
const confidential = (req) => roles.can(req.admin.grants, "hr.confidential");
const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

exports.list = catchAsync(async (req, res) => ok(res, await ContractService.list(req.params.staffId, { confidential: confidential(req) })));

exports.coverage = catchAsync(async (req, res) => ok(res, await ContractService.coverage(req.query)));

// Writing a contract is setting somebody's pay, so it needs hr.confidential outright - NOT hr.manage, which
// only governs the employee record itself (name, designation, documents). An HR assistant who may add
// employees and chase visas must not thereby be able to set anybody's salary.
exports.create = catchAsync(async (req, res) => {
  const contract = await ContractService.create({ ...req.body, staffId: req.params.staffId }, by(req));
  await AuditService.log({ req, action: "EMPLOYEE_CONTRACT_CREATED", entity: "EmployeeContract", entityId: contract._id, summary: `New contract from ${contract.effectiveFrom}` });
  ok(res, contract, 201);
});

exports.update = catchAsync(async (req, res) => {
  const contract = await ContractService.update(req.params.id, req.body, by(req));
  await AuditService.log({ req, action: "EMPLOYEE_CONTRACT_UPDATED", entity: "EmployeeContract", entityId: contract?._id || req.params.id, summary: "Contract corrected" });
  ok(res, contract);
});

exports.remove = catchAsync(async (req, res) => {
  const result = await ContractService.remove(req.params.id);
  await AuditService.log({ req, action: "EMPLOYEE_CONTRACT_DELETED", entity: "EmployeeContract", entityId: req.params.id, summary: "Contract removed" });
  ok(res, result);
});
