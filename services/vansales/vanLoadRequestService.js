const AppError = require("../../utils/AppError");
const VanTrip = require("../../models/modules/vansales/vanTripModel");
const Stock = require("../../models/modules/stockModel");
const rules = require("../../utils/vanSales");
const kinds = require("../../utils/itemKinds");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { loadTrip } = require("./vanTripStock");
const VanSettingsService = require("./vanSettingsService");

const fail = (message, status, code, details) => new AppError(message, status, code, details);
const round3 = rules.round3;

// A load the salesman asks for (CompanySettings.vanSales.loadRequests). REQUESTED -> LOADED (the storekeeper put goods
// on the van, possibly not what was asked) -> ACCEPTED (the salesman counted them: only what he accepts becomes a load
// on his van), or REJECTED / CANCELLED. The request is never a load itself (utils/vanSales.js loadedOf counts every
// loads[] line as sellable); while LOADED it only reserves depot stock (awaitingOf, onVansAll).

const asLines = (raw) => {
  try {
    return rules.validateLoadLines(raw);
  } catch (err) {
    if (err instanceof rules.VanError) throw fail(err.message, 400, err.code, err.details);
    throw err;
  }
};

function findRequest(trip, no) {
  const n = Number(no);
  const r = Number.isInteger(n) ? (trip.loadRequests || []).find((x) => x.no === n) : null;
  if (!r) throw fail("That load request does not exist", 404, "LOAD_REQUEST_NOT_FOUND");
  return r;
}

function expect(request, status, words) {
  if (request.status !== status) throw fail(`Load request ${request.no} is ${String(request.status).toLowerCase()}, so it cannot be ${words}`, 409, "LOAD_REQUEST_NOT_OPEN", { status: request.status });
}

const note = (raw) => (typeof raw === "string" ? raw.trim().slice(0, 300) : "");

class VanLoadRequestService {
  /** The salesman asks for goods on his van: the first load or a top-up. One request open at a time. */
  static request = withTransactionSession(async (tripId, input, by, ...rest) => {
    const session = rest[rest.length - 1];
    const opts = rest.length > 1 ? rest[0] || {} : {};
    const trip = await loadTrip(tripId, session);
    if (!(await VanSettingsService.forTrip(trip, { session })).loadRequests) throw fail("This business loads its vans directly, without a request", 409, "VAN_LOAD_REQUESTS_OFF");
    if (!["LOADING", "ON_ROUTE"].includes(trip.status)) throw fail("This trip can no longer be loaded", 409, "TRIP_NOT_LOADABLE");
    const open = rules.openRequest(trip);
    if (open) throw fail(`Load request ${open.no} is still ${open.status === "LOADED" ? "waiting for you to accept it" : "waiting to be loaded"}`, 409, "LOAD_REQUEST_OPEN", { requestNo: open.no, status: open.status });
    const lines = asLines(input?.lines);
    const stocks = await Stock.find({ _id: { $in: lines.map((l) => l.stockId) } }).select("itemName itemType status").session(session).lean();
    const byId = new Map(stocks.map((s) => [String(s._id), s]));
    for (const l of lines) {
      const s = byId.get(String(l.stockId));
      if (!s || s.status === "Inactive") throw fail("An item asked for does not exist", 404, "ITEM_NOT_FOUND");
      if (kinds.isService(s)) throw fail(`${s.itemName} is a service and cannot be loaded on a van`, 400, "VAN_ITEM_NOT_STOCKED");
      l.itemName = s.itemName;
    }
    const no = (trip.loadRequests || []).reduce((m, r) => Math.max(m, r.no), 0) + 1;
    trip.loadRequests.push({
      no, status: "REQUESTED", note: note(input?.note), requestedAt: new Date(), requestedBy: String(by), requestedByName: opts.byName || "",
      lines: lines.map((l) => ({ stockId: l.stockId, itemName: l.itemName, requested: l.qty })),
    });
    trip.updatedBy = String(by);
    await trip.save({ session });
    return { trip, request: trip.loadRequests.find((r) => r.no === no) };
  });

  /** The requester (or a supervisor) takes back a request nobody has loaded yet. */
  static cancel = withTransactionSession(async (tripId, no, by, ...rest) => {
    const session = rest[rest.length - 1];
    const opts = rest.length > 1 ? rest[0] || {} : {};
    const trip = await loadTrip(tripId, session);
    const r = findRequest(trip, no);
    expect(r, "REQUESTED", "cancelled");
    Object.assign(r, { status: "CANCELLED", closedAt: new Date(), closedByName: opts.byName || "", reason: note(opts.reason) || "Cancelled by the salesman" });
    trip.updatedBy = String(by);
    await trip.save({ session });
    return { trip, request: r };
  });

  /** The storekeeper refuses a request, saying why. */
  static reject = withTransactionSession(async (tripId, no, input, by, ...rest) => {
    const session = rest[rest.length - 1];
    const opts = rest.length > 1 ? rest[0] || {} : {};
    const trip = await loadTrip(tripId, session);
    const r = findRequest(trip, no);
    expect(r, "REQUESTED", "refused");
    const reason = note(input?.reason);
    if (!reason) throw fail("Say why the request is refused", 400, "REASON_REQUIRED");
    Object.assign(r, { status: "REJECTED", closedAt: new Date(), closedByName: opts.byName || "", reason });
    trip.updatedBy = String(by);
    await trip.save({ session });
    return { trip, request: r };
  });

  /**
   * The storekeeper loads the request: what was really put on the van, line by line (he may give less, more, nothing
   * of an item, or an item not asked for). The depot must be able to spare it, exactly as a direct load. Nothing is
   * on the van for selling until the salesman accepts it.
   */
  static load = withTransactionSession(async (tripId, no, input, by, ...rest) => {
    const session = rest[rest.length - 1];
    const opts = rest.length > 1 ? rest[0] || {} : {};
    const trip = await loadTrip(tripId, session);
    if (!["LOADING", "ON_ROUTE"].includes(trip.status)) throw fail("This trip can no longer be loaded", 409, "TRIP_NOT_LOADABLE");
    const r = findRequest(trip, no);
    expect(r, "REQUESTED", "loaded");
    const raw = Array.isArray(input?.lines) ? input.lines : [];
    // a line given as 0 is "none of this"; the rest must be a load of goods like any other
    const given = raw.filter((l) => !(l && (l.qty === 0 || l.qty === "0")));
    const lines = asLines(given);
    const VanTripService = require("./vanTripService");
    await VanTripService.assertDepotCanSpare(lines, { session });
    const loaded = new Map(lines.map((l) => [String(l.stockId), l]));
    const out = r.lines.map((l) => ({ stockId: l.stockId, itemName: l.itemName, requested: l.requested, loaded: round3(loaded.get(String(l.stockId))?.qty || 0) }));
    for (const l of lines) if (!out.some((o) => String(o.stockId) === String(l.stockId))) out.push({ stockId: l.stockId, itemName: l.itemName, requested: 0, loaded: l.qty });
    r.lines = out;
    Object.assign(r, { status: "LOADED", loadedAt: new Date(), loadedBy: String(by), loadedByName: opts.byName || "" });
    trip.updatedBy = String(by);
    await trip.save({ session });
    return { trip, request: r };
  });

  /**
   * The salesman counts what he got. Only what he accepts becomes a load on his van; anything short never left the
   * depot as far as the books of the van are concerned, and the storekeeper is told. A shortfall needs a reason.
   */
  static accept = withTransactionSession(async (tripId, no, input, by, ...rest) => {
    const session = rest[rest.length - 1];
    const opts = rest.length > 1 ? rest[0] || {} : {};
    const trip = await loadTrip(tripId, session);
    if (!["LOADING", "ON_ROUTE"].includes(trip.status)) throw fail("This trip can no longer be loaded", 409, "TRIP_NOT_LOADABLE");
    const r = findRequest(trip, no);
    expect(r, "LOADED", "accepted");
    let plan;
    try {
      plan = rules.acceptPlan(r, input?.lines);
    } catch (err) {
      if (err instanceof rules.VanError) throw fail(err.message, 400, err.code, err.details);
      throw err;
    }
    const reason = note(input?.reason);
    if (plan.short.length && !reason) throw fail("Some goods are short: say what happened", 400, "SHORTFALL_REASON_REQUIRED", { short: plan.short });
    const accepted = new Map(plan.lines.map((l) => [l.stockId, l.accepted]));
    r.lines = r.lines.map((l) => ({ stockId: l.stockId, itemName: l.itemName, requested: l.requested, loaded: l.loaded, accepted: accepted.get(String(l.stockId)) ?? 0 }));
    const onVan = plan.lines.filter((l) => l.accepted > 0);
    if (onVan.length) {
      const loadNo = trip.loads.length + 1;
      trip.loads.push({ no: loadNo, kind: "load", requestNo: r.no, at: new Date(), by: String(by), byName: opts.byName || "", lines: onVan.map((l) => ({ stockId: l.stockId, itemName: l.itemName, qty: l.accepted })) });
      r.loadNo = loadNo;
    }
    Object.assign(r, { status: "ACCEPTED", acceptedAt: new Date(), acceptedBy: String(by), acceptedByName: opts.byName || "", ...(plan.short.length ? { reason } : {}) });
    trip.updatedBy = String(by);
    await trip.save({ session });
    return { trip, request: r, short: plan.short };
  });

  /**
   * The storekeeper's list: every request waiting to be loaded or to be accepted, oldest first, with what the depot
   * has free of each item asked for.
   */
  static async waiting() {
    const trips = await VanTrip.find({ status: { $in: ["LOADING", "ON_ROUTE"] }, "loadRequests.status": { $in: ["REQUESTED", "LOADED"] } })
      .select("tripNo vanCode vanName salesmanId salesmanName routeName status loadRequests").lean();
    const rows = [];
    for (const t of trips) {
      for (const r of t.loadRequests || []) {
        if (r.status !== "REQUESTED" && r.status !== "LOADED") continue;
        rows.push({ tripId: String(t._id), tripNo: t.tripNo, vanCode: t.vanCode, vanName: t.vanName, salesmanName: t.salesmanName, routeName: t.routeName, tripStatus: t.status, ...r, lines: (r.lines || []).map((l) => ({ ...l, stockId: String(l.stockId) })) });
      }
    }
    rows.sort((a, b) => new Date(a.requestedAt) - new Date(b.requestedAt));
    const ids = [...new Set(rows.flatMap((r) => r.lines.map((l) => l.stockId)))];
    if (ids.length) {
      const free = await require("../stock/reservationService").free(ids);
      for (const r of rows) for (const l of r.lines) l.free = free.get(l.stockId)?.free ?? 0;
    }
    return rows;
  }

  /** For the badges: requests waiting to be loaded (a storekeeper's), and loads waiting for THIS salesman to accept. */
  static async counts(adminId, { mayLoad = false } = {}) {
    const [toLoad, mine] = await Promise.all([
      mayLoad ? VanTrip.countDocuments({ status: { $in: ["LOADING", "ON_ROUTE"] }, "loadRequests.status": "REQUESTED" }) : 0,
      VanTrip.countDocuments({ salesmanId: String(adminId), status: { $in: ["LOADING", "ON_ROUTE"] }, "loadRequests.status": "LOADED" }),
    ]);
    return { toLoad, toAccept: mine };
  }
}

module.exports = VanLoadRequestService;
