const catchAsync = require("../../utils/catchAsync");
const UsageService = require("../../services/core/usageService");

// Who the caller's organisation is, what its plan switches on, what it has used, and where its subscription
// stands. The screens use it to hide what the plan does not include and to warn before a subscription ends.
exports.status = catchAsync(async (req, res) => {
  const status = await UsageService.status(req.organisation, new Date(), { admin: req.admin, tenant: req.tenant });
  // And who is asking, so a screen knows what this person may do without a second request.
  // role / grants are the ones for the branch being worked in; branchRoles says which branches differ and how
  const RoleService = require("../../services/core/roleService");
  const branchRoles = [];
  for (const b of req.admin.branchRoles || []) {
    const role = await RoleService.find(b.roleKey);
    branchRoles.push({ branchId: b.branchId, roleKey: b.roleKey, roleName: role?.name || null });
  }
  // How people sign in here: whether the organisation requires two-factor, and so whether THIS person must set it up before anything else works
  const security = await require("../../services/core/securityPolicyService").policy();
  const me = { id: req.admin.id, name: req.admin.name, email: req.admin.email, role: req.admin.role, grants: req.admin.grants, mustChangePassword: req.admin.mustChangePassword, twoFactorEnabled: req.admin.twoFactorEnabled, twoFactorRequired: security.requireTwoFactor && !req.admin.twoFactorEnabled, homeBranch: req.admin.homeBranch, branchRoles };
  // The organisation's rules about who may approve, so a screen can offer Confirm only to someone who could use it
  const ApprovalPolicyService = require("../../services/core/approvalPolicyService");
  const policy = {
    approvals: { ...(await ApprovalPolicyService.policy()), notesNeedApproval: await ApprovalPolicyService.notesNeedApproval() },
    security,
  };
  // Which API answered, so Settings can show it beside the app's own version without a second request -
  // the two deploy separately, so a mismatch is worth seeing.
  const build = require("../../utils/version");
  res.status(200).json({ success: true, data: { ...status, me, policy, build: { api: build.version, startedAt: build.startedAt } } });
});

// How every date this organisation PRINTS is written. It is one setting for the whole organisation
// on purpose: it used to be each browser's own, so two people printing the same invoice produced two
// different dates and the customer's copy rendered in THEIR browser's default.
exports.setDateFormat = catchAsync(async (req, res) => {
  const OrganisationService = require("../../services/core/organisationService");
  const AuditService = require("../../services/core/auditService");
  const { getTenant } = require("../../utils/tenant");
  const value = await OrganisationService.setDateFormat(getTenant().companyId, req.body?.dateFormat);
  await AuditService.log({ req, action: "ORGANISATION_DATE_FORMAT_CHANGED", entity: "Organisation", summary: `Dates are now written ${value}` });
  res.status(200).json({ success: true, data: { dateFormat: value } });
});
