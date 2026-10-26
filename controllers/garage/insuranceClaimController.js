const InsuranceClaimService = require("../../services/garage/insuranceClaimService");
const GarageAttachmentService = require("../../services/garage/garageAttachmentService");
const AuditService = require("../../services/core/auditService");
const { assertPermission } = require("../../middleware/permissionGate");
const catchAsync = require("../../utils/catchAsync");

const by = (req) => req.admin?.id || "system";
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });
const describe = (c) => `Claim ${c.claimNo || "(draft)"}: ${c.insurer?.name || ""}, policy ${c.policyNo}`;
const log = (req, action, c, summary) =>
  AuditService.log({ req, action, entity: "InsuranceClaim", entityId: c._id, summary, after: { claimNo: c.claimNo, status: c.status } });

exports.list = catchAsync(async (req, res) => ok(res, await InsuranceClaimService.list(req.query)));
exports.ageing = catchAsync(async (req, res) => ok(res, await InsuranceClaimService.ageing(req.query.today || new Date())));
exports.get = catchAsync(async (req, res) => ok(res, await InsuranceClaimService.getById(req.params.claimId)));
exports.activity = catchAsync(async (req, res) => ok(res, await AuditService.list(req, { entity: "InsuranceClaim", entityId: req.params.claimId, limit: 100 })));

exports.create = catchAsync(async (req, res) => {
  const c = await InsuranceClaimService.create(req.body || {}, by(req));
  await log(req, "CLAIM_CREATED", c, `Opened ${describe(c)}`);
  ok(res, InsuranceClaimService.present(c), 201);
});

exports.update = catchAsync(async (req, res) => {
  const c = await InsuranceClaimService.update(req.params.claimId, req.body || {}, by(req));
  await log(req, "CLAIM_UPDATED", c, `Updated ${describe(c)}`);
  ok(res, InsuranceClaimService.present(c));
});

exports.remove = catchAsync(async (req, res) => {
  const c = await InsuranceClaimService.remove(req.params.claimId, by(req));
  await log(req, "CLAIM_DELETED", c, `Deleted ${describe(c)}`);
  await GarageAttachmentService.removeAll("claim", c._id, req);
  ok(res, InsuranceClaimService.present(c));
});

exports.submit = catchAsync(async (req, res) => {
  const c = await InsuranceClaimService.submit(req.params.claimId, by(req));
  await log(req, "CLAIM_SUBMITTED", c, `Submitted ${describe(c)}`);
  ok(res, InsuranceClaimService.present(c));
});

exports.recordSurvey = catchAsync(async (req, res) => {
  const c = await InsuranceClaimService.recordSurvey(req.params.claimId, req.body || {}, by(req));
  await log(req, "CLAIM_SURVEYED", c, `Survey recorded for ${describe(c)}`);
  ok(res, InsuranceClaimService.present(c));
});

exports.recordApproval = catchAsync(async (req, res) => {
  const c = await InsuranceClaimService.recordApproval(req.params.claimId, req.body || {}, by(req));
  await log(req, "CLAIM_DECIDED", c, `${c.status} - ${describe(c)}`);
  ok(res, InsuranceClaimService.present(c));
});

exports.raiseInvoices = catchAsync(async (req, res) => {
  // Raising invoices really does create sales Transactions (the insurer's and, usually, the customer's), so
  // Sales must be held too - the same rule as jobCardController.createInvoice, for the same reason.
  assertPermission(req, "sales.create", "raising a claim's invoices creates sales documents");
  const c = await InsuranceClaimService.raiseInvoices(req.params.claimId, by(req));
  await log(req, "CLAIM_INVOICED", c, `Invoices raised for ${describe(c)}`);
  ok(res, InsuranceClaimService.present(c), 201);
});
