const catchAsync = require("../../utils/catchAsync");
const AccountSecurity = require("../../services/core/accountSecurityService");
const SecurityPolicyService = require("../../services/core/securityPolicyService");
const AuditService = require("../../services/core/auditService");

// Thin: each handler asks one service and answers { success, data } or { success, message }. Secrets (recovery codes, the
// setup key) are in the body of the one response that shows them and in no log, no audit row and no later read.
const ok = (res, data, message) => res.status(200).json({ success: true, ...(message ? { message } : {}), data });
// A response that carries a secret is never kept by a browser cache or a proxy.
const secret = (res) => res.set("Cache-Control", "no-store");

// Always the same answer, whether or not the address has an account (services/core/accountSecurityService.js).
exports.forgotPassword = catchAsync(async (req, res) => {
  await AccountSecurity.requestReset(req.body?.email, { ip: req.ip });
  res.status(200).json({ success: true, message: `If that address belongs to an account, a link to choose a new password is on its way. It works once, for ${AccountSecurity.RESET_MINUTES} minutes.` });
});

exports.resetPassword = catchAsync(async (req, res) => {
  await AccountSecurity.resetPassword(req.body?.token, req.body?.password, { ip: req.ip });
  res.status(200).json({ success: true, message: "Your password has been changed. Sign in with the new one." });
});

exports.twoFactorStatus = catchAsync(async (req, res) => ok(res, await AccountSecurity.twoFactorStatus(req)));

exports.beginTwoFactor = catchAsync(async (req, res) => {
  const setup = await AccountSecurity.beginTwoFactor(req, req.body || {});
  secret(res);
  await AuditService.log({ req, action: "TWO_FACTOR_SETUP_STARTED", entity: "Admin", entityId: req.admin.id, summary: `${req.admin.email} began setting up two-factor sign-in` });
  ok(res, setup);
});

exports.enableTwoFactor = catchAsync(async (req, res) => {
  const result = await AccountSecurity.enableTwoFactor(req, req.body || {});
  secret(res);
  await AuditService.log({ req, action: "TWO_FACTOR_ENABLED", entity: "Admin", entityId: req.admin.id, summary: `${req.admin.email} turned on two-factor sign-in` });
  ok(res, result, "Two-factor sign-in is on. Keep your recovery codes somewhere safe: they are shown only now.");
});

exports.disableTwoFactor = catchAsync(async (req, res) => {
  const result = await AccountSecurity.disableTwoFactor(req, req.body || {});
  await AuditService.log({ req, action: "TWO_FACTOR_DISABLED", entity: "Admin", entityId: req.admin.id, summary: `${req.admin.email} turned off two-factor sign-in` });
  ok(res, result, "Two-factor sign-in is off.");
});

exports.regenerateRecoveryCodes = catchAsync(async (req, res) => {
  const result = await AccountSecurity.regenerateRecoveryCodes(req, req.body || {});
  secret(res);
  await AuditService.log({ req, action: "TWO_FACTOR_RECOVERY_CODES_REPLACED", entity: "Admin", entityId: req.admin.id, summary: `${req.admin.email} replaced their recovery codes` });
  ok(res, result, "New recovery codes. The old ones no longer work.");
});

exports.updatePolicy = catchAsync(async (req, res) => {
  const policy = await SecurityPolicyService.update(req.body || {}, req);
  await AuditService.log({ req, action: "SECURITY_POLICY_CHANGED", entity: "CompanySettings", summary: `Sign-in policy: two-factor ${policy.requireTwoFactor ? "required for everyone" : "not required"}`, after: policy });
  ok(res, policy);
});
