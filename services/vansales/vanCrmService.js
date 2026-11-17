const CrmActivity = require("../../models/modules/crm/crmActivityModel");
const Opportunity = require("../../models/modules/crm/opportunityModel");
const Organisation = require("../../models/core/organisationModel");
const VanTrip = require("../../models/modules/vansales/vanTripModel");
const VanRoute = require("../../models/modules/vansales/vanRouteModel");
const plans = require("../../utils/plans");
const rules = require("../../utils/vanSales");
const logger = require("../../utils/logger");
const { getTenant } = require("../../utils/tenant");
const { todayInOrg } = require("../../utils/documentExpiry");

const REASON_WORDS = { closed: "shop closed", no_money: "no money", has_stock: "still has stock", refused: "did not want to buy", not_reached: "not reached", other: "no sale" };

// Every van call on the customer's CRM timeline (phase 6), when the organisation bought the CRM: a sale is a VISIT
// done, and a call that ended in no sale is a visit done plus a FOLLOW-UP for whoever owns the customer's open deal
// (else the salesman), due on the route's next run. So the account owner sees "the van called, the shop was closed"
// beside their own calls without asking.
//
// Called AFTER the van's own transaction has committed, and it never fails the caller: a van sale must never be lost
// because the CRM could not be written. Each row carries a dedupeKey (the invoice or visit id), read before inserting,
// so a phone that sends the same offline sale twice, or a retried request, writes it once.
class VanCrmService {
  static async crmBought() {
    const org = await Organisation.findOne({ code: getTenant().companyId }).lean();
    return Boolean(org) && plans.moduleAllows(org, "crm.view");
  }

  static async #once(doc) {
    if (await CrmActivity.exists({ dedupeKey: doc.dedupeKey })) return null;
    try {
      const [row] = await CrmActivity.create([{ ...doc, companyId: getTenant().companyId }]);
      return row;
    } catch (err) {
      if (err?.code === 11000) return null; // the same call written by a request a moment ago
      throw err;
    }
  }

  /**
   * kind "sale": { tripId, customerId, refId (invoice id), ref (number), total, by, byName }
   * kind "visit": { tripId, customerId, refId (visit id), reason, note, by, byName }
   * -> { logged, followUp } or null when the CRM is not bought (or anything went wrong).
   */
  static async record(kind, x) {
    try {
      if (!x?.customerId || !x?.refId || !(await this.crmBought())) return null;
      const trip = await VanTrip.findById(x.tripId).select("tripNo vanCode routeId salesmanId salesmanName").lean();
      if (!trip) return null;
      const customerId = String(x.customerId);
      const today = todayInOrg();
      const base = { regarding: { kind: "customer", id: customerId }, customerId, ownerId: String(trip.salesmanId), ownerName: trip.salesmanName || "", auto: true, createdBy: String(x.by || "system") };
      const words = kind === "sale"
        ? { subject: `Van sale ${x.ref || ""}`.trim(), notes: `Sold from van ${trip.vanCode} on ${trip.tripNo}${x.total ? ` for ${rules.round2(x.total).toFixed(2)}` : ""}.` }
        : { subject: `Van call, ${REASON_WORDS[x.reason] || "no sale"}`, notes: `${trip.vanCode} called on ${trip.tripNo}: ${REASON_WORDS[x.reason] || "no sale"}${x.note ? `. ${String(x.note).slice(0, 300)}` : ""}.` };
      const logged = await this.#once({ ...base, ...words, kind: "visit", dueAt: today, status: "DONE", completedAt: new Date(), completedBy: String(x.by || "system"), outcome: kind === "sale" ? "done" : "follow_up", dedupeKey: `van_${kind}:${x.refId}` });

      let followUp = null;
      if (kind === "visit") {
        const deal = await Opportunity.findOne({ customerId, status: "OPEN" }).sort({ updatedAt: -1 }).select("_id ownerId ownerName title").lean();
        const route = trip.routeId ? await VanRoute.findById(trip.routeId).select("days").lean() : null;
        followUp = await this.#once({
          ...base,
          regarding: deal ? { kind: "opportunity", id: String(deal._id) } : base.regarding,
          ownerId: deal?.ownerId || base.ownerId, ownerName: deal?.ownerName || base.ownerName,
          kind: "call", subject: `Follow up: the van found ${REASON_WORDS[x.reason] || "no sale"}`,
          notes: `${trip.vanCode} could not sell on ${trip.tripNo}. Call before the van's next visit.`,
          dueAt: rules.nextRunDay(route?.days, today), status: "OPEN", auto: true, dedupeKey: `van_follow:${x.refId}`,
        });
      }
      return { logged: Boolean(logged), followUp: Boolean(followUp) };
    } catch (err) {
      logger.warn?.(`[vansales] the CRM timeline was not written: ${err.message}`);
      return null;
    }
  }
}

module.exports = VanCrmService;
