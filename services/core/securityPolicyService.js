// The organisation's sign-in policy (Settings -> Security): today one rule, "everyone who signs in must use two-factor".
// Stored on the organisation's settings row (CompanySettings.security), off until the organisation chooses.
//
// Read on EVERY request of a person who has not set two-factor up (middleware/authMiddleware.js), so a change applies on the
// next request, and read as the organisation in scope: a missing settings row, or a failed read, means "no rule" only for the
// status screen; for the gate itself a failed read is an error, never a quiet pass.
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");

class SecurityPolicyService {
  /** { requireTwoFactor } of the organisation in scope. */
  static async policy() {
    const s = await CompanySettings.findOne({ companyId: getTenant().companyId }).select("security").lean();
    return { requireTwoFactor: Boolean(s?.security?.requireTwoFactor) };
  }

  /**
   * Change the policy. Turning the rule on is refused while the person turning it on has no two-factor themselves: the rule
   * would put them straight into the enrolment screen, and an organisation whose only administrator cannot complete it
   * would lock itself out.
   */
  static async update(input = {}, req) {
    const { companyId } = getTenant(req);
    const set = {};
    if (input.requireTwoFactor !== undefined) {
      if (typeof input.requireTwoFactor !== "boolean") throw new AppError("requireTwoFactor must be true or false", 400, "SECURITY_POLICY_INVALID");
      if (input.requireTwoFactor && !req.admin?.twoFactorEnabled) {
        throw new AppError("Turn on two-factor for your own account first. The rule applies to you too, and you need it set up to keep working.", 409, "TWO_FACTOR_NEEDED_FIRST");
      }
      set["security.requireTwoFactor"] = input.requireTwoFactor;
    }
    if (Object.keys(set).length) {
      // the row exists for every provisioned organisation; ensure it for one that somehow does not
      await require("../financial/accountConfigService").ensureSettings(companyId);
      await CompanySettings.updateOne({ companyId }, { $set: set });
    }
    return this.policy();
  }
}

module.exports = SecurityPolicyService;
