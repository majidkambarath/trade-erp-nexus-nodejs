const GratuityService = require("../../services/hr/gratuityService");
const EmiratisationService = require("../../services/hr/emiratisationService");
const StatutoryRuleService = require("../../services/hr/statutoryRuleService");
const AuditService = require("../../services/core/auditService");
const catchAsync = require("../../utils/catchAsync");
const roles = require("../../utils/permissions");
const { assertPermission } = require("../../middleware/permissionGate");

const confidential = (req) => roles.can(req.admin.grants, "hr.confidential");
const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// A gratuity preview names employees and their basic pay (liabilityByEmployee) - the same figure
// contractController strips for a reader without hr.confidential. Without it, this answers the aggregate
// only: the total liability and how many people it covers, never who or at what rate.
const forReader = (preview, canSeePay) =>
  canSeePay ? preview : { month: preview.month, day: preview.day, cumulativeLiability: preview.cumulativeLiability, previousCumulative: preview.previousCumulative, amount: preview.amount, employeeCount: preview.employeeCount, missingCount: preview.missing.length };

exports.previewGratuity = catchAsync(async (req, res) => {
  const preview = await GratuityService.preview(req.query.month);
  ok(res, forReader(preview, confidential(req)));
});

exports.listGratuityAccruals = catchAsync(async (req, res) => ok(res, await GratuityService.list()));

// Accruing POSTS to the ledger and reads everyone's basic pay, so it needs both gates production's own
// cost lines need: hr.confidential (it is pay data) AND finance.create (it is a ledger posting) - asserted
// here rather than declared on the route, the same assertPermission pattern a request that only knows it
// needs more after reading the record already uses elsewhere.
exports.accrueGratuity = catchAsync(async (req, res) => {
  assertPermission(req, "finance.create");
  const { accrual, posted } = await GratuityService.accrue(req.body.month, by(req));
  await AuditService.log({ req, action: "GRATUITY_ACCRUED", entity: "GratuityAccrual", entityId: accrual._id, summary: `${req.body.month}: ${posted ? accrual.amount : "no movement"}` });
  ok(res, { accrual, posted }, 201);
});

exports.reverseGratuity = catchAsync(async (req, res) => {
  assertPermission(req, "finance.deletePosted");
  const row = await GratuityService.reverse(req.params.id, { reason: req.body?.reason }, by(req));
  await AuditService.log({ req, action: "GRATUITY_REVERSED", entity: "GratuityAccrual", entityId: row._id, summary: `${row.month} reversed` });
  ok(res, row);
});

exports.emiratisation = catchAsync(async (req, res) => ok(res, await EmiratisationService.status(req.query)));

exports.listStatutoryRules = catchAsync(async (req, res) => ok(res, await StatutoryRuleService.list(req.query.country)));

exports.createStatutoryRule = catchAsync(async (req, res) => {
  const rule = await StatutoryRuleService.create(req.body, by(req));
  await AuditService.log({ req, action: "STATUTORY_RULE_CREATED", entity: "StatutoryRule", entityId: rule._id, summary: `${rule.country} ${rule.key} from ${rule.effectiveFrom}` });
  ok(res, rule, 201);
});

exports.removeStatutoryRule = catchAsync(async (req, res) => {
  await StatutoryRuleService.remove(req.params.id);
  await AuditService.log({ req, action: "STATUTORY_RULE_DELETED", entity: "StatutoryRule", entityId: req.params.id, summary: "Rule removed" });
  ok(res, { removed: true });
});
