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
  const policy = { approvals: await require("../../services/core/approvalPolicyService").policy(), security };
  res.status(200).json({ success: true, data: { ...status, me, policy } });
});
