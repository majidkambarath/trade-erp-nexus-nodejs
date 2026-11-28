const VanTrip = require("../../models/modules/vansales/vanTripModel");
const Transaction = require("../../models/modules/transactionModel");
const { Voucher } = require("../../models/modules/financial/financialModels");
const VanVisit = require("../../models/modules/vansales/vanVisitModel");
const AppError = require("../../utils/AppError");
const rules = require("../../utils/vanSales");
const { todayInOrg, addDays } = require("../../utils/documentExpiry");
const { tripMoney } = require("./vanTripFigures");

const asDay = (day) => new Date(`${String(day).slice(0, 10)}T00:00:00.000Z`);
const validDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) && !Number.isNaN(asDay(d).getTime());
const round2 = rules.round2;

// What the vans did over a period, from the documents themselves: sales and returns approved on each trip, what was
// collected, and how the day settled. One row per trip, rolled up by van and by salesman. Read-only.
class VanSalesReportService {
  static async summary({ from, to, onlySalesman = null } = {}) {
    const end = validDay(to) ? String(to).slice(0, 10) : todayInOrg();
    const start = validDay(from) ? String(from).slice(0, 10) : addDays(end, -29);
    if (start > end) throw new AppError("The period starts after it ends", 400, "INVALID_RANGE");

    const trips = await VanTrip.find({ date: { $gte: asDay(start), $lte: asDay(end) }, status: { $ne: "CANCELLED" }, ...(onlySalesman ? { salesmanId: String(onlySalesman) } : {}) }).sort({ date: -1, _id: -1 }).lean();
    const ids = trips.map((t) => t._id);
    const [buyerRows, visitRows] = ids.length
      ? await Promise.all([
          Transaction.aggregate([
            { $match: { "vanTripRef.tripId": { $in: ids }, status: "APPROVED", type: "sales_order" } },
            { $group: { _id: { trip: "$vanTripRef.tripId", party: "$partyId" } } },
          ]),
          VanVisit.aggregate([{ $match: { tripId: { $in: ids } } }, { $group: { _id: { trip: "$tripId", party: "$customerId" } } }]),
        ])
      : [[], []];
    const group = (rows) => {
      const m = new Map();
      for (const r of rows) {
        const k = String(r._id.trip);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(String(r._id.party));
      }
      return m;
    };
    const buyersByTrip = group(buyerRows);
    const visitedByTrip = group(visitRows);
    const [docs, receipts, spent] = ids.length
      ? await Promise.all([
          Transaction.aggregate([
            { $match: { "vanTripRef.tripId": { $in: ids }, status: "APPROVED", type: { $in: ["sales_order", "sales_return"] } } },
            { $group: { _id: { trip: "$vanTripRef.tripId", type: "$type" }, total: { $sum: "$totalAmount" }, count: { $sum: 1 },
              // lines that were SOLD: a promotion's free goods are price-0 lines and must not widen a basket
              lines: { $sum: { $size: { $filter: { input: { $ifNull: ["$items", []] }, cond: { $gt: [{ $ifNull: ["$$this.price", 0] }, 0] } } } } },
              net: { $sum: { $subtract: ["$totalAmount", { $add: [{ $ifNull: ["$pricing.lineVat", 0] }, { $ifNull: ["$pricing.chargesVat", 0] }] }] } } } },
          ]),
          Voucher.aggregate([
            { $match: { "vanTripRef.tripId": { $in: ids }, voucherType: "receipt", status: "approved" } },
            { $group: { _id: { trip: "$vanTripRef.tripId", mode: "$paymentMode" }, total: { $sum: "$totalAmount" } } },
          ]),
          Voucher.aggregate([
            { $match: { "vanTripRef.tripId": { $in: ids }, voucherType: "expense", status: "approved" } },
            { $group: { _id: "$vanTripRef.tripId", total: { $sum: "$totalAmount" } } },
          ]),
        ])
      : [[], [], []];
    const expenseOf = new Map(spent.map((r) => [String(r._id), r.total]));
    const sales = new Map();
    for (const d of docs) sales.set(`${d._id.trip}:${d._id.type}`, d);
    const money = new Map();
    for (const r of receipts) money.set(`${r._id.trip}:${r._id.mode}`, r.total);

    const rows = trips.map((t) => {
      const k = String(t._id);
      const tripSales = round2(sales.get(`${k}:sales_order`)?.total || 0);
      const goal = t.target && t.target.sales != null && Number(t.target.sales) > 0 ? Number(t.target.sales) : null;
      return {
        id: k, tripNo: t.tripNo, date: t.date, status: t.status, vanId: String(t.vanId), vanCode: t.vanCode, vanName: t.vanName,
        salesmanId: t.salesmanId, salesmanName: t.salesmanName, routeName: t.routeName,
        invoices: sales.get(`${k}:sales_order`)?.count || 0,
        lines: sales.get(`${k}:sales_order`)?.lines || 0,
        expenses: round2(expenseOf.get(k) || 0),
        sales: tripSales,
        netSales: round2(sales.get(`${k}:sales_order`)?.net || 0),
        salesTarget: goal,
        targetHit: goal == null ? null : tripSales >= goal,
        returned: round2(sales.get(`${k}:sales_return`)?.total || 0),
        cash: round2(money.get(`${k}:cash`) || 0),
        cheques: round2(money.get(`${k}:cheque`) || 0),
        // approved only: a transfer still waiting for the bank is not takings yet
        card: round2(money.get(`${k}:card`) || 0),
        transfer: round2(money.get(`${k}:transfer`) || 0),
        cashVariance: t.settlement?.cashVariance ?? null,
        stockVarianceValue: t.settlement?.stockVarianceValue ?? null,
        // returnable containers that did not come back to the van (absent where the organisation has none)
        containersMissing: t.settlement?.containersMissing ?? null,
        containersMissingValue: t.settlement?.containersMissingValue ?? null,
        ...rules.calls({ buyers: buyersByTrip.get(k) || [], visited: visitedByTrip.get(k) || [] }),
      };
    });
    const roll = (key, label) => {
      const m = new Map();
      for (const r of rows) {
        const cur = m.get(r[key]) || { id: r[key], name: r[label], trips: 0, invoices: 0, lines: 0, expenses: 0, sales: 0, netSales: 0, returned: 0, cash: 0, cheques: 0, card: 0, transfer: 0, cashVariance: 0, calls: 0, productive: 0, days: new Map() };
        cur.calls += r.calls;
        cur.productive += r.productive;
        cur.trips += 1;
        cur.invoices += r.invoices;
        cur.lines += r.lines;
        cur.expenses = round2(cur.expenses + r.expenses);
        cur.netSales = round2(cur.netSales + r.netSales);
        // a target is for a DAY: a van that makes two trips in one day is judged once, on both trips together
        const day = new Date(r.date).toISOString().slice(0, 10);
        const dayRow = cur.days.get(day) || { sales: 0, target: null };
        dayRow.sales = round2(dayRow.sales + r.sales);
        if (r.salesTarget != null) dayRow.target = Math.max(dayRow.target ?? 0, r.salesTarget);
        cur.days.set(day, dayRow);
        cur.sales = round2(cur.sales + r.sales);
        cur.returned = round2(cur.returned + r.returned);
        cur.cash = round2(cur.cash + r.cash);
        cur.cheques = round2(cur.cheques + r.cheques);
        cur.card = round2(cur.card + r.card);
        cur.transfer = round2(cur.transfer + r.transfer);
        cur.cashVariance = round2(cur.cashVariance + (r.cashVariance || 0));
        m.set(r[key], cur);
      }
      return [...m.values()].map(({ days, ...x }) => {
        const judged = [...days.values()].filter((d) => d.target != null);
        return { ...x, ...rules.kpis(x), daysWithTarget: judged.length, targetDays: judged.filter((d) => d.sales >= d.target).length };
      }).sort((a, b) => b.sales - a.sales);
    };
    const total0 = rows.reduce(
      (t, r) => ({ trips: t.trips + 1, invoices: t.invoices + r.invoices, lines: t.lines + r.lines, netSales: round2(t.netSales + r.netSales), expenses: round2(t.expenses + r.expenses), calls: t.calls + r.calls, productive: t.productive + r.productive, sales: round2(t.sales + r.sales), returned: round2(t.returned + r.returned), cash: round2(t.cash + r.cash), cheques: round2(t.cheques + r.cheques), card: round2(t.card + r.card), transfer: round2(t.transfer + r.transfer), cashVariance: round2(t.cashVariance + (r.cashVariance || 0)) }),
      { trips: 0, invoices: 0, lines: 0, netSales: 0, expenses: 0, calls: 0, productive: 0, sales: 0, returned: 0, cash: 0, cheques: 0, card: 0, transfer: 0, cashVariance: 0 }
    );
    const total = { ...total0, ...rules.kpis(total0) };
    const byDay = rules.salesByDay(rows.map((r) => ({ day: new Date(r.date).toISOString().slice(0, 10), sales: r.sales, invoices: r.invoices })), start, end);
    // why goods came back, from the credit notes that still stand (one deleted while the van was out is not counted),
    // each at its own total
    const recorded = trips.flatMap((t) => (t.returns || []).map((r) => r.transactionId));
    const credit = new Map(recorded.length ? (await Transaction.find({ _id: { $in: recorded }, type: "sales_return", status: "APPROVED" }).select("totalAmount").lean()).map((d) => [String(d._id), Number(d.totalAmount) || 0]) : []);
    const standing = trips.map((t) => ({ returns: (t.returns || []).filter((r) => credit.has(String(r.transactionId))).map((r) => ({ ...r, amount: credit.get(String(r.transactionId)) })) }));
    const returnsByReason = rules.returnsByReason(standing);
    return { from: start, to: end, rows, byVan: roll("vanId", "vanCode"), bySalesman: roll("salesmanId", "salesmanName"), total, byDay, returnsByReason };
  }

  /**
   * What each route (or salesman, or van) made over the SETTLED trips of a period: sales and returns net of VAT, their
   * cost of goods from the stock movements the invoices made, the damaged and expired goods and the count differences
   * written off at settlement, the road expenses, the cash short or over, and the km run. A trip not yet settled is left out: its
   * figures can still change. `by`: route (default) | salesman | van.
   */
  static async routeProfit({ from, to, by = "route", onlySalesman = null } = {}) {
    const end = validDay(to) ? String(to).slice(0, 10) : todayInOrg();
    const start = validDay(from) ? String(from).slice(0, 10) : addDays(end, -29);
    if (start > end) throw new AppError("The period starts after it ends", 400, "INVALID_RANGE");
    const trips = await VanTrip.find({ date: { $gte: asDay(start), $lte: asDay(end) }, status: "SETTLED", ...(onlySalesman ? { salesmanId: String(onlySalesman) } : {}) }).lean();
    const money = await tripMoney(trips.map((t) => t._id));
    const keyOf = (t) => (by === "salesman" ? [t.salesmanId, t.salesmanName] : by === "van" ? [String(t.vanId), `${t.vanCode} ${t.vanName || ""}`.trim()] : [t.routeId ? String(t.routeId) : "none", t.routeName || "No route"]);
    const rows = trips.map((t) => {
      const [key, name] = keyOf(t);
      const s = t.settlement || {};
      const { sales, cost, returns, returnsCost } = money.get(String(t._id));
      return {
        key, name, sales, cost, returns, returnsCost,
        // goods written off: the damaged and expired ones, plus units short at the count (a surplus counts back)
        damaged: round2(Number(s.damagedValue || 0) + Number(s.expiredValue || 0) - Number(s.stockVarianceValue || 0)),
        expenses: round2(s.expenses || 0),
        cashVariance: round2(s.cashVariance || 0),
        km: rules.kmRun(t.odometer),
      };
    });
    return { from: start, to: end, by, rows: rules.routeProfit(rows), trips: trips.length };
  }
}

module.exports = VanSalesReportService;
