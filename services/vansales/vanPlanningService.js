const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const VanTrip = require("../../models/modules/vansales/vanTripModel");
const VanRoute = require("../../models/modules/vansales/vanRouteModel");
const TradeOrder = require("../../models/modules/tradeOrderModel");
const Stock = require("../../models/modules/stockModel");
const Customer = require("../../models/modules/customerModel");
const StockBatch = require("../../models/modules/stockBatchModel");
const rules = require("../../utils/vanSales");
const kinds = require("../../utils/itemKinds");
const BatchService = require("../stock/batchService");
const JobWorkService = require("../stock/jobWorkService");
const TradeOrderService = require("../orderPurchase/tradeOrderService");
const PriceListService = require("./priceListService");
const VanSettingsService = require("./vanSettingsService");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { allBranches } = require("../../utils/tenantContext");
const { todayInOrg } = require("../../utils/documentExpiry");
const { loadTrip, documentsOf, stockOf } = require("./vanTripStock");

const isId = (v) => mongoose.isValidObjectId(v);
const fail = (message, status, code, details) => new AppError(message, status, code, details);
const dayOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d || todayInOrg()).slice(0, 10));
// where a pre-order came from: the trip, the van, and the route only when there is one (a van with no route plans by van)
const sourceOf = (trip, kind) => ({ kind, tripId: trip._id, tripNo: trip.tripNo, vanId: trip.vanId, ...(trip.routeId ? { routeId: trip.routeId } : {}) });

/** The day a pre-order is for, as the salesman typed it: a real day, from today to 90 days ahead. */
function deliveryDay(raw) {
  const day = typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.slice(0, 10)) ? raw.slice(0, 10) : "";
  const real = day && !Number.isNaN(new Date(`${day}T00:00:00Z`).getTime()) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
  const today = todayInOrg();
  if (!real) throw fail("Give the day the order is for", 400, "INVALID_DATE");
  if (day < today || day > rules.addDays(today, 90)) throw fail("An order for next time is for a day from today to 90 days ahead", 400, "INVALID_DATE");
  return day;
}

// Planning the next run of a route: the orders customers give the salesman for next time (pre-orders), what to load
// for it (each figure with the reason behind it), and a warning when the stock FEFO would hand the van expires before
// the route's customers will take it. Nothing here moves stock or posts: a pre-order is an ordinary sales order
// (TradeOrder) that the van delivers by selling against it.
class VanPlanningService {
  // ---- pre-orders -------------------------------------------------------------------------------------------------

  /**
   * A customer's order for the van's next visit, taken on this trip: a CONFIRMED sales order for the day the salesman
   * names (else the route's next run day, else tomorrow for a van with no route), priced from the customer's price
   * list, tagged with the trip, the van and the route (when there is one) so the next load can be planned from it.
   */
  static createPreorder = withTransactionSession(async (tripId, input, by, session) => {
    const trip = await loadTrip(tripId, session);
    if (!rules.HOLDING.has(trip.status)) throw fail("Orders for next time are taken while the van is out", 409, "TRIP_NOT_SELLING");
    const lines = (Array.isArray(input?.items) ? input.items : []).filter((l) => Number(l.qty) > 0);
    if (!lines.length) throw fail("Add at least one item to the order", 400, "ITEMS_REQUIRED");
    if (lines.some((l) => !isId(l.itemId))) throw fail("An item on the order is not valid", 400, "ITEM_INVALID");
    const route = trip.routeId ? await VanRoute.findById(trip.routeId).session(session).lean() : null;
    const stocks = await Stock.find({ _id: { $in: lines.map((l) => l.itemId) } }).select("itemName itemType salesPrice").session(session).lean();
    const byId = new Map(stocks.map((s) => [String(s._id), s]));
    for (const l of lines) {
      const s = byId.get(String(l.itemId));
      if (!s) throw fail("An item on the order does not exist", 404, "ITEM_NOT_FOUND");
      if (kinds.isService(s)) throw fail(`${s.itemName} is a service; a van delivers goods`, 400, "VAN_GOODS_ONLY");
    }
    const prices = await PriceListService.pricesFor({
      customerId: input.customerId, routeId: trip.routeId, session,
      items: lines.map((l) => ({ stockId: l.itemId, qty: Number(l.qty), itemPrice: Number(byId.get(String(l.itemId)).salesPrice) || 0 })),
    });
    const expected = input.expectedDate ? deliveryDay(input.expectedDate) : rules.nextRunDay(route?.days, todayInOrg());
    const order = await TradeOrderService.create(
      {
        kind: "sales", partyId: input.customerId, date: todayInOrg(), expectedDate: expected,
        items: lines.map((l) => ({ itemId: l.itemId, qty: Number(l.qty), price: prices.get(String(l.itemId)).price })),
        reference: `Van ${trip.vanCode}`,
        notes: input.notes ? String(input.notes).slice(0, 500) : `Taken on ${trip.tripNo} for the next visit`,
      },
      by, session
    );
    await TradeOrderService.confirm(order._id, {}, by, session);
    await require("./vanFleetService").ping(trip, { kind: "preorder", customerId: input.customerId, ref: order.orderNo, location: input.location }, { session });
    await TradeOrder.updateOne({ _id: order._id }, { $set: { source: sourceOf(trip, input.fromLink ? "customer_link" : "van") } }, { session });
    return TradeOrder.findById(order._id).session(session).lean();
  });

  /** Open pre-orders for a route (every branch's van may deliver one), oldest first. */
  static async preordersForRoute(routeId, { customerId } = {}) {
    if (!isId(routeId)) return [];
    return this.#openOrders({ "source.routeId": routeId }, { customerId });
  }

  /** Open pre-orders a van with no route took (or its customers asked for through their link), oldest first. */
  static async preordersForVan(vanId, { customerId } = {}) {
    if (!isId(vanId)) return [];
    return this.#openOrders({ "source.vanId": vanId, "source.routeId": null }, { customerId });
  }

  static async #openOrders(where, { customerId } = {}) {
    // confirmed orders the salesman took, and DRAFT requests the customer sent through their own link
    const q = { ...where, kind: "sales", $or: [{ status: "CONFIRMED" }, { status: "DRAFT", "source.kind": "customer_link" }] };
    if (isId(customerId)) q.partyId = customerId;
    const rows = await TradeOrder.find(q).sort({ expectedDate: 1, createdAt: 1 }).limit(300).lean();
    const names = new Map((await Customer.find({ _id: { $in: rows.map((r) => r.partyId) } }).select("customerName").lean()).map((c) => [String(c._id), c.customerName]));
    return rows.map((r) => ({
      id: String(r._id), orderNo: r.orderNo, customerId: String(r.partyId), customerName: names.get(String(r.partyId)) || "",
      expectedDate: r.expectedDate ? dayOf(r.expectedDate) : "", source: r.source?.kind || "van", totalAmount: r.totalAmount,
      items: (r.items || []).map((l) => ({ itemId: String(l.itemId), description: l.description, qty: l.qty, price: l.price })),
    }));
  }

  static async preordersForTrip(tripId, { customerId } = {}) {
    const trip = await loadTrip(tripId);
    return trip.routeId ? this.preordersForRoute(trip.routeId, { customerId }) : this.preordersForVan(trip.vanId, { customerId });
  }

  // ---- what to load -----------------------------------------------------------------------------------------------

  /**
   * What to put on the van for this trip: the open pre-orders, plus the average sold per run over the last runs, less
   * what is on the van already; capped by what the depot has free. Each line says why. A trip with a route learns from
   * that route's runs; a van with no route learns from its own last trips.
   */
  static async suggestedLoad(tripId) {
    const trip = await loadTrip(tripId);
    const active = await VanSettingsService.forTrip(trip);
    const pastOf = trip.routeId ? { routeId: trip.routeId } : { vanId: trip.vanId };
    const past = await VanTrip.find({ ...pastOf, status: "SETTLED", _id: { $ne: trip._id } }).sort({ date: -1, createdAt: -1 }).limit(active.suggestRuns);
    const history = [];
    for (const t of past) history.push(rules.soldOf((await documentsOf(t)).invoices));
    const preorders = new Map();
    for (const p of await this.preordersForTrip(trip._id)) for (const l of p.items) preorders.set(l.itemId, rules.round3((preorders.get(l.itemId) || 0) + Number(l.qty)));
    const mine = await stockOf(trip);
    const ids = [...new Set([...preorders.keys(), ...history.flatMap((h) => [...h.keys()])])];
    const stocks = await Stock.find({ _id: { $in: ids } }).select("itemName currentStock itemType").lean();
    const VanTripService = require("./vanTripService");
    const [away, onVans] = await Promise.all([JobWorkService.withJobWorker(), VanTripService.withOnVans()]);
    const free = new Map();
    const names = new Map();
    for (const s of stocks) {
      if (kinds.isService(s)) continue;
      const id = String(s._id);
      names.set(id, s.itemName);
      free.set(id, rules.freeDepot({ currentStock: s.currentStock, withJobWorker: away.get(id) || 0, onVans: onVans.get(id) || 0 }));
    }
    const lines = rules.suggestLoad({ preorders, history, onVan: mine.sellable, free, names, extraPercent: active.suggestExtraPercent }).filter((l) => names.has(l.stockId));
    return { runs: history.length, lines };
  }

  /**
   * Before loading: which lines would take batches that expire before the trip's customers will accept them (the
   * longest minimum shelf life asked by a customer on the route - or, with no route, by one of the van's own shops -
   * from the trip day). Warnings; a refusal only where the organisation set the check to block (assertExpiryOk).
   */
  static async loadCheck(tripId, input = {}) {
    const trip = await loadTrip(tripId);
    const mode = (await VanSettingsService.forTrip(trip)).expiryCheck;
    const lines = (Array.isArray(input.lines) ? input.lines : []).filter((l) => isId(l.stockId) && Number(l.qty) > 0);
    if (mode === "off" || !lines.length) return { mustLastUntil: null, warnings: [], mode };
    const route = trip.routeId ? await VanRoute.findById(trip.routeId).lean() : null;
    const custIds = route ? (route.customers || []).map((c) => c.customerId) : (await require("./vanCustomers").vanCustomers(trip.vanId)).map((c) => c.customerId);
    const shelf = custIds.length ? Math.max(0, ...(await Customer.find({ _id: { $in: custIds } }).select("minShelfLifeDays").lean()).map((c) => Number(c.minShelfLifeDays) || 0)) : 0;
    const tripDay = dayOf(trip.date);
    const mustLastUntil = rules.addDays(tripDay, shelf);
    const batches = await allBranches(() => StockBatch.find({ stockId: { $in: lines.map((l) => l.stockId) }, status: "active", qtyOnHand: { $gt: 0 } }).lean());
    const names = new Map((await Stock.find({ _id: { $in: lines.map((l) => l.stockId) } }).select("itemName").lean()).map((s) => [String(s._id), s.itemName]));
    const warnings = [];
    for (const l of lines) {
      const ordered = BatchService.eligibleInOrder(batches.filter((b) => String(b.stockId) === String(l.stockId)), { orderDate: new Date(`${tripDay}T00:00:00Z`) });
      const short = rules.expiringOnLoad(ordered.map((b) => ({ batchNo: b.batchNumber, expiryDate: b.expiryDate, qty: b.qtyOnHand })), Number(l.qty), mustLastUntil);
      if (short.length) warnings.push({ code: "EXPIRY_SOON", stockId: String(l.stockId), itemName: names.get(String(l.stockId)) || "", batches: short, message: `${short.reduce((t, b) => t + b.qty, 0)} of ${names.get(String(l.stockId)) || "this item"} would expire before ${mustLastUntil}${shelf ? ` (${route ? "customers on this route" : "this van's customers"} ask for ${shelf} days of shelf life)` : ""}` });
    }
    return { mustLastUntil, shelfLifeDays: shelf, warnings, mode };
  }

  /**
   * The strict form of the expiry check: when the organisation set it to `block`, a load that would take short-dated
   * stock is refused (a supervisor, `mayOverride`, may still load it). `warn` and `off` never refuse.
   */
  static async assertExpiryOk(tripId, input = {}, { mayOverride = false } = {}) {
    if (mayOverride) return;
    const check = await this.loadCheck(tripId, input);
    if (check.mode === "block" && check.warnings.length) {
      throw fail(`${check.warnings[0].message}. Short-dated stock cannot be loaded on a van; a supervisor can allow it.`, 409, "EXPIRY_SOON", { warnings: check.warnings });
    }
  }
}

module.exports = VanPlanningService;
