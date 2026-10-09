// The organisation's approval policy (Settings -> Business rules -> Approvals) applied to a request to approve a document.
// The rules themselves are pure (utils/approvalRules.js); this reads the policy, names the person asking, and refuses.
//
// An approve with no signed-in person behind it (an internal job calling the service directly) is not judged: there is
// nobody whose limit or whose own work to test. Every route a person can reach passes their request in.
const CompanySettings = require("../../models/modules/financial/companySettingsModel");
const AppError = require("../../utils/AppError");
const { getTenant } = require("../../utils/tenant");
const orgLocale = require("../../utils/orgLocale");
const rules = require("../../utils/approvalRules");

class ApprovalPolicyService {
  /** { separateApprover, secondApprovalAbove } for the organisation in scope. */
  static async policy(session) {
    const q = CompanySettings.findOne({ companyId: getTenant().companyId }).select("approvals").lean();
    const s = await (session ? q.session(session) : q);
    return rules.normalisePolicy(s?.approvals);
  }

  /** The person behind a request, as the rules want them. null when there is none. */
  static actorOf(req) {
    if (!req?.admin?.id) return null;
    return { id: String(req.admin.id), name: req.admin.name || req.admin.email || "Someone", limit: rules.limitOf(req.admin.role?.approvalLimit) };
  }

  /**
   * Judge an approve. Throws a 403 with the reason when it is refused. Otherwise returns
   *   { final, step, of, approval }   `approval` is the record to keep ({ by, name, at, step }); `final: false` = first of two
   *   { final: true, skipped: true }  when there was nobody to judge
   */
  static async judge({ amount, preparedBy, approvals, req, session }) {
    const actor = this.actorOf(req);
    if (!actor) return { final: true, skipped: true };
    const verdict = rules.decide({
      policy: await this.policy(session),
      amount,
      preparedBy,
      approver: actor,
      approvals,
      currency: orgLocale.baseCurrency(),
    });
    if (!verdict.ok) throw new AppError(verdict.message, 403, verdict.code, verdict.details);
    return { ...verdict, approval: { by: actor.id, name: actor.name, at: new Date(), step: verdict.step } };
  }
}

module.exports = ApprovalPolicyService;
