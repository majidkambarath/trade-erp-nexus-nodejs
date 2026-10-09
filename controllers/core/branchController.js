const catchAsync = require("../../utils/catchAsync");
const BranchService = require("../../services/core/branchService");
const AuditService = require("../../services/core/auditService");

// The signed-in organisation's own branches (the developer console reaches the same service through
// PlatformOrganisationService). What a person may do is decided by the routes; the plan's feature and limit are decided by
// BranchService, which answers in plain words.

// Only what a branch form carries: nothing else on the body reaches the service.
const fields = (b = {}) => ({
  code: b.code, name: b.name,
  line1: b.addressLine1 ?? b.line1, city: b.city, state: b.state, country: b.country,
  addressLine1: b.addressLine1 ?? b.line1,
  phone: b.phone, email: b.email, isActive: b.isActive,
  isHeadOffice: b.isHeadOffice, // never changeable: the service refuses it, in words, rather than the route ignoring it
});
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

exports.list = catchAsync(async (req, res) => {
  res.status(200).json({ success: true, data: await BranchService.list({ withPeople: true }) });
});

exports.create = catchAsync(async (req, res) => {
  const branch = await BranchService.create(fields(req.body), req, { by: req.admin?.id ? String(req.admin.id) : null });
  await AuditService.log({ req, action: "BRANCH_CREATED", entity: "Branch", entityId: branch.code, summary: `Branch "${branch.name}" (${branch.code}) added` });
  res.status(201).json({ success: true, data: branch });
});

exports.update = catchAsync(async (req, res) => {
  const patch = defined(fields(req.body));
  delete patch.addressLine1; // line1 carries it
  const branch = await BranchService.update(req.params.code, patch, req);
  const what = Object.keys(patch).join(", ") || "nothing";
  await AuditService.log({ req, action: "BRANCH_UPDATED", entity: "Branch", entityId: branch.code, summary: `Branch "${branch.name}" (${branch.code}) changed: ${what}` });
  res.status(200).json({ success: true, data: branch });
});
