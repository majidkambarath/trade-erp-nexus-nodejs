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
    { key: "garageJobsOverdue", module: "garage", run: (now) => NotificationChecksService.checkGarageJobsOverdue(now) },
    { key: "garageEstimatesWaiting", module: "garage", run: (now) => NotificationChecksService.checkGarageEstimatesWaiting(now) },
    { key: "garageClaimsWaiting", module: "garage", run: (now) => NotificationChecksService.checkGarageClaimsWaiting(now) },
    { key: "garageServiceDue", module: "garage", run: (now) => NotificationChecksService.checkGarageServiceDue(now) },
    // Cheques live behind the banking FEATURE as well as the banking module, so these name both.
    { key: "chequesMaturing", module: "banking", feature: "banking", run: (now) => NotificationChecksService.checkChequesMaturing(now) },
    { key: "chequesUncleared", module: "banking", feature: "banking", run: (now) => NotificationChecksService.checkChequesUncleared(now) },
    { key: "chequesExpiring", module: "banking", feature: "banking", run: (now) => NotificationChecksService.checkChequesExpiring(now) },
  ];

  /** Every check this organisation is entitled to. One check failing never stops the others. */
  static async runAll(now = new Date(), organisation = null) {
    const results = {};
    for (const check of this.CHECKS) {
      // No organisation to judge (a direct call in a test) means run everything; otherwise the plan decides.
      if (organisation && ((check.feature && !plans.hasFeature(organisation, check.feature)) || !plans.moduleAllows(organisation, `${check.module}.view`))) {
        results[check.key] = { skipped: "not in the plan" };
        continue;
      }
      try {
        results[check.key] = await check.run(now);
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
