const mongoose = require("mongoose");
const VanTrip = require("../../models/modules/vansales/vanTripModel");
const VanRoute = require("../../models/modules/vansales/vanRouteModel");
const VanVisit = require("../../models/modules/vansales/vanVisitModel");
const Transaction = require("../../models/modules/transactionModel");
const { Voucher } = require("../../models/modules/financial/financialModels");
const rules = require("../../utils/vanSales");
const { allBranches } = require("../../utils/tenantContext");

const isId = (v) => mongoose.isValidObjectId(v);
const DAY = 86400000;
const withSession = (q, session) => (session ? q.session(session) : q);

// A van with no route still has its own shops: the customers it sold to, took money from, took goods back from or
// called on lately. They are what the salesman's phone carries for working with no signal, what the shop list shows
// first, and the base of the suggested load's expiry check and the coverage report when there is no route. Derived
// from the trips' own documents, nothing stored; read across every branch, as stock on vans is (a van is a master).

/**
 * The van's shops, the most recent first: [{ customerId, lastAt }], at most `limit`. `days` is how far back to look.
 * `now` is for tests.
 */
async function vanCustomers(vanId, { days = 90, limit = 300, now = new Date(), session } = {}) {
  if (!isId(vanId)) return [];
  return allBranches(async () => {
    const since = new Date(now.getTime() - Math.max(1, Number(days) || 90) * DAY);
    const trips = await withSession(VanTrip.find({ vanId, date: { $gte: new Date(since.getTime() - DAY) } }).select("_id").lean(), session);
    if (!trips.length) return [];
    const tripIds = trips.map((t) => t._id);
    const [docs, receipts, visits] = await Promise.all([
      withSession(Transaction.find({ "vanTripRef.tripId": { $in: tripIds }, type: { $in: ["sales_order", "sales_return"] }, status: "APPROVED" }).select("partyId createdAt").lean(), session),
      withSession(Voucher.find({ "vanTripRef.tripId": { $in: tripIds }, voucherType: "receipt", status: { $nin: ["cancelled", "rejected"] } }).select("partyId createdAt").lean(), session),
      withSession(VanVisit.find({ tripId: { $in: tripIds } }).select("customerId at").lean(), session),
    ]);
    const events = [
      ...docs.map((d) => ({ customerId: d.partyId, at: d.createdAt })),
      ...receipts.map((v) => ({ customerId: v.partyId, at: v.createdAt })),
      ...visits.map((v) => ({ customerId: v.customerId, at: v.at })),
    ].filter((e) => e.at && new Date(e.at) >= since);
    return rules.recentCustomers(events, { limit });
  });
}

/**
 * The customers a trip should carry for working with no signal and offer first: the route's (when it has one, in its
 * order), then those the salesman asked for by name, then the van's own recent shops. Ids, each once, at most `limit`.
 */
async function tripCustomerIds(trip, { extra = [], limit = 300, session } = {}) {
  const route = trip?.routeId ? await withSession(VanRoute.findById(trip.routeId).select("customers").lean(), session) : null;
  const recent = await vanCustomers(trip?.vanId, { session });
  const ids = [
    ...(route?.customers || []).map((c) => String(c.customerId)),
    ...(extra || []).map(String),
    ...recent.map((r) => r.customerId),
  ].filter(isId);
  return [...new Set(ids)].slice(0, limit);
}

module.exports = { vanCustomers, tripCustomerIds };
