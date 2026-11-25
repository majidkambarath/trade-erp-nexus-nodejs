// Scheduled checks that raise or resolve notifications for conditions nobody actively watches today (the
// Stage 4 automation audit: "no reorder or expiry alerts"). processDue() runs every live organisation's checks inside
// its own scope (services/core/organisationService.js `forEach`), from the setInterval in server.js.
//
// It is a REGISTRY now: one entry per check, each naming the module an organisation must have bought for it to run.
// With one trigger an abstraction would not have been earned; with five it is - and the `module` field is what keeps a
// CRM check from quietly doing work (and raising rows nobody can see) for an organisation that has no CRM.
const StockService = require("../stock/stockService");
const OrganisationService = require("./organisationService");
const NotificationService = require("./notificationService");
const plans = require("../../utils/plans");
const crm = require("../../utils/crm");
const { todayInOrg, addDays, toExpiryDay } = require("../../utils/documentExpiry");

/** A person-sized name for a row's audience: the deal's own owner where there is one, else everyone who may look. */
const aim = (ownerId) => ({ permission: "crm.view", adminId: ownerId || null });

class NotificationChecksService {
  /** Anything at or below its reorder level gets (or keeps) one open notification; anything no longer low
   * is resolved, so restocking an item quietly closes its own alert instead of leaving a stale one read. */
  static async checkLowStock(now = new Date()) {
    const items = await StockService.getLowStockItems();
    const active = [];
    for (const item of items) {
      const dedupeKey = `low_stock:${item._id}`;
      active.push(dedupeKey);
      const name = item.itemName || item.sku || "An item";
      await NotificationService.raise({
        kind: "low_stock",
        severity: item.currentStock <= 0 ? "critical" : "warning",
        title: `${name} is low on stock`,
        body: `${item.currentStock} left, at or below the reorder level of ${item.reorderLevel}.`,
        link: "/stock",
        dedupeKey,
        permission: "inventory.view",
        now,
      });
    }
    await NotificationService.resolveMissing({ kind: "low_stock", activeDedupeKeys: active, now });
    return { checked: items.length };
  }

  /**
   * A follow-up that is due or late, told to the person who owes it. One row per follow-up, so doing it resolves its
   * own alert - and a thing due today is told as information, a thing late as a warning, which is the difference
   * between a reminder and a reproach.
   */
  static async checkCrmFollowUps(now = new Date()) {
    const CrmActivity = require("../../models/modules/crm/crmActivityModel");
    const today = todayInOrg();
    const rows = await CrmActivity.find({ status: "OPEN", dueAt: { $lte: today } })
      .select("subject dueAt ownerId regarding")
      .limit(500)
      .lean();

    const active = [];
    for (const row of rows) {
      const dedupeKey = `crm_followup:${row._id}`;
      active.push(dedupeKey);
      const late = crm.diffDays(row.dueAt, today);
      await NotificationService.raise({
        kind: "crm_followup",
        severity: late > 0 ? "warning" : "info",
        title: late > 0 ? `${late} ${late === 1 ? "day" : "days"} late: ${row.subject}` : `Due today: ${row.subject}`,
        body: late > 0 ? `It was due on ${row.dueAt}.` : "",
        link: "/crm/follow-ups",
        dedupeKey,
        ...aim(row.ownerId),
        now,
      });
    }
    await NotificationService.resolveMissing({ kind: "crm_followup", activeDedupeKeys: active, now });
    return { checked: rows.length };
  }

  /**
   * A meeting about to start, told to its owner. Unlike a follow-up, which is a thing owed on a DAY, a meeting has an
   * hour: being told about it tomorrow is useless, and being told a week early is noise. So the window is the next
   * couple of hours, and the alert resolves by itself once the meeting has begun.
   */
  static async checkCrmMeetings(now = new Date()) {
    const CrmActivity = require("../../models/modules/crm/crmActivityModel");
    const meetings = require("../../utils/meetings");
    const orgLocale = require("../../utils/orgLocale");
    const zone = orgLocale.timezone();
    const soon = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const rows = await CrmActivity.find({
      kind: "meeting",
      status: "OPEN",
      "meeting.cancelledAt": null,
      "meeting.startAt": { $gte: now, $lte: soon },
    })
      .select("subject ownerId meeting.startAt meeting.endAt meeting.timezone meeting.joinUrl")
      .limit(200)
      .lean();

    const active = [];
    for (const row of rows) {
      const dedupeKey = `crm_meeting:${row._id}`;
      active.push(dedupeKey);
      const at = meetings.timeIn(row.meeting.startAt, row.meeting.timezone || zone);
      const minutes = Math.max(0, Math.round((new Date(row.meeting.startAt).getTime() - now.getTime()) / 60000));
      await NotificationService.raise({
        kind: "crm_meeting",
        severity: "info",
        title: minutes <= 15 ? `Starting at ${at}: ${row.subject}` : `At ${at} today: ${row.subject}`,
        body: row.meeting.joinUrl ? "A joining link is on the meeting." : "",
        link: "/crm/calendar",
        dedupeKey,
        ...aim(row.ownerId),
        now,
      });
    }
    await NotificationService.resolveMissing({ kind: "crm_meeting", activeDedupeKeys: active, now });
    return { checked: rows.length };
  }

  /**
   * A deal nothing has happened to for longer than its stage allows. Told once per deal, to its owner, and resolved by
   * itself the moment somebody does something - which is the point: the alert is the absence of activity, so activity
   * must end it.
   */
  static async checkStaleDeals(now = new Date()) {
    const Opportunity = require("../../models/modules/crm/opportunityModel");
    const CrmSetupService = require("../crm/crmSetupService");
    const today = todayInOrg();
    const [stages, settings] = await Promise.all([CrmSetupService.stages(), CrmSetupService.settings()]);
    const deals = await Opportunity.find({ status: "OPEN" })
      .select("opportunityNo title value stageKey stageName lastActivityDay stageSinceDay ownerId")
      .limit(500)
      .lean();

    const active = [];
    for (const deal of deals) {
      const stale = crm.staleOf(deal, settings, stages, today);
      if (!stale.isStale) continue;
      const dedupeKey = `crm_stale:${deal._id}`;
      active.push(dedupeKey);
      await NotificationService.raise({
        kind: "crm_stale",
        severity: "warning",
        title: `${deal.title} has gone quiet`,
        body: `Nothing for ${stale.days} days, on ${deal.stageName}.`,
        link: "/crm/pipeline",
        dedupeKey,
        ...aim(deal.ownerId),
        now,
      });
    }
    await NotificationService.resolveMissing({ kind: "crm_stale", activeDedupeKeys: active, now });
    return { checked: deals.length, stale: active.length };
  }

  /**
   * An enquiry nobody has touched. Measured in HOURS, not days, because this is the one failure a CRM exists to
   * prevent: a customer who rang and was never rung back. It is told to the whole team (no `adminId`), on purpose -
   * if the person it was given to is not acting, somebody else must see it.
   */
  static async checkUncontactedLeads(now = new Date()) {
    const Lead = require("../../models/modules/crm/leadModel");
    const CrmSetupService = require("../crm/crmSetupService");
    const settings = await CrmSetupService.settings();
    const cutoff = new Date(now.getTime() - settings.uncontactedHours * 3600 * 1000);
    const leads = await Lead.find({ status: "NEW", contactCount: 0, createdAt: { $lte: cutoff } })
      .select("leadNo name ownerName createdAt")
      .limit(200)
      .lean();

    const active = [];
    for (const lead of leads) {
      const dedupeKey = `crm_uncontacted:${lead._id}`;
      active.push(dedupeKey);
      await NotificationService.raise({
        kind: "crm_uncontacted",
        severity: "critical",
        title: `${lead.name} has not been contacted`,
        body: `${lead.leadNo} came in over ${settings.uncontactedHours} hours ago${lead.ownerName ? `, with ${lead.ownerName}` : " and nobody has it"}.`,
        link: "/crm/leads",
        dedupeKey,
        permission: "crm.view",
        now,
      });
    }
    await NotificationService.resolveMissing({ kind: "crm_uncontacted", activeDedupeKeys: active, now });
    return { checked: leads.length };
  }

  /**
   * A quotation about to lapse with the deal still open. The offer, not the deal, is what expires - so this reads the
   * quotation's own `validUntil` and says how long is left, which is the one thing a salesperson can still act on.
   */
  static async checkQuotationsExpiring(now = new Date()) {
    const Quotation = require("../../models/modules/quotationModel");
    const Opportunity = require("../../models/modules/crm/opportunityModel");
    const CrmSetupService = require("../crm/crmSetupService");
    const settings = await CrmSetupService.settings();
    const today = todayInOrg();
    const horizon = addDays(today, settings.quotationExpiryDays);

    const deals = await Opportunity.find({ status: "OPEN", "links.quotationId": { $ne: null } })
      .select("title ownerId links")
      .limit(500)
      .lean();

    const active = [];
    for (const deal of deals) {
      const quotation = await Quotation.findById(deal.links.quotationId).select("quotationNo status validUntil").lean();
      if (!quotation || quotation.status !== "SENT") continue;
      const day = quotation.validUntil ? new Date(quotation.validUntil).toISOString().slice(0, 10) : null;
      if (!day || day > horizon) continue;
      const left = crm.diffDays(today, day);
      const dedupeKey = `crm_quote_expiring:${quotation._id}`;
      active.push(dedupeKey);
      await NotificationService.raise({
        kind: "crm_quote_expiring",
        severity: left < 0 ? "warning" : "info",
        title: left < 0 ? `${quotation.quotationNo} has expired` : `${quotation.quotationNo} expires ${left === 0 ? "today" : `in ${left} ${left === 1 ? "day" : "days"}`}`,
        body: `${deal.title}: the customer has not answered.`,
        link: "/quotations",
        dedupeKey,
        ...aim(deal.ownerId),
        now,
      });
    }
    await NotificationService.resolveMissing({ kind: "crm_quote_expiring", activeDedupeKeys: active, now });
    return { checked: deals.length, expiring: active.length };
  }

  /**
   * Van loads that go through a request (CompanySettings.vanSales.loadRequests): the storekeeper is told what is waiting
   * to be loaded, the salesman (and he alone) that his load is on the van for him to count, and the storekeeper again
   * when a salesman accepted less than was loaded - that last one stays until the trip is settled.
   */
  static async checkVanLoadRequests(now = new Date()) {
    const VanTrip = require("../../models/modules/vansales/vanTripModel");
    const trips = await VanTrip.find({ status: { $in: ["LOADING", "ON_ROUTE", "UNLOADED"] }, "loadRequests.0": { $exists: true } })
      .select("tripNo vanCode salesmanId salesmanName status loadRequests").limit(300).lean();
    const active = { van_load_requested: [], van_load_ready: [], van_load_short: [] };
    const say = async (kind, row, fields) => {
      active[kind].push(fields.dedupeKey);
      await NotificationService.raise({ kind, now, ...fields });
    };
    for (const t of trips) {
      for (const r of t.loadRequests || []) {
        const key = `${t._id}:${r.no}`;
        const units = (field) => (r.lines || []).reduce((n, l) => n + (Number(l[field]) || 0), 0);
        if (r.status === "REQUESTED" && t.status !== "UNLOADED") {
          await say("van_load_requested", r, {
            severity: "info", title: `${t.vanCode} asks for a load`,
            body: `${t.salesmanName || "The salesman"} asked for ${units("requested")} units on ${t.tripNo}.`,
            link: `/van-sales/trips?open=${t._id}`, dedupeKey: `van_load_requested:${key}`, permission: "vansales.load",
          });
        } else if (r.status === "LOADED" && t.status !== "UNLOADED") {
          await say("van_load_ready", r, {
            severity: "info", title: "Your load is on the van", body: `Count what you got on ${t.tripNo} and accept it before you go out.`,
            link: "/van-sales/my-van", dedupeKey: `van_load_ready:${key}`, permission: "vansales.sell", adminId: t.salesmanId || null,
          });
        } else if (r.status === "ACCEPTED" && (r.lines || []).some((l) => Number(l.accepted) + 1e-9 < Number(l.loaded))) {
          const missing = (r.lines || []).reduce((n, l) => n + Math.max(0, (Number(l.loaded) || 0) - (Number(l.accepted) || 0)), 0);
          await say("van_load_short", r, {
            severity: "warning", title: `${t.vanCode} got less than was loaded`,
            body: `${t.salesmanName || "The salesman"} accepted ${missing} units fewer than loaded on ${t.tripNo}: ${r.reason || "no reason given"}.`,
            link: `/van-sales/trips?open=${t._id}`, dedupeKey: `van_load_short:${key}`, permission: "vansales.load",
          });
        }
      }
    }
    for (const kind of Object.keys(active)) await NotificationService.resolveMissing({ kind, activeDedupeKeys: active[kind], now });
    return { checked: trips.length };
  }

  /**
   * A job promised for a day already past, and not yet handed back. Told to whoever may act (garage.view - a
   * workshop's whole floor, not one owner: nobody "owns" a job card the way a CRM deal has one person on it).
   */
  static async checkGarageJobsOverdue(now = new Date()) {
    const JobCard = require("../../models/modules/garage/jobCardModel");
    const garage = require("../../utils/garage");
    const today = todayInOrg();
    const rows = await JobCard.find({ status: { $in: [...garage.LIVE_STATUS] }, promisedAt: { $ne: null, $lt: new Date(`${today}T00:00:00.000Z`) } })
      .select("jobNo vehicle customer promisedAt")
      .limit(300)
      .lean();

    const active = [];
    for (const row of rows) {
      const dedupeKey = `garage_job_overdue:${row._id}`;
      active.push(dedupeKey);
      const plate = row.vehicle?.plateNumber || row.vehicle?.chassisNo || "A vehicle";
      await NotificationService.raise({
        kind: "garage_job_overdue",
        severity: "warning",
        title: `${row.jobNo || "A job card"} is overdue`,
        body: `${plate} (${row.customer?.name || "no customer"}) was promised for ${row.promisedAt}.`,
        link: "/garage/board",
        dedupeKey,
        permission: "garage.view",
        now,
      });
    }
    await NotificationService.resolveMissing({ kind: "garage_job_overdue", activeDedupeKeys: active, now });
    return { checked: rows.length };
  }

  /**
   * An estimate sent and not yet decided for more than a day - the commonest reason a car sits untouched in a
   * workshop (plan part 1.4: "the daily driver"). Resolves itself the moment a decision is recorded.
   */
  static async checkGarageEstimatesWaiting(now = new Date()) {
    const JobCard = require("../../models/modules/garage/jobCardModel");
    const cutoff = new Date(now.getTime() - 24 * 3600 * 1000);
    const rows = await JobCard.find({ status: "AWAITING_APPROVAL", "estimate.sentAt": { $ne: null, $lte: cutoff } })
      .select("jobNo vehicle customer estimate.sentAt")
      .limit(300)
      .lean();

    const active = [];
    for (const row of rows) {
      const dedupeKey = `garage_estimate_waiting:${row._id}`;
      active.push(dedupeKey);
      const plate = row.vehicle?.plateNumber || row.vehicle?.chassisNo || "A vehicle";
      const hours = Math.round((now.getTime() - new Date(row.estimate.sentAt).getTime()) / 3600000);
      await NotificationService.raise({
        kind: "garage_estimate_waiting",
        severity: hours >= 48 ? "warning" : "info",
        title: `${row.jobNo || "An estimate"} is still waiting for a decision`,
        body: `${plate} (${row.customer?.name || "no customer"}): sent about ${hours} hours ago.`,
        link: "/garage/job-cards",
        dedupeKey,
        permission: "garage.view",
        now,
      });
    }
    await NotificationService.resolveMissing({ kind: "garage_estimate_waiting", activeDedupeKeys: active, now });
    return { checked: rows.length };
  }

  /**
   * A claim waiting on the insurer (submitted or surveyed, no decision yet) for more than two days - the
   * claims-ageing figure the plan calls for, as a notification rather than only a report row.
   */
  static async checkGarageClaimsWaiting(now = new Date()) {
    const InsuranceClaim = require("../../models/modules/garage/insuranceClaimModel");
    const cutoff = new Date(now.getTime() - 2 * 24 * 3600 * 1000);
    const rows = await InsuranceClaim.find({ status: { $in: ["SUBMITTED", "SURVEYED"] }, submittedAt: { $ne: null, $lte: cutoff } })
      .select("claimNo insurer submittedAt status")
      .limit(300)
      .lean();

    const active = [];
    for (const row of rows) {
      const dedupeKey = `garage_claim_waiting:${row._id}`;
      active.push(dedupeKey);
      const days = Math.max(0, Math.round((now.getTime() - new Date(row.submittedAt).getTime()) / 86400000));
      await NotificationService.raise({
        kind: "garage_claim_waiting",
        severity: days >= 7 ? "warning" : "info",
        title: `${row.claimNo || "A claim"} is still waiting on ${row.insurer?.name || "the insurer"}`,
        body: `${days} days since it was submitted (${row.status === "SURVEYED" ? "surveyed" : "awaiting survey"}).`,
        link: "/garage/claims",
        dedupeKey,
        permission: "garage.view",
        now,
      });
    }
    await NotificationService.resolveMissing({ kind: "garage_claim_waiting", activeDedupeKeys: active, now });
    return { checked: rows.length };
  }

  /**
   * A vehicle's next service, due or overdue (utils/garage.js serviceDue) - the garage's cheapest marketing
   * (plan part 1.2 step 15). Only vehicles with an interval actually set raise anything; a date OR an odometer
   * reading already past counts, whichever the owner tracks.
   */
  static async checkGarageServiceDue(now = new Date()) {
    const Vehicle = require("../../models/modules/garage/vehicleModel");
    const garage = require("../../utils/garage");
    const { addMonths } = require("../../utils/yearEnd");
    const today = todayInOrg();
    const horizon = addDays(today, 14);
    const rows = await Vehicle.find({ status: "active", $or: [{ "serviceInterval.km": { $gt: 0 } }, { "serviceInterval.months": { $gt: 0 } }] })
      .select("plateNumber chassisNo make model odometer serviceInterval lastServiceDay lastServiceOdometer")
      .limit(500)
      .lean();

    const active = [];
    for (const row of rows) {
      const due = garage.serviceDue(row, { intervalKm: row.serviceInterval?.km, intervalMonths: row.serviceInterval?.months, lastServiceDay: row.lastServiceDay, lastServiceOdometer: row.lastServiceOdometer, addMonths });
      const byDay = due.dueDay && due.dueDay <= horizon;
      const byKm = due.dueOdometer && Number(row.odometer) > 0 && Number(row.odometer) >= due.dueOdometer;
      if (!byDay && !byKm) continue;
      const dedupeKey = `garage_service_due:${row._id}`;
      active.push(dedupeKey);
      const overdue = (due.dueDay && due.dueDay < today) || byKm;
      const plate = row.plateNumber || row.chassisNo || "A vehicle";
      await NotificationService.raise({
        kind: "garage_service_due",
        severity: overdue ? "warning" : "info",
        title: `${plate} is ${overdue ? "overdue" : "due"} for its next service`,
        body: [due.dueDay ? `By ${due.dueDay}` : "", due.dueOdometer ? `${due.dueOdometer} km` : ""].filter(Boolean).join(" or "),
        link: "/garage/vehicles",
        dedupeKey,
        permission: "garage.view",
        now,
      });
    }
    await NotificationService.resolveMissing({ kind: "garage_service_due", activeDedupeKeys: active, now });
    return { checked: rows.length };
  }

  // ---- cheques. The wording and the date logic are pure (utils/chequeNotices.js); these read, raise and resolve. Told to
  // whoever may look at the cheque register (a cheque is the finance desk's business, not one person's).

  /** A cheque row as the notice builders want it: its dates as the organisation's calendar days. */
  static chequeRow(c) {
    return { ...c, chequeDay: toExpiryDay(c.chequeDate), presentedDay: c.presentedOn ? toExpiryDay(c.presentedOn) : null };
  }

  static async raiseCheque(kind, notice, now) {
    return NotificationService.raise({
      kind, severity: notice.severity, title: notice.title, body: notice.body, link: "/cheques",
      dedupeKey: `${kind}:${notice.dedupeKey}`, permission: "banking.view", now,
    });
  }

  /** Cheques still in hand that are due within a week, or past due: "deposit it" for one we hold, "keep the account
   * funded" for one we issued. Past its date is a NEW notice (see utils/chequeNotices.js), so it is told again. */
  static async checkChequesMaturing(now = new Date()) {
    const { Cheque } = require("../../models/modules/banking/bankingModels");
    const rules = require("../../utils/chequeRules");
    const notices = require("../../utils/chequeNotices");
    const today = todayInOrg();
    const upTo = new Date(`${addDays(today, rules.SOON_DAYS + 1)}T00:00:00.000Z`);
    // oldest first: if there are ever more than the cap, it is the long-overdue ones that must not be cut off
    const rows = await Cheque.find({ status: { $in: rules.IN_HAND }, chequeDate: { $lt: upTo } })
      .select("direction status chequeNo chequeDate partyName amount voucherNo holdReason").sort({ chequeDate: 1 }).limit(500).lean();
    const active = [];
    for (const n of notices.maturing(rows.map(this.chequeRow), today, { currency: require("../../utils/orgLocale").baseCurrency() })) {
      active.push(`cheque_maturing:${n.dedupeKey}`);
      await this.raiseCheque("cheque_maturing", n, now);
    }
    await NotificationService.resolveMissing({ kind: "cheque_maturing", activeDedupeKeys: active, now });
    return { checked: rows.length, told: active.length };
  }

  /** A cheque taken to the bank that has not cleared after a few days. Resolves itself the moment it clears or bounces. */
  static async checkChequesUncleared(now = new Date()) {
    const { Cheque } = require("../../models/modules/banking/bankingModels");
    const rules = require("../../utils/chequeRules");
    const notices = require("../../utils/chequeNotices");
    const today = todayInOrg();
    const upTo = new Date(`${addDays(today, 1 - rules.UNCLEARED_AFTER_DAYS)}T00:00:00.000Z`);
    const rows = await Cheque.find({ status: "deposited", presentedOn: { $ne: null, $lt: upTo } })
      .select("direction status chequeNo partyName amount voucherNo presentedOn depositSlipNo").sort({ presentedOn: 1 }).limit(500).lean();
    const active = [];
    for (const n of notices.uncleared(rows.map(this.chequeRow), today, { currency: require("../../utils/orgLocale").baseCurrency() })) {
      active.push(`cheque_uncleared:${n.dedupeKey}`);
      await this.raiseCheque("cheque_uncleared", n, now);
    }
    await NotificationService.resolveMissing({ kind: "cheque_uncleared", activeDedupeKeys: active, now });
    return { checked: rows.length, told: active.length };
  }

  /** A cheque still in hand that is about to go stale, or has. The register refuses to accept a stale cheque; this is
   * the warning that comes before it, while there is still time to deposit it or ask for a replacement. */
  static async checkChequesExpiring(now = new Date()) {
    const { Cheque } = require("../../models/modules/banking/bankingModels");
    const rules = require("../../utils/chequeRules");
    const notices = require("../../utils/chequeNotices");
    const orgLocale = require("../../utils/orgLocale");
    const validity = require("../../utils/countryRules").chequeValidityDays(orgLocale.country());
    const today = todayInOrg();
    const upTo = new Date(`${addDays(today, rules.EXPIRY_WARN_DAYS - validity + 1)}T00:00:00.000Z`);
    const rows = await Cheque.find({ status: { $in: rules.IN_HAND }, chequeDate: { $lt: upTo } })
      .select("direction status chequeNo chequeDate partyName amount voucherNo").sort({ chequeDate: 1 }).limit(500).lean();
    const active = [];
    for (const n of notices.expiring(rows.map(this.chequeRow), today, validity, { currency: orgLocale.baseCurrency() })) {
      active.push(`cheque_expiring:${n.dedupeKey}`);
      await this.raiseCheque("cheque_expiring", n, now);
    }
    await NotificationService.resolveMissing({ kind: "cheque_expiring", activeDedupeKeys: active, now });
    return { checked: rows.length, told: active.length };
  }

  // ---- money owed, bills falling due, paper running out (utils/moneyNotices.js) ---------------------------------------------------
  // Each is ONE grouped row per kind per week, so a ledger with hundreds of overdue invoices fills one line of the bell, not all of it.
  // The audience is the permission of the screen that works the problem: whoever may see sales chases customers, whoever may see
  // purchases pays suppliers. (Not finance.view: an organisation on the trade-only plan holds no finance module at all, and its
  // receivables are the first thing its owner wants to hear about.) No customer or supplier is named on a money row.

  /** An open invoice as the money notices want it: its due date as the organisation's calendar day. */
  static dueRow(i) {
    return { partyId: i.partyId, partyName: i.partyName, outstanding: i.outstanding, dueDay: toExpiryDay(i.dueDate) };
  }

  /** Raise one grouped row, keyed by the week; the key is returned so the check can tell resolveMissing what is still true. */
  static async raiseWeekly(kind, notice, { link, permission, today, now }) {
    const dedupeKey = `${kind}:${require("../../utils/moneyNotices").weekKey(today)}`;
    await NotificationService.raise({ kind, severity: notice.severity, title: notice.title, body: notice.body, link, dedupeKey, permission, now });
    return dedupeKey;
  }

  /** Customer invoices past their due day: how many, how much, how old. Closes itself when the last one is paid. */
  static async checkOverdueReceivables(now = new Date()) {
    const AgeingService = require("../financial/ageingService");
    const today = todayInOrg(now);
    const open = await AgeingService.openInvoices({ type: "receivable", asOf: now });
    const notice = require("../../utils/moneyNotices").overdueReceivables(open.map(this.dueRow), today, { currency: require("../../utils/orgLocale").baseCurrency() });
    const active = notice ? [await this.raiseWeekly("overdue_receivables", notice, { link: "/ageing", permission: "sales.view", today, now })] : [];
    await NotificationService.resolveMissing({ kind: "overdue_receivables", activeDedupeKeys: active, now });
    return { checked: open.length, told: active.length };
  }

  /** Supplier bills overdue or falling due within a week. */
  static async checkPayablesDue(now = new Date()) {
    const AgeingService = require("../financial/ageingService");
    const today = todayInOrg(now);
    const open = await AgeingService.openInvoices({ type: "payable", asOf: now });
    const notice = require("../../utils/moneyNotices").payablesDue(open.map(this.dueRow), today, { currency: require("../../utils/orgLocale").baseCurrency() });
    const active = notice ? [await this.raiseWeekly("payables_due", notice, { link: "/ageing?type=payable", permission: "purchase.view", today, now })] : [];
    await NotificationService.resolveMissing({ kind: "payables_due", activeDedupeKeys: active, now });
    return { checked: open.length, told: active.length };
  }

  /** A customer's, a supplier's or an employee's documents (licence, visa, passport) expired or expiring within 30 days. */
  static async checkDocumentsExpiring(kind, now = new Date()) {
    const DocumentExpiryService = require("../masters/documentExpiryService");
    const WITHIN = 30;
    const AUDIENCE = {
      customer: { notifyKind: "kyc_customer_documents", permission: "sales.view", link: "/kyc-documents" },
      vendor: { notifyKind: "kyc_vendor_documents", permission: "purchase.view", link: "/kyc-documents" },
      staff: { notifyKind: "staff_documents", permission: "hr.view", link: "/hr/documents" },
    }[kind];
    const today = todayInOrg(now);
    const result = await DocumentExpiryService.list({ partyType: kind, withinDays: WITHIN, now });
    const notice = require("../../utils/moneyNotices").documentsExpiring(result, kind, { withinDays: WITHIN });
    const active = notice ? [await this.raiseWeekly(AUDIENCE.notifyKind, notice, { link: AUDIENCE.link, permission: AUDIENCE.permission, today, now })] : [];
    await NotificationService.resolveMissing({ kind: AUDIENCE.notifyKind, activeDedupeKeys: active, now });
    return { checked: result.rows.length, told: active.length };
  }

  /** Batches of goods expired or expiring within 30 days, with stock still on hand. */
  static async checkBatchesExpiring(now = new Date()) {
    const BatchService = require("../stock/batchService");
    const WITHIN = 30;
    const today = todayInOrg(now);
    const batches = await BatchService.list({ expiringWithinDays: WITHIN });
    const notice = require("../../utils/moneyNotices").batchesExpiring(batches, { withinDays: WITHIN });
    const active = notice ? [await this.raiseWeekly("batches_expiring", notice, { link: "/batches", permission: "inventory.view", today, now })] : [];
    await NotificationService.resolveMissing({ kind: "batches_expiring", activeDedupeKeys: active, now });
    return { checked: batches.length, told: active.length };
  }

  /**
   * E-invoices that need a person: rejected, or failed with no automatic retry left. Keyed on the NEWEST such submission instead of
   * the week, so a new rejection is a new unread row the moment it happens, not at the start of next week; a change in the older
   * ones only updates the figures.
   */
  static async checkEinvoiceAttention(now = new Date()) {
    const { EInvoiceSubmission } = require("../../models/modules/einvoiceModels");
    const notices = require("../../utils/moneyNotices");
    const rows = await EInvoiceSubmission.find({ status: { $in: ["FAILED", "REJECTED"] } }).select("status rejectedBy nextRetryAt updatedAt").sort({ updatedAt: -1 }).limit(500).lean();
    const notice = notices.einvoiceAttention(rows);
    const active = [];
    if (notice) {
      const newest = rows.find(notices.needsAttention);
      const dedupeKey = `einvoice_attention:${newest._id}`;
      active.push(dedupeKey);
      await NotificationService.raise({ kind: "einvoice_attention", severity: notice.severity, title: notice.title, body: notice.body, link: "/e-invoicing/dashboard", dedupeKey, permission: "sales.approve", now });
    }
    await NotificationService.resolveMissing({ kind: "einvoice_attention", activeDedupeKeys: active, now });
    return { checked: rows.length, told: active.length };
  }

  /**
   * The registry. `module` is the permission module an organisation must hold for the check to run at all: a CRM
   * notification for an organisation that did not buy CRM would be work nobody can see, and a row whose audience names
   * a key nobody in that organisation can hold is a row that can never be read or resolved.
   */
  static CHECKS = [
    { key: "lowStock", module: "inventory", run: (now) => NotificationChecksService.checkLowStock(now) },
    { key: "crmFollowUps", module: "crm", run: (now) => NotificationChecksService.checkCrmFollowUps(now) },
    { key: "crmMeetings", module: "crm", run: (now) => NotificationChecksService.checkCrmMeetings(now) },
    { key: "crmStaleDeals", module: "crm", run: (now) => NotificationChecksService.checkStaleDeals(now) },
    { key: "crmUncontactedLeads", module: "crm", run: (now) => NotificationChecksService.checkUncontactedLeads(now) },
    { key: "crmQuotationsExpiring", module: "crm", run: (now) => NotificationChecksService.checkQuotationsExpiring(now) },
    { key: "vanLoadRequests", module: "vansales", run: (now) => NotificationChecksService.checkVanLoadRequests(now) },
    { key: "garageJobsOverdue", module: "garage", run: (now) => NotificationChecksService.checkGarageJobsOverdue(now) },
    { key: "garageEstimatesWaiting", module: "garage", run: (now) => NotificationChecksService.checkGarageEstimatesWaiting(now) },
    { key: "garageClaimsWaiting", module: "garage", run: (now) => NotificationChecksService.checkGarageClaimsWaiting(now) },
    { key: "garageServiceDue", module: "garage", run: (now) => NotificationChecksService.checkGarageServiceDue(now) },
    // Cheques live behind the banking FEATURE as well as the banking module, so these name both.
    { key: "chequesMaturing", module: "banking", feature: "banking", run: (now) => NotificationChecksService.checkChequesMaturing(now) },
    { key: "chequesUncleared", module: "banking", feature: "banking", run: (now) => NotificationChecksService.checkChequesUncleared(now) },
    { key: "chequesExpiring", module: "banking", feature: "banking", run: (now) => NotificationChecksService.checkChequesExpiring(now) },
    { key: "recurringInvoices", module: "sales", run: (now) => NotificationChecksService.checkRecurringInvoices(now) },
    // Payment reminders: a count to review, or (automatic mode) the daily pass. Held to every 30 minutes inside the service.
    { key: "paymentReminders", module: "sales", feature: "messaging", run: (now) => require("../messaging/paymentReminderService").check(now) },
    { key: "recurringVouchers", module: "finance", run: (now) => NotificationChecksService.checkRecurringVouchers(now) },
    { key: "emiratisationShortfall", module: "hr", run: (now) => NotificationChecksService.checkEmiratisationShortfall(now) },
    // Money and paper (utils/moneyNotices.js). They read every open invoice or document and change by the day, not by the minute, so
    // they run at most every `everyMinutes` for one organisation; the e-invoice one is quicker because a rejection is worth knowing soon.
    { key: "overdueReceivables", module: "sales", everyMinutes: 60, run: (now) => NotificationChecksService.checkOverdueReceivables(now) },
    { key: "payablesDue", module: "purchase", everyMinutes: 60, run: (now) => NotificationChecksService.checkPayablesDue(now) },
    { key: "kycCustomers", module: "sales", everyMinutes: 60, run: (now) => NotificationChecksService.checkDocumentsExpiring("customer", now) },
    { key: "kycVendors", module: "purchase", everyMinutes: 60, run: (now) => NotificationChecksService.checkDocumentsExpiring("vendor", now) },
    { key: "staffDocuments", module: "hr", everyMinutes: 60, run: (now) => NotificationChecksService.checkDocumentsExpiring("staff", now) },
    { key: "batchesExpiring", module: "inventory", feature: "batches", everyMinutes: 60, run: (now) => NotificationChecksService.checkBatchesExpiring(now) },
    { key: "einvoiceAttention", module: "sales", feature: "einvoicing", everyMinutes: 15, run: (now) => NotificationChecksService.checkEinvoiceAttention(now) },
  ];

  /** When each throttled check last ran, per organisation (`<code>:<key>` -> ms). In memory: a restart, or the free plan waking, runs each once at once. */
  static lastRun = new Map();

  /**
   * Recurring invoices: make the drafts whose day has come (services/orderPurchase/recurringInvoiceService.js), then say how many
   * drafts made that way are waiting for someone to approve, and which templates could not make theirs and why. Both notices
   * resolve themselves: the first once the drafts are approved or deleted, the second once the run succeeds.
   */
  static async checkRecurringInvoices(now = new Date()) {
    const RecurringInvoiceService = require("../orderPurchase/recurringInvoiceService");
    const RecurringInvoice = require("../../models/modules/recurringInvoiceModel");
    const Transaction = require("../../models/modules/transactionModel");
    const run = await RecurringInvoiceService.runDue(now);

    const waiting = await Transaction.countDocuments({ type: "sales_order", status: "DRAFT", "recurringRef.id": { $exists: true } });
    const drafts = [];
    if (waiting > 0) {
      drafts.push("recurring_drafts");
      await NotificationService.raise({
        kind: "recurring_drafts",
        severity: "info",
        title: waiting === 1 ? "1 recurring invoice is a draft waiting for review" : `${waiting} recurring invoices are drafts waiting for review`,
        body: "Made on schedule. Check each one and approve it to post it to the books.",
        link: "/sales-order?recurring=1",
        dedupeKey: "recurring_drafts",
        permission: "sales.approve",
        now,
      });
    }
    await NotificationService.resolveMissing({ kind: "recurring_drafts", activeDedupeKeys: drafts, now });

    const failed = await RecurringInvoice.find({ status: "ACTIVE", "lastError.message": { $exists: true } }).select("name lastError").limit(100).lean();
    const keys = [];
    for (const t of failed) {
      const dedupeKey = `recurring_failed:${t._id}`;
      keys.push(dedupeKey);
      await NotificationService.raise({
        kind: "recurring_failed",
        severity: "warning",
        title: `${t.name}: the invoice for ${t.lastError.day} could not be made`,
        body: t.lastError.message,
        link: `/recurring-invoices?open=${t._id}`,
        dedupeKey,
        permission: "sales.create",
        now,
      });
    }
    await NotificationService.resolveMissing({ kind: "recurring_failed", activeDedupeKeys: keys, now });
    return { ...run, waiting, failing: failed.length };
  }

  /**
   * Recurring journal and expense vouchers: make the pending vouchers whose day has come (services/financial/recurringVoucherService.js),
   * then say how many made that way are still waiting for approval, and which templates could not make theirs and why. Both notices
   * resolve themselves: the first once the vouchers are approved or rejected, the second once the run succeeds.
   */
  static async checkRecurringVouchers(now = new Date()) {
    const RecurringVoucherService = require("../financial/recurringVoucherService");
    const RecurringVoucher = require("../../models/modules/financial/recurringVoucherModel");
    const { Voucher } = require("../../models/modules/financial/financialModels");
    const run = await RecurringVoucherService.runDue(now);

    const waiting = await Voucher.countDocuments({ status: "pending", "recurringRef.id": { $exists: true } });
    const open = [];
    if (waiting > 0) {
      open.push("recurring_vouchers_waiting");
      await NotificationService.raise({
        kind: "recurring_vouchers_waiting",
        severity: "info",
        title: waiting === 1 ? "1 recurring voucher is waiting for approval" : `${waiting} recurring vouchers are waiting for approval`,
        body: "Made on schedule. Check each one and approve it to post it to the books.",
        link: "/approvals",
        dedupeKey: "recurring_vouchers_waiting",
        permission: "finance.approve",
        now,
      });
    }
    await NotificationService.resolveMissing({ kind: "recurring_vouchers_waiting", activeDedupeKeys: open, now });

    const failed = await RecurringVoucher.find({ status: "ACTIVE", "lastError.message": { $exists: true } }).select("name lastError").limit(100).lean();
    const keys = [];
    for (const t of failed) {
      const dedupeKey = `recurring_voucher_failed:${t._id}`;
      keys.push(dedupeKey);
      await NotificationService.raise({
        kind: "recurring_voucher_failed",
        severity: "warning",
        title: `${t.name}: the voucher for ${t.lastError.day} could not be made`,
        body: t.lastError.message,
        link: `/recurring-vouchers?open=${t._id}`,
        dedupeKey,
        permission: "finance.create",
        now,
      });
    }
    await NotificationService.resolveMissing({ kind: "recurring_voucher_failed", activeDedupeKeys: keys, now });
    return { ...run, waiting, failing: failed.length };
  }

  /**
   * One notice, resolved the moment the organisation stops being short - not a monthly reminder that keeps
   * firing while nothing changes. Carries no pay data (headcount and a shortfall count only), so it needs
   * no hr.confidential consideration: hr.view, the module floor, already decides who sees it.
   */
  static async checkEmiratisationShortfall(now = new Date()) {
    const EmiratisationService = require("../hr/emiratisationService");
    const status = await EmiratisationService.status();
    const dedupeKey = "emiratisation_shortfall";
    const active = [];
    if (status && status.configured && !status.compliant) {
      active.push(dedupeKey);
      await NotificationService.raise({
        kind: "emiratisation_shortfall",
        severity: "warning",
        title: `Short of the Emiratisation quota by ${status.shortfall}`,
        body: `${status.nationals} of ${status.required} required against ${status.headcount} mainland employees. At AED ${status.monthlyExposure.toLocaleString()} a month if nothing changes before the next checkpoint.`,
        link: "/hr/reports",
        dedupeKey,
        permission: "hr.view",
        now,
      });
    }
    await NotificationService.resolveMissing({ kind: "emiratisation_shortfall", activeDedupeKeys: active, now });
    return { checked: 1, told: active.length };
  }

  /** Every check this organisation is entitled to. One check failing never stops the others. */
  static async runAll(now = new Date(), organisation = null) {
    const results = {};
    for (const check of this.CHECKS) {
      // No organisation to judge (a direct call in a test) means run everything; otherwise the plan decides.
      if (organisation && ((check.feature && !plans.hasFeature(organisation, check.feature)) || !plans.moduleAllows(organisation, `${check.module}.view`))) {
        results[check.key] = { skipped: "not in the plan" };
        continue;
      }
      // A throttled check is judged per organisation, so with no organisation to name (a direct call in a test, or a stand-in row with
      // no code) it simply runs.
      const stamp = organisation?.code && check.everyMinutes ? `${organisation.code}:${check.key}` : null;
      if (stamp && now.getTime() - (this.lastRun.get(stamp) || 0) < check.everyMinutes * 60000) {
        results[check.key] = { skipped: "ran recently" };
        continue;
      }
      try {
        results[check.key] = await check.run(now);
        if (stamp) this.lastRun.set(stamp, now.getTime()); // only a check that finished: a failed one is tried again on the next pass
      } catch (err) {
        results[check.key] = { error: err.message };
      }
    }
    return results;
  }

  /** The background pass, every few minutes from server.js: run every live organisation's checks inside
   * its own scope. Not gated behind an optional feature - a notification feed is a core capability, like
   * the approvals queue, not an add-on - so every organisation that can still write gets the checks its plan allows. */
  static async processDue(now = new Date()) {
    return OrganisationService.forEach((code, organisation) => this.runAll(now, organisation), { label: "notification checks", now });
  }
}

module.exports = NotificationChecksService;
