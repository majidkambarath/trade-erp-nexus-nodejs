const AppError = require("../../utils/AppError");
const Transaction = require("../../models/modules/transactionModel");
const TradeOrder = require("../../models/modules/tradeOrderModel");
const VanTrip = require("../../models/modules/vansales/vanTripModel");
const VanRoute = require("../../models/modules/vansales/vanRouteModel");
const Stock = require("../../models/modules/stockModel");
const PriceList = require("../../models/modules/vansales/priceListModel");
const rules = require("../../utils/vanSales");
const AgeingService = require("../financial/ageingService");
const PriceListService = require("./priceListService");
const TradeOrderService = require("../orderPurchase/tradeOrderService");
const { runWithTenant } = require("../../utils/tenantContext");
const { todayInOrg } = require("../../utils/documentExpiry");

const VanSettingsService = require("./vanSettingsService");

const MAX_LINES = 20;
const notAvailable = () => new AppError("This link does not offer that.", 404, "SHARE_NOT_FOUND");

// The customer's own page for a van invoice (phase 6): what they still owe, when the van comes next, what they have
// ordered for that visit, and a short form to ask for goods on it. Reached ONLY through a valid share link (the
// secret in it is the credential: routes/messaging/shareRoutes.js), and only for an invoice raised on a van trip.
//
// Everything is read AS the organisation and branch the link names, and is narrow on purpose: invoice numbers, days,
// amounts and the items the customer may ask for at their own price - never another customer's anything, never a
// cost, never a credit limit. A request is a DRAFT sales order flagged `customer_link`; it moves nothing until the
// salesman delivers it from the van, and a customer may have only a few open at once.
class VanCustomerLinkService {
  static async #context(link) {
    if (link.sourceType !== "Transaction") throw notAvailable();
    const inv = await Transaction.findById(link.sourceId).select("type partyId vanTripRef items.itemId").lean();
    if (!inv || inv.type !== "sales_order" || !inv.vanTripRef?.tripId) throw notAvailable();
    const trip = await VanTrip.findById(inv.vanTripRef.tripId).select("routeId routeName vanCode vanId").lean();
    const route = trip?.routeId ? await VanRoute.findById(trip.routeId).select("name days customers").lean() : null;
    return { inv, trip, route, customerId: String(inv.partyId) };
  }

  /** What the customer may ask for: the items on their own price lists and those on this invoice, at their price. */
  static async #offer({ inv, trip, customerId }) {
    const listed = await PriceList.find({ active: true, customerIds: customerId }).select("lines.stockId").lean();
    const ids = [...new Set([...listed.flatMap((l) => (l.lines || []).map((x) => String(x.stockId))), ...(inv.items || []).map((l) => String(l.itemId))])].slice(0, 60);
    const stocks = await Stock.find({ _id: { $in: ids }, itemType: { $ne: "service" } }).select("itemName salesPrice status").lean();
    const live = stocks.filter((s) => !/inactive/i.test(String(s.status || "")));
    const prices = await PriceListService.pricesFor({ customerId, routeId: trip?.routeId, items: live.map((s) => ({ stockId: s._id, qty: 1, itemPrice: Number(s.salesPrice) || 0 })) });
    return live.map((s) => ({ stockId: String(s._id), name: s.itemName, price: prices.get(String(s._id))?.price ?? 0 })).sort((a, b) => a.name.localeCompare(b.name));
  }

  static async view(link) {
    return runWithTenant({ companyId: link.companyId, branchId: link.branchId }, async () => {
      const ctx = await this.#context(link);
      const { customerOrdering: ordering } = await VanSettingsService.settings();
      const open = (await AgeingService.openInvoices({ type: "receivable", partyId: ctx.customerId })).filter((r) => String(r.partyId) === ctx.customerId);
      const orders = await TradeOrder.find({ partyId: ctx.customerId, kind: "sales", "source.kind": { $in: ["van", "customer_link"] }, status: { $in: ["DRAFT", "CONFIRMED"] } }).sort({ expectedDate: 1 }).limit(10).lean();
      return {
        statement: {
          owed: rules.round2(open.reduce((t, r) => t + Number(r.outstanding || 0), 0)),
          overdue: rules.round2(open.filter((r) => Number(r.daysPastDue) > 0).reduce((t, r) => t + Number(r.outstanding || 0), 0)),
          open: open.slice(0, 20).map((r) => ({ number: r.transactionNo, date: r.date, outstanding: rules.round2(r.outstanding), overdue: Number(r.daysPastDue) > 0 })),
        },
        // a route says the day the van comes; a van with no route comes when it comes, so no day is promised
        nextVisit: ctx.route ? rules.nextRunDay(ctx.route.days, todayInOrg()) : null,
        orders: orders.map((o) => ({ orderNo: o.orderNo, expectedDate: o.expectedDate ? o.expectedDate.toISOString().slice(0, 10) : null, requested: o.source?.kind === "customer_link", items: (o.items || []).map((l) => ({ name: l.description, qty: l.qty })) })),
        // an organisation can switch off ordering through the link: the page then shows what is owed and the next visit, with no form
        canRequest: Boolean(ctx.trip) && ordering,
        items: ctx.trip && ordering ? await this.#offer(ctx) : [],
      };
    });
  }

  /** The customer asks for goods on the next visit: a DRAFT order for the salesman, from what they are offered only. */
  static async request(link, body = {}) {
    return runWithTenant({ companyId: link.companyId, branchId: link.branchId }, async () => {
      const ctx = await this.#context(link);
      const settings = await VanSettingsService.settings();
      if (!settings.customerOrdering) throw new AppError("This business does not take orders through this page.", 403, "VAN_ORDERING_OFF");
      if (!ctx.trip) throw notAvailable();
      const offer = new Map((await this.#offer(ctx)).map((i) => [i.stockId, i]));
      const raw = Array.isArray(body.lines) ? body.lines : [];
      if (raw.length > MAX_LINES) throw new AppError(`Ask for at most ${MAX_LINES} items at a time.`, 400, "TOO_MANY_LINES");
      const lines = [];
      for (const l of raw) {
        const qty = Number(l?.qty);
        if (!(qty > 0)) continue;
        if (qty > 100000) throw new AppError("That quantity is too large.", 400, "QTY_INVALID");
        const item = offer.get(String(l?.stockId || ""));
        if (!item) throw new AppError("One of those items cannot be asked for here.", 400, "ITEM_NOT_OFFERED");
        lines.push({ itemId: item.stockId, qty, price: item.price });
      }
      if (!lines.length) throw new AppError("Say how many of at least one item.", 400, "ITEMS_REQUIRED");
      const waiting = await TradeOrder.countDocuments({ partyId: ctx.customerId, "source.kind": "customer_link", status: "DRAFT" });
      if (waiting >= settings.maxOpenRequests) throw new AppError("You already have requests waiting for the van. The salesman will bring those first.", 409, "REQUEST_LIMIT");
      // the route's next run day; a van with no route is asked for the next day, and the salesman brings it when he calls
      const expected = rules.nextRunDay(ctx.route?.days, todayInOrg());
      const order = await TradeOrderService.create(
        {
          kind: "sales", partyId: ctx.customerId, date: todayInOrg(), expectedDate: expected, items: lines,
          reference: "Asked for by the customer", notes: String(body.note || "").trim().slice(0, 300) || "Asked for through the customer's own link",
        },
        "customer-link"
      );
      await TradeOrder.updateOne({ _id: order._id }, { $set: { source: { kind: "customer_link", tripId: ctx.inv.vanTripRef.tripId, ...(ctx.trip.vanId ? { vanId: ctx.trip.vanId } : {}), ...(ctx.trip.routeId ? { routeId: ctx.trip.routeId } : {}) } } });
      return { orderNo: order.orderNo, expectedDate: expected, lines: lines.length };
    });
  }
}

module.exports = VanCustomerLinkService;
