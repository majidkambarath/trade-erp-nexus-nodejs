// The CRM's own report: what came in, what became of it, and how well it was chased. Read-only, built from the three
// CRM collections and the organisation's pipeline, with every rate computed by the pure utils/crm.js `analysis` - so
// the figures a screen shows and the figures a test pins are the same arithmetic.
const AppError = require("../../utils/AppError");
const Lead = require("../../models/modules/crm/leadModel");
const Opportunity = require("../../models/modules/crm/opportunityModel");
const CrmActivity = require("../../models/modules/crm/crmActivityModel");
const rules = require("../../utils/crm");
const { todayInOrg, addDays } = require("../../utils/documentExpiry");
const CrmSetupService = require("./crmSetupService");

const fail = (message, status, code, details) => new AppError(message, status, code, details);
const CAP = 5000;

class CrmReportService {
  /**
   * The period, resolved the way every other report here resolves one: a range given, else the last 30 days. A
   * backwards range is refused rather than quietly answered with nothing.
   */
  static period(query = {}) {
    const today = todayInOrg();
    const to = rules.day(query.to) || today;
    const from = rules.day(query.from) || addDays(to, -29);
    if (rules.diffDays(from, to) < 0) throw fail("The period ends before it starts", 400, "INVALID_RANGE");
    return { from, to, today };
  }

  static async analysis(query = {}) {
    const { from, to, today } = this.period(query);
    const stages = await CrmSetupService.stages();
    const within = { $gte: new Date(`${from}T00:00:00.000Z`), $lte: new Date(`${to}T23:59:59.999Z`) };

    const [leads, opportunities, activities] = await Promise.all([
      Lead.find({ createdAt: within }).select("source status expectedValue ownerId ownerName band").limit(CAP).lean(),
      // Deals OPENED in the period, plus deals CLOSED in it: a month's win rate is about what was decided that month,
      // not only about what started then.
      Opportunity.find({ $or: [{ createdAt: within }, { closedDay: { $gte: from, $lte: to } }] })
        .select("status stageKey value ownerId ownerName lostReason openedDay closedDay source")
        .limit(CAP)
        .lean(),
      CrmActivity.find({ $or: [{ createdAt: within }, { completedAt: within }] })
        .select("status dueAt ownerId ownerName kind outcome")
        .limit(CAP)
        .lean(),
    ]);

    return {
      period: { from, to, today },
      ...rules.analysis({ leads, opportunities, activities, stages, today }),
      capped: leads.length >= CAP || opportunities.length >= CAP || activities.length >= CAP,
    };
  }

  /** The counters at the top of the module: today's work, and where the pipeline stands. */
  static async summary() {
    const today = todayInOrg();
    const stages = await CrmSetupService.stages();
    const [open, leads, due, overdue] = await Promise.all([
      Opportunity.find({ status: "OPEN" }).select("value stageKey lastActivityDay stageSinceDay nextActionAt").limit(CAP).lean(),
      Lead.countDocuments({ status: { $in: ["NEW", "CONTACTED", "QUALIFIED"] } }),
      CrmActivity.countDocuments({ status: "OPEN", dueAt: today }),
      CrmActivity.countDocuments({ status: "OPEN", dueAt: { $lt: today } }),
    ]);
    const settings = await CrmSetupService.settings();
    const totals = rules.weightedValue(open, stages);
    return {
      today,
      openLeads: leads,
      openDeals: open.length,
      pipelineValue: totals.value,
      weightedValue: totals.weighted,
      staleDeals: open.filter((o) => rules.staleOf(o, settings, stages, today).isStale).length,
      dueToday: due,
      overdue,
    };
  }
}

module.exports = CrmReportService;
