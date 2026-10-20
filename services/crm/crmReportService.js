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

  /**
   * The CRM's own landing page. The counters above, plus the three lists a salesperson opens the module to see:
   * what is late, what is theirs today, and - the point of the whole module - which deals the DOCUMENTS moved on
   * their own this week, each naming the quotation or invoice that did it.
   *
   * Everything here is derived. Nothing is stored for the dashboard and nothing is computed twice: the counters are
   * `summary()` and the funnel is the same pure `rules.funnel` the pipeline board draws.
   */
  static async dashboard({ adminId = null } = {}) {
    const ActivityService = require("./activityService");
    const summary = await this.summary();
    const today = summary.today;
    const since = addDays(today, -7);
    const stages = await CrmSetupService.stages();

    const [late, mine, open, movedRows] = await Promise.all([
      ActivityService.list({ due: "overdue", limit: 10 }),
      rules.isId(adminId) ? ActivityService.list({ scope: "mine", due: "week", limit: 10 }, { adminId }) : Promise.resolve([]),
      Opportunity.find({ status: "OPEN" })
        .select("opportunityNo title customerId customerName value stageKey stageName probability expectedCloseDate ownerId ownerName")
        .limit(CAP)
        .lean(),
      // A move the automation made, still standing (an undone one is history, not news). `autoMoves` is small, so the
      // week is filtered in code rather than with a positional query nobody could read.
      Opportunity.find({ "autoMoves.0": { $exists: true } })
        .select("opportunityNo title customerName stageName autoMoves")
        .sort({ updatedAt: -1 })
        .limit(200)
        .lean(),
    ]);

    const moved = [];
    for (const deal of movedRows) {
      for (const move of deal.autoMoves || []) {
        if (move.undoneAt) continue;
        const day = move.at ? new Date(move.at).toISOString().slice(0, 10) : null;
        if (!day || day < since) continue;
        moved.push({
          dealId: String(deal._id),
          opportunityNo: deal.opportunityNo,
          title: deal.title,
          customerName: deal.customerName,
          event: move.event,
          eventLabel: rules.EVENT_LABEL[move.event] || move.event,
          from: move.from,
          to: move.to,
          stageName: deal.stageName,
          docNo: move.docNo || "",
          at: move.at,
        });
      }
    }
    moved.sort((a, b) => new Date(b.at) - new Date(a.at));

    const weighted = (o) => rules.round2((rules.num(o.value) * rules.num(rules.stageByKey(stages, o.stageKey)?.probability)) / 100);
    const topDeals = open
      .map((o) => ({ ...o, _id: String(o._id), weighted: weighted(o) }))
      .sort((a, b) => b.weighted - a.weighted)
      .slice(0, 8);

    // Who is carrying what. Open deals only: this is a picture of the load, not of past performance.
    const owners = new Map();
    for (const deal of open) {
      const key = deal.ownerName || "Unassigned";
      const row = owners.get(key) || { key, name: key, deals: 0, value: 0, weighted: 0 };
      row.deals += 1;
      row.value += rules.num(deal.value);
      row.weighted += weighted(deal);
      owners.set(key, row);
    }
    const byOwner = [...owners.values()].sort((a, b) => b.value - a.value).slice(0, 8);

    // Six months of deals won, by the month they closed in. One read, and the months with nothing still appear:
    // a gap in a trend line is information, and leaving it out would draw a flattering lie.
    const months = [];
    const [y, mo] = today.split("-").map(Number);
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(Date.UTC(y, mo - 1 - i, 1));
      months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    }
    const wonRows = await Opportunity.find({ status: "WON", closedDay: { $gte: `${months[0]}-01` } })
      .select("value closedDay")
      .limit(CAP)
      .lean();
    const totals = new Map(months.map((m) => [m, { month: m, deals: 0, value: 0 }]));
    for (const w of wonRows) {
      const row = totals.get(String(w.closedDay || "").slice(0, 7));
      if (!row) continue;
      row.deals += 1;
      row.value += rules.num(w.value);
    }
    const trend = months.map((m) => totals.get(m));

    return { ...summary, since, late, mine, moved: moved.slice(0, 8), topDeals, byOwner, trend, funnel: rules.funnel(stages, open) };
  }
}

module.exports = CrmReportService;
