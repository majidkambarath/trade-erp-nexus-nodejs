const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const VanTrip = require("../../models/modules/vansales/vanTripModel");
const Van = require("../../models/modules/vansales/vanModel");
const VanRoute = require("../../models/modules/vansales/vanRouteModel");
const Stock = require("../../models/modules/stockModel");
const { Voucher } = require("../../models/modules/financial/financialModels");
const rules = require("../../utils/vanSales");
const kinds = require("../../utils/itemKinds");
const NumberSeriesService = require("../core/numberSeriesService");
const JobWorkService = require("../stock/jobWorkService");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { getTenant } = require("../../utils/tenant");
const { allBranches } = require("../../utils/tenantContext");
const { todayInOrg } = require("../../utils/documentExpiry");
const { loadTrip, stockOf } = require("./vanTripStock");

const isId = (v) => mongoose.isValidObjectId(v);
const fail = (message, status, code, details) => new AppError(message, status, code, details);
const asDay = (day) => new Date(`${String(day).slice(0, 10)}T00:00:00.000Z`);
const named = (map, names) => [...map].map(([stockId, qty]) => ({ stockId, itemName: names.get(stockId) || "", qty }));

// A van trip's life: open it, load the van, send it out, call it off. Selling and collecting are vanTripSales.js,
// counting back in and settling vanTripSettlement.js. What is on the van is never stored: see vanTripStock.js.
class VanTripService {
  // ---- stock on vans (the whole organisation) ---------------------------------------------------------------------

  /**
   * What every item has sitting in vans now, in every branch (stock is organisation-wide, so a van in one branch
   * takes from the same depot as a job worker or a van in another). Map(stockId -> physical qty).
   */
  static async withOnVans({ session } = {}) {
    return allBranches(async () => {
      const q = VanTrip.find({ status: { $in: [...rules.HOLDING] } });
      const trips = await (session ? q.session(session) : q);
      if (!trips.length) return new Map();
      const per = [];
      for (const t of trips) per.push(await stockOf(t, { session }));
      return rules.onVansAll(per);
    });
  }

  // ---- reading ----------------------------------------------------------------------------------------------

  static async #names(trip) {
    const names = new Map();
    for (const load of trip.loads || []) for (const l of load.lines || []) if (l.itemName) names.set(String(l.stockId), l.itemName);
    return names;
  }

  /** The trip with its figures: what was loaded, sold and returned, and what is on the van. */
  static async present(trip, { stock } = {}) {
    const s = stock || (await stockOf(trip));
    const names = await this.#names(trip);
    const prices = new Map((await Stock.find({ _id: { $in: [...s.sellable.keys()] } }).select("salesPrice").lean()).map((x) => [String(x._id), Number(x.salesPrice) || 0]));
    const plain = typeof trip.toObject === "function" ? trip.toObject() : trip;
    const vouchers = await Voucher.find({ "vanTripRef.tripId": trip._id, voucherType: "receipt" }).select("voucherNo status paymentMode totalAmount partyId").lean();
    const live = vouchers.filter((v) => v.status === "approved");
    const sum = (rows) => rules.round2(rows.reduce((t, v) => t + (Number(v.totalAmount) || 0), 0));
    const salesTotal = rules.round2(s.invoices.reduce((t, i) => t + (Number(i.totalAmount) || 0), 0));
    const returnsTotal = rules.round2(s.returns.reduce((t, i) => t + (Number(i.totalAmount) || 0), 0));
    let route = [];
    if (trip.routeId) {
      const r = await VanRoute.findById(trip.routeId).lean();
      route = rules.routeToday(r, null, {
        sold: new Set(s.invoices.map((i) => String(i.partyId))),
        collected: new Set(live.map((v) => String(v.partyId))),
      });
    }
    return {
      ...plain,
      id: String(plain._id),
      loaded: named(s.loaded, names),
      sold: named(s.sold, names),
      sellable: named(s.sellable, names).map((l) => ({ ...l, salesPrice: prices.get(l.stockId) || 0 })),
      damaged: named(s.damaged, names),
      route,
      totals: {
        invoices: s.invoices.length,
        returns: s.returns.length,
        sales: salesTotal,
        returned: returnsTotal,
        cash: sum(live.filter((v) => v.paymentMode === "cash")),
        cheques: sum(live.filter((v) => v.paymentMode === "cheque")),
        receipts: live.length,
        pendingReceipts: vouchers.filter((v) => v.status === "pending").length,
      },
    };
  }

  static async getById(id) {
    return this.present(await loadTrip(id));
  }

  static async list(query = {}) {
    const q = {};
    if (query.status) q.status = { $in: String(query.status).split(",").filter((s) => rules.STATUSES.includes(s)) };
    if (isId(query.vanId)) q.vanId = query.vanId;
    if (query.salesmanId) q.salesmanId = String(query.salesmanId);
    if (query.from || query.to) {
      q.date = {};
      if (query.from) q.date.$gte = asDay(query.from);
      if (query.to) q.date.$lte = asDay(query.to);
    }
    const limit = Math.min(300, Math.max(1, Math.round(Number(query.limit)) || 100));
    const rows = await VanTrip.find(q).sort({ date: -1, createdAt: -1, _id: -1 }).limit(limit).lean();
    return rows.map((t) => ({
      ...t,
      id: String(t._id),
      loadedUnits: rules.round3((t.loads || []).reduce((n, l) => n + (l.lines || []).reduce((m, x) => m + (Number(x.qty) || 0), 0), 0)),
    }));
  }

  /** The salesman's own trips that are not finished: what the My van screen opens on. */
  static async mine(adminId) {
    const trips = await VanTrip.find({ salesmanId: String(adminId), status: { $in: ["LOADING", "ON_ROUTE", "UNLOADED"] } }).sort({ date: -1, _id: -1 }).limit(5);
    return Promise.all(trips.map((t) => this.present(t)));
  }

  // ---- opening and loading ----------------------------------------------------------------------------------

  static open = withTransactionSession(async (input, by, ...rest) => {
    const session = rest[rest.length - 1];
    if (!isId(input?.vanId)) throw fail("Choose a van", 400, "VAN_REQUIRED");
    const van = await Van.findById(input.vanId).session(session);
    if (!van || !van.active) throw fail("That van is not available", 404, "VAN_NOT_FOUND");
    if (await VanTrip.exists({ vanId: van._id, status: { $in: ["LOADING", "ON_ROUTE", "UNLOADED"] } }).session(session)) {
      throw fail(`${van.code} still has a trip that is not settled`, 409, "VAN_HAS_OPEN_TRIP");
    }
    const salesmanId = String(input.salesmanId || van.salesmanId || "");
    if (!salesmanId) throw fail("Choose the salesman who is taking the van out", 400, "SALESMAN_REQUIRED");
    let salesmanName = van.salesmanName;
    if (salesmanId !== van.salesmanId) {
      const Admin = require("../../models/core/adminModel");
      const a = await Admin.findOne({ _id: salesmanId, isActive: true, status: "active" }).select("name email").session(session).lean();
      if (!a) throw fail("That person is not an active user", 400, "SALESMAN_INVALID");
      salesmanName = a.name || a.email;
    }
    const routeId = input.routeId || van.defaultRouteId || null;
    let routeName = "";
    if (routeId) {
      const r = await VanRoute.findById(routeId).select("name").session(session).lean();
      if (!r) throw fail("That route does not exist", 400, "ROUTE_NOT_FOUND");
      routeName = r.name;
    }
    const day = input.date ? String(input.date).slice(0, 10) : todayInOrg();
    const { companyId, branchId } = getTenant();
    const tripNo = await NumberSeriesService.numberFor("VTR", { date: asDay(day), session, docType: "VanTrip" });
    const [trip] = await VanTrip.create(
      [{
        tripNo, vanId: van._id, vanCode: van.code, vanName: van.name, cashAccountId: van.cashAccountId,
        routeId: routeId || null, routeName, salesmanId, salesmanName, date: asDay(day),
        notes: String(input.notes || "").slice(0, 500), status: "LOADING", companyId, branchId, createdBy: String(by), updatedBy: String(by),
      }],
      { session }
    );
    return trip;
  });

  /**
   * Put stock on the van: the first load, or a top-up once it is out. Moves nothing and posts nothing; it only refuses
   * what the depot cannot spare (on hand, less what job workers and every van already hold).
   */
  static load = withTransactionSession(async (id, input, by, ...rest) => {
    const session = rest[rest.length - 1];
    const trip = await loadTrip(id, session);
    if (!["LOADING", "ON_ROUTE"].includes(trip.status)) throw fail("This trip can no longer be loaded", 409, "TRIP_NOT_LOADABLE");
    let lines;
    try {
      lines = rules.validateLoadLines(input?.lines);
    } catch (err) {
      if (err instanceof rules.VanError) throw fail(err.message, 400, err.code, err.details);
      throw err;
    }
    if (lines.some((l) => !isId(l.stockId))) throw fail("An item on the load is not valid", 400, "ITEM_INVALID");
    const ids = lines.map((l) => l.stockId);
    const stocks = await Stock.find({ _id: { $in: ids } }).select("itemName itemType currentStock").session(session).lean();
    const byId = new Map(stocks.map((s) => [String(s._id), s]));
    for (const l of lines) {
      const s = byId.get(l.stockId);
      if (!s) throw fail("An item on the load does not exist", 404, "ITEM_NOT_FOUND");
      if (kinds.isService(s)) throw fail(`${s.itemName} is a service and cannot be loaded on a van`, 400, "VAN_ITEM_NOT_STOCKED");
      l.itemName = s.itemName;
    }
    // Two people loading the same item at once must not both pass the free-stock check below: touching the item
    // makes the second transaction conflict, retry on a fresh read, and see what the first one took.
    await Stock.updateMany({ _id: { $in: ids } }, { $currentDate: { updatedAt: true } }, { session });
    const away = await JobWorkService.withJobWorker({ session });
    const onVans = await this.withOnVans({ session });
    for (const l of lines) {
      const s = byId.get(l.stockId);
      const free = rules.freeDepot({ currentStock: s.currentStock, withJobWorker: away.get(l.stockId) || 0, onVans: onVans.get(l.stockId) || 0 });
      if (l.qty > free + 1e-9) {
        throw fail(
          `Only ${free} of ${s.itemName} is free to load (${s.currentStock} on hand, ${away.get(l.stockId) || 0} with job workers, ${onVans.get(l.stockId) || 0} already on vans); this load takes ${l.qty}`,
          409, "INSUFFICIENT_STOCK", { stockId: l.stockId, free, needed: l.qty }
        );
      }
    }
    trip.loads.push({ no: trip.loads.length + 1, at: new Date(), by: String(by), byName: input?.byName || "", lines: lines.map((l) => ({ stockId: l.stockId, itemName: l.itemName, qty: l.qty })) });
    trip.updatedBy = String(by);
    await trip.save({ session });
    return trip;
  });

  /** Send the van out: from now the salesman can sell, collect and take returns. Needs at least one load. */
  static depart = withTransactionSession(async (id, by, ...rest) => {
    const session = rest[rest.length - 1];
    const trip = await loadTrip(id, session);
    if (!rules.canMove(trip.status, "ON_ROUTE")) throw fail("This trip is not waiting to go out", 409, "TRIP_NOT_LOADING");
    if (!trip.loads.length) throw fail("Load the van before it goes out", 409, "NOTHING_LOADED");
    trip.status = "ON_ROUTE";
    trip.updatedBy = String(by);
    await trip.save({ session });
    return trip;
  });

  /** Call a trip off: only while nothing has been sold, returned or collected on it. Its load simply stops counting. */
  static cancel = withTransactionSession(async (id, by, ...rest) => {
    const session = rest[rest.length - 1];
    const trip = await loadTrip(id, session);
    if (!["LOADING", "ON_ROUTE"].includes(trip.status)) throw fail("This trip can no longer be cancelled", 409, "TRIP_NOT_CANCELLABLE");
    const used = await stockOf(trip, { session });
    const anyReceipt = await Voucher.exists({ "vanTripRef.tripId": trip._id }).session(session);
    if (used.invoices.length || used.returns.length || anyReceipt || trip.returns.length) {
      throw fail("Something has been sold, returned or collected on this trip. Count the van back in and settle it instead.", 409, "TRIP_HAS_ACTIVITY");
    }
    trip.status = "CANCELLED";
    trip.updatedBy = String(by);
    await trip.save({ session });
    return trip;
  });
}

module.exports = VanTripService;
