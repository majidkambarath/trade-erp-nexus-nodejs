const Staff = require("../../models/modules/staffModel");
const compliance = require("../../utils/compliance");
const orgLocale = require("../../utils/orgLocale");
const StatutoryRuleService = require("./statutoryRuleService");
const { todayInOrg } = require("../../utils/documentExpiry");

/**
 * Where the organisation stands against the UAE Emiratisation quota, read-only, UAE-mainland only (D12:
 * this service NEVER posts - a provision needs a present obligation from a past event under IAS 37, and
 * "might be fined next quarter if nothing changes" is not one. A fine, if one is ever actually paid, is an
 * ordinary expense voucher like any other bill, not something this accrues in advance).
 *
 * Not gated through utils/plans.js's feature system: nobody buys Emiratisation as an add-on, it simply has
 * nothing to say outside the UAE - the same reason the VAT return screen is hidden rather than refused for
 * an Indian organisation, but as a plain country check rather than a sold feature.
 */
class EmiratisationService {
  static isUae() {
    return orgLocale.country() === "AE";
  }

  /** The quota position today, or null for an organisation this has nothing to say about. */
  static async status({ day } = {}) {
    if (!this.isUae()) return null;
    const on = day || todayInOrg();
    const [requiredPercent, finePerPosition] = await Promise.all([
      StatutoryRuleService.valueOn("ae.emiratisation.requiredPercent", { country: "AE", day: on }),
      StatutoryRuleService.valueOn("ae.emiratisation.finePerPositionPerMonth", { country: "AE", day: on }),
    ]);
    if (requiredPercent === null || finePerPosition === null) {
      return { day: on, configured: false }; // the rule rows are missing, not that the organisation is compliant
    }
    const staff = await Staff.find({ status: "Active" }).select("nationality").lean();
    const headcount = staff.length;
    const nationals = staff.filter((s) => s.nationality === "AE").length;
    const result = compliance.emiratisationStatus({ headcount, nationals, requiredPercent, finePerPosition });
    return { day: on, configured: true, requiredPercent, finePerPosition, ...result };
  }
}

module.exports = EmiratisationService;
