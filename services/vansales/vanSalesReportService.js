const VanTrip = require("../../models/modules/vansales/vanTripModel");
const Transaction = require("../../models/modules/transactionModel");
const { Voucher } = require("../../models/modules/financial/financialModels");
const VanVisit = require("../../models/modules/vansales/vanVisitModel");
const AppError = require("../../utils/AppError");
const rules = require("../../utils/vanSales");
const { todayInOrg, addDays } = require("../../utils/documentExpiry");

const asDay = (day) => new Date(`${String(day).slice(0, 10)}T00:00:00.000Z`);
const validDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || "")) && !Number.isNaN(asDay(d).getTime());
const round2 = rules.round2;

// What the vans did over a period, from the documents themselves: sales and returns approved on each trip, what was
// collected, and how the day settled. One row per trip, rolled up by van and by salesman. Read-only.
class VanSalesReportService {
  static async summary({ from, to } = {}) {
    const end = validDay(to) ? String(to).slice(0, 10) : todayInOrg();
    const start = validDay(from) ? String(from).slice(0, 10) : addDays(end, -29);
    if (start > end) throw new AppError("The period starts after it ends", 400, "INVALID_RANGE");

    const trips = await VanTrip.find({ date: { $gte: asDay(start), $lte: asDay(end) }, status: { $ne: "CANCELLED" } }).sort({ date: -1, _id: -1 }).lean();
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
    const [docs, receipts] = ids.length
      ? await Promise.all([
          Transaction.aggregate([
            { $match: { "vanTripRef.tripId": { $in: ids }, status: "APPROVED", type: { $in: ["sales_order", "sales_return"] } } },
            { $group: { _id: { trip: "$vanTripRef.tripId", type: "$type" }, total: { $sum: "$totalAmount" }, count: { $sum: 1 } } },
          ]),
          Voucher.aggregate([
            { $match: { "vanTripRef.tripId": { $in: ids }, voucherType: "receipt", status: "approved" } },
            { $group: { _id: { trip: "$vanTripRef.tripId", mode: "$paymentMode" }, total: { $sum: "$totalAmount" } } },
          ]),
        ])
      : [[], []];
    const sales = new Map();
    for (const d of docs) sales.set(`${d._id.trip}:${d._id.type}`, d);
    const money = new Map();
    for (const r of receipts) money.set(`${r._id.trip}:${r._id.mode}`, r.total);

    const rows = trips.map((t) => {
      const k = String(t._id);
      return {
        id: k, tripNo: t.tripNo, date: t.date, status: t.status, vanId: String(t.vanId), vanCode: t.vanCode, vanName: t.vanName,
        salesmanId: t.salesmanId, salesmanName: t.salesmanName, routeName: t.routeName,
        invoices: sales.get(`${k}:sales_order`)?.count || 0,
        sales: round2(sales.get(`${k}:sales_order`)?.total || 0),
        returned: round2(sales.get(`${k}:sales_return`)?.total || 0),
        cash: round2(money.get(`${k}:cash`) || 0),
        cheques: round2(money.get(`${k}:cheque`) || 0),
        cashVariance: t.settlement?.cashVariance ?? null,
        stockVarianceValue: t.settlement?.stockVarianceValue ?? null,
        ...rules.calls({ buyers: buyersByTrip.get(k) || [], visited: visitedByTrip.get(k) || [] }),
      };
    });
    const roll = (key, label) => {
      const m = new Map();
      for (const r of rows) {
        const cur = m.get(r[key]) || { id: r[key], name: r[label], trips: 0, invoices: 0, sales: 0, returned: 0, cash: 0, cheques: 0, cashVariance: 0, calls: 0, productive: 0 };
        cur.calls += r.calls;
        cur.productive += r.productive;
        cur.trips += 1;
        cur.invoices += r.invoices;
        cur.sales = round2(cur.sales + r.sales);
        cur.returned = round2(cur.returned + r.returned);
        cur.cash = round2(cur.cash + r.cash);
        cur.cheques = round2(cur.cheques + r.cheques);
        cur.cashVariance = round2(cur.cashVariance + (r.cashVariance || 0));
        m.set(r[key], cur);
      }
      return [...m.values()].map((x) => ({ ...x, strikeRate: x.calls ? Math.round((x.productive / x.calls) * 1000) / 10 : null })).sort((a, b) => b.sales - a.sales);
    };
    const total = rows.reduce(
      (t, r) => ({ trips: t.trips + 1, invoices: t.invoices + r.invoices, sales: round2(t.sales + r.sales), returned: round2(t.returned + r.returned), cash: round2(t.cash + r.cash), cheques: round2(t.cheques + r.cheques), cashVariance: round2(t.cashVariance + (r.cashVariance || 0)) }),
      { trips: 0, invoices: 0, sales: 0, returned: 0, cash: 0, cheques: 0, cashVariance: 0 }
    );
    return { from: start, to: end, rows, byVan: roll("vanId", "vanCode"), bySalesman: roll("salesmanId", "salesmanName"), total };
  }
}

module.exports = VanSalesReportService;
