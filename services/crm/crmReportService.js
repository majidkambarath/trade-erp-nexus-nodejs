// The CRM's own report: what came in, what became of it, and how well it was chased. Read-only, built from the three
// CRM collections and the organisation's pipeline, with every rate computed by the pure utils/crm.js `analysis` - so
// the figures a screen shows and the figures a test pins are the same arithmetic.
const AppError = require("../../utils/AppError");
const Lead = require("../../models/modules/crm/leadModel");
const Opportunity = require("../../models/modules/crm/opportunityModel");
const CrmActivity = require("../../models/modules/crm/crmActivityModel");
const rules = require("../../utils/crm");
const { todayInOrg, addDays, toExpiryDay } = require("../../utils/documentExpiry");
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

    // Two weeks of finished follow-ups, and where this period's enquiries came from.
    const pulseFrom = addDays(today, -13);
    const [doneRows, sourceRows] = await Promise.all([
      CrmActivity.find({
        status: "DONE",
        completedAt: { $gte: new Date(`${addDays(pulseFrom, -1)}T00:00:00.000Z`) },
      })
        .select("status completedAt")
        .limit(CAP)
        .lean(),
      Lead.find({ createdAt: { $gte: new Date(`${addDays(today, -89)}T00:00:00.000Z`) } }).select("source status").limit(CAP).lean(),
    ]);
    const pulse = rules.pulse({
      activities: doneRows.map((r) => ({ status: r.status, completedDay: r.completedAt ? toExpiryDay(r.completedAt) : null })),
      today,
      days: 14,
    });
    const sources = new Map();
    for (const l of sourceRows) {
      const key = rules.oneOf(l.source, rules.LEAD_SOURCES) || "other";
      const row = sources.get(key) || { key, name: rules.SOURCE_LABEL[key] || key, value: 0 };
      row.value += 1;
      sources.set(key, row);
    }
    const leadSources = [...sources.values()].sort((a, b) => b.value - a.value);

    return { ...summary, since, late, mine, moved: moved.slice(0, 8), topDeals, byOwner, trend, pulse, leadSources, funnel: rules.funnel(stages, open) };
  }

  /**
   * Opportunity aging: open deals by how long they have stood where they stand. It is an "as at today" picture, not
   * a period, so it takes no range - asking how old a deal was last month answers nothing anybody acts on.
   */
  static async aging() {
    const today = todayInOrg();
    const [stages, settings] = await Promise.all([CrmSetupService.stages(), CrmSetupService.settings()]);
    const open = await Opportunity.find({ status: "OPEN" })
      .select("opportunityNo title customerName stageKey stageName value ownerName stageSinceDay openedDay expectedCloseDate lastActivityDay nextActionAt")
      .limit(CAP)
      .lean();
    return { today, capped: open.length >= CAP, ...rules.aging({ opportunities: open, stages, settings, today }) };
  }

  /** Communication activity: what was actually done over a period, by person and by kind. */
  static async activity(query = {}) {
    const { from, to, today } = this.period(query);
    // Anything that happened in the window, plus everything still open: a follow-up owed is part of the picture
    // of how the team is working, whenever it was written.
    const rows = await CrmActivity.find({
      $or: [{ completedAt: { $gte: new Date(`${from}T00:00:00.000Z`), $lte: new Date(`${to}T23:59:59.999Z`) } }, { status: "OPEN" }],
    })
      .select("kind status ownerName dueAt completedAt subject")
      .limit(CAP)
      .lean();
    // The day it was finished, in the ORGANISATION's calendar - not the UTC date of the instant.
    const withDay = rows.map((r) => ({ ...r, completedDay: r.completedAt ? toExpiryDay(r.completedAt) : null }));
    return { period: { from, to, today }, capped: rows.length >= CAP, ...rules.activityReport({ activities: withDay, today }) };
  }

  /**
   * What is on the calendar between two days: follow-ups, deals closing and enquiries arriving, as one flat list the
   * screen groups by day. The range is the caller's (a month grid is about six weeks), but it is capped: a calendar
   * that can be asked for ten years answers nobody and reads everything.
   */
  static async calendar(query = {}) {
    const today = todayInOrg();
    const from = rules.day(query.from);
    const to = rules.day(query.to);
    if (!from || !to) throw fail("Say which days to show", 400, "INVALID_RANGE");
    if (from > to) throw fail("The calendar cannot start after it ends", 400, "INVALID_RANGE");
    if (rules.diffDays(from, to) > 70) throw fail("Ask for ten weeks or fewer at a time", 400, "RANGE_TOO_LONG");

    // A finished follow-up is placed by when it was DONE, which is an instant: read a day either side and let the
    // pure rule keep only what falls in the organisation's own days.
    const slackFrom = new Date(`${addDays(from, -1)}T00:00:00.000Z`);
    const slackTo = new Date(`${addDays(to, 1)}T23:59:59.999Z`);
    const [activities, deals, leads] = await Promise.all([
      CrmActivity.find({
        $or: [{ status: "OPEN", dueAt: { $gte: from, $lte: to } }, { status: "DONE", completedAt: { $gte: slackFrom, $lte: slackTo } }],
      })
        .select("kind status subject dueAt completedAt ownerId ownerName regarding meeting.startAt meeting.endAt meeting.timezone meeting.cancelledAt meeting.joinUrl meeting.where")
        .limit(CAP)
        .lean(),
      Opportunity.find({ status: "OPEN", expectedCloseDate: { $gte: from, $lte: to } })
        .select("title customerName value expectedCloseDate stageName ownerName status")
        .limit(CAP)
        .lean(),
      Lead.find({ createdAt: { $gte: slackFrom, $lte: slackTo } }).select("name company status createdAt").limit(CAP).lean(),
    ]);
    const items = rules.calendarItems({
      activities: activities.map((a) => ({ ...a, completedDay: a.completedAt ? toExpiryDay(a.completedAt) : null })),
      opportunities: deals,
      leads: leads.map((l) => ({ ...l, createdDay: toExpiryDay(l.createdAt) })),
      from,
      to,
      today,
    });
    return { today, from, to, items };
  }
}

module.exports = CrmReportService;
