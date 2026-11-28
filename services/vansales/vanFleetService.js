const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const VanTrip = require("../../models/modules/vansales/vanTripModel");
const VanRoute = require("../../models/modules/vansales/vanRouteModel");
const VanVisit = require("../../models/modules/vansales/vanVisitModel");
const Customer = require("../../models/modules/customerModel");
const Transaction = require("../../models/modules/transactionModel");
const { Voucher } = require("../../models/modules/financial/financialModels");
const rules = require("../../utils/vanSales");
const FinancialService = require("../financial/financialService");
const AccountConfigService = require("../financial/accountConfigService");
const DefaultChartService = require("../financial/defaultChartService");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { todayInOrg } = require("../../utils/documentExpiry");
const { cleanLocation } = require("./vanVisitService");
const { loadTrip } = require("./vanTripStock");
const VanSettingsService = require("./vanSettingsService");
const { EXPENSE_KIND_DEFAULTS, findExpenseKind } = require("../../utils/vanSettings");

const isId = (v) => mongoose.isValidObjectId(v);
const fail = (message, status, code, details) => new AppError(message, status, code, details);
const withSession = (q, session) => (session ? q.session(session) : q);

// Running the fleet (phase 5): where each sale and visit happened against the shop's pinned place, the odometer, the
// money a van spends on the road from its own cash, and the supervisor's board. A location is a FLAG and never a
// refusal: a phone's reading can be poor, and a sale at the door must never fail over it.
class VanFleetService {
  /**
   * Note where the phone was when something was done for a customer. Joins the caller's session. Writes nothing, and
   * never throws, when the phone gave no usable location.
   */
  static async ping(trip, { kind, customerId, ref, location }, { session } = {}) {
    const here = cleanLocation(location);
    if (!here || !isId(customerId)) return null;
    // an organisation that does not track location keeps none, whatever a phone sends
    const active = await VanSettingsService.forTrip(trip, { session });
    if (!active.captureLocation) return null;
    const c = await withSession(Customer.findById(customerId).select("location").lean(), session);
    const flag = rules.farFrom(c?.location, here, active.farMetres);
    const row = { at: new Date(), kind, customerId, ref: ref ? String(ref).slice(0, 40) : "", ...here, ...(flag ? { distanceM: flag.distanceM, far: flag.far } : {}) };
    await VanTrip.updateOne({ _id: trip._id }, { $push: { pings: row } }, session ? { session } : undefined);
    return row;
  }

  /**
   * Pin a shop where the van is standing: once, by the salesman of the trip. A trip with a route pins only a customer
   * the route calls on; a trip with NO route (a van that sells wherever it goes) pins any shop it may sell to. Moving a
   * pin already set is a supervisor's call (`mayRepin`), so a salesman cannot move the shop to wherever he happens to be.
   */
  static async pinCustomer(tripId, customerId, location, by, { mayRepin = false } = {}) {
    const trip = await loadTrip(tripId);
    const active = await VanSettingsService.forTrip(trip);
    if (!active.captureLocation) throw fail("This business does not use the phone's location, so shops are not pinned from the van", 403, "LOCATION_OFF");
    if (!isId(customerId)) throw fail("Choose the customer", 400, "CUSTOMER_REQUIRED");
    const here = cleanLocation(location);
    if (!here) throw fail("The phone did not give a usable location. Try again outside, with location switched on.", 400, "LOCATION_REQUIRED");
    if (!mayRepin) {
      const route = trip.routeId ? await VanRoute.findById(trip.routeId).select("customers").lean() : null;
      const onRoute = (route?.customers || []).some((c) => String(c.customerId) === String(customerId));
      if (route ? !onRoute : active.customers === "route") {
        throw fail(route ? "Only a customer on this trip's route can be pinned from the van" : "This van sells only to the customers on its route, so a shop cannot be pinned from a trip with no route", 403, "CUSTOMER_NOT_ON_ROUTE");
      }
    }
    const c = await Customer.findById(customerId).select("customerName location");
    if (!c) throw fail("That customer does not exist", 404, "CUSTOMER_NOT_FOUND");
    if (c.location?.lat !== undefined && !mayRepin) throw fail(`${c.customerName} is already pinned. A supervisor can move the pin.`, 409, "LOCATION_ALREADY_SET");
    c.location = { lat: here.lat, lng: here.lng, setAt: new Date(), setBy: String(by) };
    await c.save();
    return { customerId: String(c._id), customerName: c.customerName, location: c.location };
  }

  // ---- the odometer -----------------------------------------------------------------------------------------------

  /** The reading going out (at depart) or coming back (at count-in). Back below out is refused: that is a typing slip. */
  static applyOdometer(trip, side, value) {
    const reading = (() => {
      try {
        return rules.odometerOf(value);
      } catch (err) {
        throw fail(err.message, 400, err.code);
      }
    })();
    if (reading === null) return;
    const odo = { ...(trip.odometer?.toObject?.() || trip.odometer || {}) };
    if (side === "in" && Number.isFinite(odo.out) && reading < odo.out) throw fail(`The van went out at ${odo.out} km; it cannot come back at ${reading}`, 400, "ODOMETER_BELOW_OUT");
    odo[side] = reading;
    trip.odometer = odo;
  }

  // ---- money spent on the road ------------------------------------------------------------------------------------

  /** Fuel, a toll, parking: an expense voucher paid from the van's own cash, so the cash the van must hand in is less. */
  static async expense(tripId, input = {}, by, { req } = {}) {
    try {
      await AccountConfigService.resolveAccount("van-expenses");
    } catch (err) {
      if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err;
      await DefaultChartService.provision(req); // before the transaction: the top-up commits on its own
    }
    return this.#expenseIn(tripId, input, by, { req });
  }

  static #expenseIn = withTransactionSession(async (tripId, input, by, ...rest) => {
    const session = rest[rest.length - 1];
    const opts = rest.length > 1 ? rest[0] || {} : {};
    const trip = await loadTrip(tripId, session);
    if (trip.status !== "ON_ROUTE") throw fail("Road expenses are entered while the van is out", 409, "TRIP_NOT_ON_ROUTE");
    // one of the organisation's own expense types, read live; each may post to its own account
    const kind = typeof input.kind === "string" ? findExpenseKind(await VanSettingsService.forTrip(trip, { session }), input.kind) : null;
    if (!kind) throw fail("Say what the money was spent on", 400, "EXPENSE_KIND_REQUIRED");
    const amount = rules.round2(input.amount);
    if (!(amount > 0)) throw fail("Enter the amount paid", 400, "AMOUNT_REQUIRED");
    const account = kind.accountId || (await AccountConfigService.resolveAccount("van-expenses", { session }));
    const note = String(input.note || "").trim().slice(0, 200);
    const description = `${kind.label} - van ${trip.vanCode} ${trip.tripNo}${note ? ` (${note})` : ""}`;
    const voucher = await FinancialService.createVoucher(
      {
        voucherType: "expense", ledgerBased: true, expenseAccountId: account, amount, description,
        ...(input.taxCodeId ? { taxCodeId: input.taxCodeId } : {}),
        ...(input.vatAmount !== undefined && input.vatAmount !== "" ? { vatAmount: input.vatAmount } : {}),
        paymentMode: "cash", paymentDetails: { accountId: trip.cashAccountId }, date: todayInOrg(),
      },
      by, session, { req: opts.req }
    );
    await Voucher.updateOne(
      { _id: voucher._id },
      { $set: { vanTripRef: { tripId: trip._id, tripNo: trip.tripNo }, vanRef: { vanId: trip.vanId, vanCode: trip.vanCode }, vanExpenseKind: kind.key, vanExpenseLabel: kind.label } },
      { session }
    );
    return Voucher.findById(voucher._id).session(session);
  });

  /** The road expenses of a trip: [{ id, voucherNo, kind, amount, status, description }]. */
  static async expensesOf(trip, { session } = {}) {
    const rows = await withSession(Voucher.find({ "vanTripRef.tripId": trip._id, voucherType: "expense" }).select("voucherNo status totalAmount narration description vanExpenseKind vanExpenseLabel createdAt").lean(), session);
    return rows.map((v) => ({
      id: String(v._id), voucherNo: v.voucherNo, kind: v.vanExpenseKind || "other",
      label: v.vanExpenseLabel || EXPENSE_KIND_DEFAULTS.find((k) => k.key === (v.vanExpenseKind || "other"))?.label || v.vanExpenseKind,
      amount: rules.round2(v.totalAmount), status: v.status, description: v.description || v.narration || "", at: v.createdAt,
    }));
  }

  static async tripExpenses(tripId) {
    return this.expensesOf(await loadTrip(tripId));
  }

  // ---- the supervisor's board -------------------------------------------------------------------------------------

  /**
   * Every van loading or out, and those counted in but not settled: where it is on its route, what it has sold and
   * holds in cash, when it last did anything, and whether it is quiet or has sold far from a shop.
   */
  static async board({ now = new Date() } = {}) {
    const VanTripService = require("./vanTripService");
    const trips = await VanTrip.find({ status: { $in: ["LOADING", "ON_ROUTE", "UNLOADED"] } }).sort({ date: -1, vanCode: 1 }).limit(100);
    const rows = [];
    for (const t of trips) {
      const shown = await VanTripService.present(t);
      const [inv, rec, visit] = await Promise.all([
        Transaction.findOne({ "vanTripRef.tripId": t._id }).sort({ createdAt: -1 }).select("createdAt").lean(),
        Voucher.findOne({ "vanTripRef.tripId": t._id }).sort({ createdAt: -1 }).select("createdAt").lean(),
        VanVisit.findOne({ tripId: t._id }).sort({ at: -1 }).select("at").lean(),
      ]);
      const times = [inv?.createdAt, rec?.createdAt, visit?.at, ...(t.pings || []).map((p) => p.at)].filter(Boolean).map((d) => new Date(d).getTime());
      const lastAt = times.length ? new Date(Math.max(...times)).toISOString() : null;
      const row = rules.boardRow({ status: t.status, stops: shown.route, lastAt, departedAt: t.departedAt, now, quietHours: shown.rules?.quietHours });
      const far = (t.pings || []).filter((p) => p.far);
      rows.push({
        id: String(t._id), tripNo: t.tripNo, vanCode: t.vanCode, vanName: t.vanName, salesmanName: t.salesmanName, routeName: t.routeName, status: t.status,
        ...row, totals: shown.totals,
        far: far.map((p) => ({ customerId: String(p.customerId), kind: p.kind, ref: p.ref, distanceM: p.distanceM, at: p.at })),
        lastPlace: t.pings?.length ? { lat: t.pings[t.pings.length - 1].lat, lng: t.pings[t.pings.length - 1].lng, at: t.pings[t.pings.length - 1].at } : null,
      });
    }
    const out = rows.filter((r) => r.status === "ON_ROUTE");
    return {
      at: now.toISOString(),
      counts: {
        out: out.length, loading: rows.filter((r) => r.status === "LOADING").length, toSettle: rows.filter((r) => r.status === "UNLOADED").length,
        quiet: out.filter((r) => r.quiet).length, overCash: out.filter((r) => r.totals?.cashOverLimit).length, far: out.filter((r) => r.far.length).length,
      },
      sales: rules.round2(rows.reduce((t, r) => t + (r.totals?.sales || 0), 0)),
      cash: rules.round2(rows.reduce((t, r) => t + (r.totals?.cash || 0), 0)),
      rows,
    };
  }
}

module.exports = VanFleetService;
