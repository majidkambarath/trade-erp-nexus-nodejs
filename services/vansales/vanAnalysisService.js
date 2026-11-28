// The van analysis reports (Van sales > Analysis). Read-only: it reads the documents, utils/vanAnalysis.js adds them up.
// Trip figures are filed on the trip's day; an office expense tagged to a van on its voucher's day. A salesman sees his
// own trips and no office expenses, and a person who may not see costs gets no figure made from cost.
const AppError = require("../../utils/AppError");
const VanTrip = require("../../models/modules/vansales/vanTripModel");
const Van = require("../../models/modules/vansales/vanModel");
const VanRoute = require("../../models/modules/vansales/vanRouteModel");
const VanVisit = require("../../models/modules/vansales/vanVisitModel");
const Transaction = require("../../models/modules/transactionModel");
const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const Stock = require("../../models/modules/stockModel");
const Category = require("../../models/modules/categoryModel");
const Customer = require("../../models/modules/customerModel");
const { Voucher } = require("../../models/modules/financial/financialModels");
const rules = require("../../utils/vanAnalysis");
const vanRules = require("../../utils/vanSales");
const tz = require("../../utils/tz");
const orgLocale = require("../../utils/orgLocale");
const { todayInOrg, addDays } = require("../../utils/documentExpiry");
const VanSettingsService = require("./vanSettingsService");
const { tripMoney, netOf } = require("./vanTripFigures");

const round2 = vanRules.round2;
const round3 = vanRules.round3;
const num = (n) => Number(n) || 0;
const id = (v) => String(v?._id || v || "");
const asDay = (day) => new Date(`${day}T00:00:00.000Z`);
const dayOf = (date) => new Date(date).toISOString().slice(0, 10); // a document's date is a day at UTC midnight
const within = (from, to) => ({ $gte: asDay(from), $lt: asDay(addDays(to, 1)) });
const REGISTER_MAX = 2000;
const EXPENSE_FIELDS = "voucherNo date status totalAmount subtotal vatTotal paymentMode paymentDetails.accountName description vanTripRef vanRef vanExpenseKind vanExpenseLabel";

const lineNet = (l) => (l.taxableAmount !== undefined && l.taxableAmount !== null ? num(l.taxableAmount) : num(l.lineTotal) - num(l.vatAmount));
const goodsLines = (doc) => (doc.items || []).filter((l) => l.itemType !== "service");

function read(query) {
  try {
    return rules.readQuery(query, todayInOrg());
  } catch (err) {
    if (err instanceof rules.AnalysisError) throw new AppError(err.message, 400, err.code);
    throw err;
  }
}

/** The query, narrowed to what this person may see. viewer: { onlySalesman, showCost }. */
function contextOf(query, viewer = {}) {
  const q = read(query);
  if (viewer.onlySalesman) q.salesmanId = String(viewer.onlySalesman);
  // an office bill belongs to a van, not to a salesman or a route: counted only when neither narrows the report
  const office = viewer.onlySalesman ? "hidden_seller" : q.salesmanId || q.routeId ? "hidden_filter" : "included";
  return { q, office, showCost: viewer.showCost !== false };
}

/** The envelope every report answers with; cost-derived figures leave it for a person who may not see them. */
function answer({ q, office, showCost }, data) {
  const body = {
    from: q.from, to: q.to, filters: { vanId: q.vanId, salesmanId: q.salesmanId, routeId: q.routeId },
    officeExpenses: office, costHidden: !showCost, ...data,
  };
  return showCost ? body : rules.withoutCost(body);
}

async function tripsIn({ from, to, vanId, salesmanId, routeId }) {
  const q = { date: { $gte: asDay(from), $lte: asDay(to) }, status: { $ne: "CANCELLED" } };
  if (vanId) q.vanId = vanId;
  if (salesmanId) q.salesmanId = salesmanId;
  if (routeId) q.routeId = routeId;
  return VanTrip.find(q).sort({ date: 1, _id: 1 }).lean();
}

async function vanNames(vanIds) {
  const ids = [...new Set(vanIds.filter(Boolean))];
  if (!ids.length) return new Map();
  return new Map((await Van.find({ _id: { $in: ids } }).select("code name").lean()).map((v) => [id(v), v]));
}

/** Approved and pending road expenses of these trips, and (where counted) the office's expenses tagged to a van. */
async function expensesOf(trips, { q, office }) {
  const tripIds = trips.map((t) => t._id);
  const [road, tagged] = await Promise.all([
    tripIds.length ? Voucher.find({ voucherType: "expense", "vanTripRef.tripId": { $in: tripIds }, status: { $in: ["approved", "pending"] } }).select(EXPENSE_FIELDS).lean() : [],
    office === "included"
      ? Voucher.find({ voucherType: "expense", "vanRef.vanId": q.vanId ? q.vanId : { $exists: true }, "vanTripRef.tripId": { $exists: false }, date: within(q.from, q.to), status: { $in: ["approved", "pending"] } }).select(EXPENSE_FIELDS).lean()
      : [],
  ]);
  const tripOf = new Map(trips.map((t) => [id(t), t]));
  const vans = await vanNames(tagged.map((v) => id(v.vanRef?.vanId)));
  return [...road, ...tagged].map((v) => {
    const trip = v.vanTripRef?.tripId ? tripOf.get(id(v.vanTripRef.tripId)) : null;
    const vanId = trip ? id(trip.vanId) : id(v.vanRef?.vanId);
    const total = round2(v.totalAmount);
    const vat = round2(v.vatTotal || 0);
    return {
      voucherId: id(v), voucherNo: v.voucherNo, date: dayOf(v.date), source: trip ? "road" : "office",
      vanId, vanCode: trip?.vanCode || v.vanRef?.vanCode || vans.get(vanId)?.code || "", vanName: trip?.vanName || vans.get(vanId)?.name || "",
      tripId: trip ? id(trip) : "", tripNo: v.vanTripRef?.tripNo || "", kind: v.vanExpenseKind || "other", label: v.vanExpenseLabel || "",
      net: v.subtotal !== undefined && v.subtotal !== null ? round2(v.subtotal) : round2(total - vat), vat, total,
      paidFrom: v.paymentDetails?.accountName || v.paymentMode || "", description: v.description || "",
      status: v.status === "approved" ? "approved" : "pending",
    };
  });
}

/** The organisation's current names for its expense types, by key. */
async function kindLabels() {
  const settings = await VanSettingsService.settings();
  return new Map((settings.expenseKinds || []).map((k) => [k.key, k.label]));
}

/** Every trip with its settled figures, as the scorecard and the trend add them up. */
async function moneyRows(trips, expenses) {
  const money = await tripMoney(trips.map((t) => t._id));
  const road = new Map();
  for (const e of expenses) {
    if (e.source !== "road" || e.status !== "approved") continue;
    if (!road.has(e.tripId)) road.set(e.tripId, []);
    road.get(e.tripId).push({ kind: e.kind, net: e.net });
  }
  return trips.map((t) => {
    const s = t.settlement || {};
    return {
      tripId: id(t), tripNo: t.tripNo, date: dayOf(t.date), settled: t.status === "SETTLED", km: vanRules.kmRun(t.odometer),
      vanId: id(t.vanId), vanCode: t.vanCode, vanName: t.vanName, salesmanId: t.salesmanId, salesmanName: t.salesmanName,
      routeId: t.routeId ? id(t.routeId) : "", routeName: t.routeName || "",
      ...money.get(id(t)),
      damagedValue: num(s.damagedValue), expiredValue: num(s.expiredValue), differenceValue: num(s.stockVarianceValue), cashVariance: num(s.cashVariance),
      road: road.get(id(t)) || [],
    };
  });
}

const officeRows = (expenses) => expenses.filter((e) => e.source === "office" && e.status === "approved");

/** The documents approved on these trips, of one type. */
async function documentsOf(trips, type, fields) {
  if (!trips.length) return [];
  return Transaction.find({ "vanTripRef.tripId": { $in: trips.map((t) => t._id) }, type, status: "APPROVED" }).select(fields).lean();
}

async function itemMasters(stockIds) {
  const ids = [...new Set(stockIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const stocks = await Stock.find({ _id: { $in: ids } }).select("itemId sku itemName category purchasePrice").lean();
  const categories = await Category.find({ _id: { $in: [...new Set(stocks.map((s) => id(s.category)).filter(Boolean))] } }).select("name").lean();
  const catName = new Map(categories.map((c) => [id(c), c.name]));
  return new Map(stocks.map((s) => [id(s), {
    code: s.sku || s.itemId || "", itemCode: s.itemId, name: s.itemName, cost: num(s.purchasePrice),
    categoryId: s.category ? id(s.category) : "", category: catName.get(id(s.category)) || "",
  }]));
}

async function customerNames(customerIds) {
  const ids = [...new Set(customerIds.filter(Boolean))];
  if (!ids.length) return new Map();
  return new Map((await Customer.find({ _id: { $in: ids } }).select("customerName customerId").lean()).map((c) => [id(c), { name: c.customerName, code: c.customerId }]));
}

class VanAnalysisService {
  /** What the filter boxes offer: the vans, routes and salesmen. A salesman is offered only his own. */
  static async choices(viewer = {}) {
    const mine = viewer.onlySalesman ? String(viewer.onlySalesman) : "";
    const since = asDay(addDays(todayInOrg(), -730));
    const driven = await VanTrip.aggregate([
      { $match: { date: { $gte: since }, status: { $ne: "CANCELLED" }, ...(mine ? { salesmanId: mine } : {}) } },
      { $group: { _id: "$salesmanId", name: { $last: "$salesmanName" }, vans: { $addToSet: "$vanId" } } },
    ]);
    // a salesman also finds a van he once drove, though it is no longer his
    const [vans, routes] = await Promise.all([
      Van.find(mine ? { $or: [{ salesmanId: mine }, { _id: { $in: driven.flatMap((d) => d.vans) } }] } : {}).select("code name salesmanId salesmanName active").sort({ code: 1 }).lean(),
      VanRoute.find({}).select("name").sort({ name: 1 }).lean(),
    ]);
    const people = new Map(driven.map((d) => [String(d._id), d.name || ""]));
    if (!mine) for (const v of vans) if (v.salesmanId && !people.has(v.salesmanId)) people.set(v.salesmanId, v.salesmanName || "");
    return {
      vans: vans.map((v) => ({ id: id(v), code: v.code, name: v.name || "", active: v.active !== false })),
      routes: routes.map((r) => ({ id: id(r), name: r.name })),
      salesmen: [...people].map(([k, name]) => ({ id: k, name: name || "Unknown" })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  /** 1. Each van's scorecard, with the period before. */
  static async vans(query, viewer) {
    const ctx = contextOf(query, viewer);
    const previous = rules.previousPeriod(ctx.q);
    const load = async (q) => {
      const trips = await tripsIn(q);
      const expenses = await expensesOf(trips, { q, office: ctx.office });
      return { trips: await moneyRows(trips, expenses), office: officeRows(expenses) };
    };
    const [now, before] = await Promise.all([load(ctx.q), load({ ...ctx.q, ...previous })]);
    const result = rules.scorecard({ trips: now.trips, office: now.office, previousTrips: before.trips, previousOffice: before.office });
    const labels = await kindLabels();
    const kinds = [...new Set(result.rows.flatMap((r) => Object.keys(r.byKind)))].map((key) => ({ key, label: labels.get(key) || key }));
    return answer(ctx, { previous, kinds, ...result });
  }

  /** 2. What the vans cost: by type, by van, by month, and every voucher. */
  static async expenses(query, viewer) {
    const ctx = contextOf(query, viewer);
    const trips = await tripsIn(ctx.q);
    const register = await expensesOf(trips, ctx);
    const km = new Map();
    for (const t of trips) {
      const run = vanRules.kmRun(t.odometer);
      if (run !== null) km.set(id(t.vanId), round2((km.get(id(t.vanId)) || 0) + run));
    }
    const report = rules.expenseReport({ register, km, labels: await kindLabels(), from: ctx.q.from, to: ctx.q.to });
    return answer(ctx, { ...report, rows: report.rows.slice(0, REGISTER_MAX), truncated: report.rows.length > REGISTER_MAX });
  }

  /** 3. What came back and what was lost: by van, route, customer, item and reason, and what spoiled on the van. */
  static async returns(query, viewer) {
    const ctx = contextOf(query, viewer);
    const trips = await tripsIn(ctx.q);
    const tripOf = new Map(trips.map((t) => [id(t), t]));
    const [credits, sales] = await Promise.all([
      documentsOf(trips, "sales_return", "partyId items.itemId items.qty items.itemType items.taxableAmount items.lineTotal items.vatAmount returnReason vanTripRef"),
      documentsOf(trips, "sales_order", "partyId items.itemId items.itemType items.taxableAmount items.lineTotal items.vatAmount totalAmount pricing vanTripRef"),
    ]);
    const stockIds = [...credits.flatMap((d) => goodsLines(d).map((l) => id(l.itemId))), ...trips.flatMap((t) => (t.unload?.lines || []).map((l) => id(l.stockId)))];
    const items = await itemMasters(stockIds);
    const idByCode = new Map([...items].map(([k, v]) => [v.itemCode, k]));
    const moves = credits.length ? await InventoryMovement.find({ referenceId: { $in: credits.map((d) => d._id) }, isReversed: { $ne: true } }).select("referenceId stockId totalValue").lean() : [];
    const costOf = new Map();
    for (const m of moves) {
      const key = `${m.referenceId}|${idByCode.get(m.stockId) || m.stockId}`;
      costOf.set(key, round2((costOf.get(key) || 0) + Math.abs(num(m.totalValue))));
    }
    const customers = await customerNames(credits.map((d) => id(d.partyId)));

    const lines = [];
    for (const doc of credits) {
      const trip = tripOf.get(id(doc.vanTripRef.tripId));
      if (!trip) continue;
      const record = (trip.returns || []).find((r) => id(r.transactionId) === id(doc));
      const perItem = new Map();
      for (const l of goodsLines(doc)) {
        const k = id(l.itemId);
        const a = perItem.get(k) || { qty: 0, net: 0 };
        a.qty = round3(a.qty + num(l.qty));
        a.net = round2(a.net + lineNet(l));
        perItem.set(k, a);
      }
      const came = record?.lines?.length ? record.lines : [...perItem].map(([stockId, a]) => ({ stockId, qty: a.qty, condition: "good" }));
      for (const part of came) {
        const stockId = id(part.stockId);
        const whole = perItem.get(stockId);
        if (!whole || !(whole.qty > 0)) continue;
        const share = num(part.qty) / whole.qty;
        lines.push({
          docId: id(doc), vanId: id(trip.vanId), vanCode: trip.vanCode, routeId: trip.routeId ? id(trip.routeId) : "", routeName: trip.routeName || "",
          customerId: id(doc.partyId), customerName: customers.get(id(doc.partyId))?.name || "", stockId, itemName: items.get(stockId)?.name || "",
          reason: record?.reason || doc.returnReason || "", condition: part.condition || "good", qty: num(part.qty),
          credit: round2(whole.net * share), cost: round2((costOf.get(`${doc._id}|${stockId}`) || 0) * share),
        });
      }
    }

    // net sales of the same trips, to say what share came back
    const salesBy = { total: 0, van: new Map(), route: new Map(), customer: new Map(), item: new Map() };
    const add = (map, k, v) => map.set(k, round2((map.get(k) || 0) + v));
    for (const doc of sales) {
      const trip = tripOf.get(id(doc.vanTripRef.tripId));
      if (!trip) continue;
      const net = netOf(doc);
      salesBy.total = round2(salesBy.total + net);
      add(salesBy.van, id(trip.vanId), net);
      add(salesBy.route, trip.routeId ? id(trip.routeId) : "none", net);
      add(salesBy.customer, id(doc.partyId), net);
      for (const l of goodsLines(doc)) add(salesBy.item, id(l.itemId), lineNet(l));
    }

    const counted = trips.filter((t) => t.status === "SETTLED").flatMap((t) => (t.unload?.lines || []).map((l) => ({
      vanId: id(t.vanId), vanCode: t.vanCode, stockId: id(l.stockId), itemName: l.itemName || items.get(id(l.stockId))?.name || "",
      damaged: num(l.countedDamaged), expired: num(l.countedExpired), returnedDamaged: num(l.expectedDamaged), returnedExpired: num(l.expectedExpired),
      unitCost: l.unitCost !== undefined && l.unitCost !== null ? num(l.unitCost) : items.get(id(l.stockId))?.cost || 0,
    })));
    return answer(ctx, { ...rules.returnReport({ lines, sales: salesBy, counted }), unsettled: trips.filter((t) => t.status !== "SETTLED").length });
  }

  /** 4. Month by month, for each van and the fleet, ending at the period's last day. */
  static async trend(query, viewer) {
    const ctx = contextOf(query, viewer);
    const from = rules.trendStart(ctx.q.to, ctx.q.months);
    const q = { ...ctx.q, from };
    const trips = await tripsIn(q);
    const expenses = await expensesOf(trips, { q, office: ctx.office });
    const report = rules.trendReport({ trips: await moneyRows(trips, expenses), office: officeRows(expenses), months: rules.monthsIn(from, q.to) });
    return answer({ ...ctx, q }, report);
  }

  /** 5. What was sold, by item, category, customer or route, with a figure for each month. */
  static async items(query, viewer) {
    const ctx = contextOf(query, viewer);
    const trips = await tripsIn(ctx.q);
    const tripOf = new Map(trips.map((t) => [id(t), t]));
    const fields = "type date partyId items.itemId items.qty items.itemType items.taxableAmount items.lineTotal items.vatAmount vanTripRef";
    const [sales, back] = await Promise.all([documentsOf(trips, "sales_order", fields), documentsOf(trips, "sales_return", fields)]);
    const docs = [...sales, ...back];
    const items = await itemMasters(docs.flatMap((d) => goodsLines(d).map((l) => id(l.itemId))));
    const customers = await customerNames(docs.map((d) => id(d.partyId)));
    const lines = docs.flatMap((d) => {
      const trip = tripOf.get(id(d.vanTripRef.tripId));
      if (!trip) return [];
      const who = customers.get(id(d.partyId));
      return goodsLines(d).map((l) => {
        const item = items.get(id(l.itemId));
        return {
          month: dayOf(d.date).slice(0, 7), kind: d.type === "sales_return" ? "return" : "sale", qty: num(l.qty), net: lineNet(l),
          stockId: id(l.itemId), itemName: item?.name || "", itemCode: item?.code || "", categoryId: item?.categoryId || "", category: item?.category || "",
          customerId: id(d.partyId), customerName: who?.name || "", customerCode: who?.code || "",
          routeId: trip.routeId ? id(trip.routeId) : "", routeName: trip.routeName || "",
        };
      });
    });
    return answer(ctx, rules.itemReport({ lines, by: ctx.q.by || "item", months: rules.monthsIn(ctx.q.from, ctx.q.to) }));
  }

  /** 6. What was loaded, sold, brought back and lost, and how full the load requests were. */
  static async load(query, viewer) {
    const ctx = contextOf(query, viewer);
    const trips = await tripsIn(ctx.q);
    const soldRows = trips.length
      ? await Transaction.aggregate([
        { $match: { "vanTripRef.tripId": { $in: trips.map((t) => t._id) }, type: "sales_order", status: "APPROVED" } },
        { $unwind: "$items" },
        { $match: { "items.itemType": { $ne: "service" } } },
        { $group: { _id: "$vanTripRef.tripId", qty: { $sum: "$items.qty" } } },
      ])
      : [];
    const soldOf = new Map(soldRows.map((r) => [String(r._id), num(r.qty)]));
    const items = await itemMasters(trips.flatMap((t) => (t.unload?.lines || []).map((l) => id(l.stockId))));
    const rows = trips.map((t) => {
      const counted = ["UNLOADED", "SETTLED"].includes(t.status);
      const lines = counted ? t.unload?.lines || [] : [];
      const cost = (l) => (l.unitCost !== undefined && l.unitCost !== null ? num(l.unitCost) : items.get(id(l.stockId))?.cost || 0);
      const sum = (f) => round3(lines.reduce((s, l) => s + num(f(l)), 0));
      const accepted = (t.loadRequests || []).filter((r) => r.status === "ACCEPTED").flatMap((r) => r.lines || []);
      return {
        vanId: id(t.vanId), vanCode: t.vanCode, vanName: t.vanName, salesmanId: t.salesmanId, salesmanName: t.salesmanName, counted,
        loaded: round3([...vanRules.loadedOf(t).values()].reduce((s, q) => s + q, 0)), sold: soldOf.get(id(t)) || 0,
        good: sum((l) => l.countedGood), damaged: sum((l) => l.countedDamaged), expired: sum((l) => l.countedExpired),
        differenceUnits: sum((l) => l.difference), differenceValue: round2(lines.reduce((s, l) => s + num(l.difference) * cost(l), 0)),
        backValue: round2(lines.reduce((s, l) => s + num(l.countedGood) * cost(l), 0)),
        requested: round3(accepted.reduce((s, l) => s + num(l.requested), 0)), accepted: round3(accepted.reduce((s, l) => s + num(l.accepted), 0)),
      };
    });
    return answer(ctx, rules.loadReport({ trips: rows, by: ctx.q.by || "van" }));
  }

  /** 7. What was invoiced, paid at the door and left on credit, and what old debts were collected. */
  static async collections(query, viewer) {
    const ctx = contextOf(query, viewer);
    const trips = await tripsIn(ctx.q);
    const tripIds = trips.map((t) => t._id);
    const invoices = await documentsOf(trips, "sales_order", "totalAmount outstandingAmount vanTripRef");
    const receipts = tripIds.length
      ? await Voucher.find({ voucherType: "receipt", "vanTripRef.tripId": { $in: tripIds }, status: { $in: ["approved", "pending"] } })
        .select("status paymentMode totalAmount linkedInvoices onAccountAmount vanTripRef").lean()
      : [];
    const byTrip = (rows, key) => {
      const m = new Map();
      for (const r of rows) {
        const k = key(r);
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(r);
      }
      return m;
    };
    const invoicesOf = byTrip(invoices, (d) => id(d.vanTripRef.tripId));
    const receiptsOf = byTrip(receipts, (v) => id(v.vanTripRef.tripId));
    const rows = trips.map((t) => {
      const mine = invoicesOf.get(id(t)) || [];
      const own = new Set(mine.map((d) => id(d)));
      const money = { cash: 0, cheque: 0, card: 0, transfer: 0, transferWaiting: 0, atDoor: 0, oldCollected: 0, onAccount: 0 };
      for (const v of receiptsOf.get(id(t)) || []) {
        const mode = v.paymentMode === "online" ? "transfer" : v.paymentMode;
        if (v.status !== "approved") {
          if (mode === "transfer") money.transferWaiting += num(v.totalAmount);
          continue;
        }
        if (money[mode] !== undefined) money[mode] += num(v.totalAmount);
        for (const l of v.linkedInvoices || []) money[own.has(id(l.invoiceId)) ? "atDoor" : "oldCollected"] += num(l.allocatedAmount);
        money.onAccount += num(v.onAccountAmount);
      }
      return {
        date: dayOf(t.date), vanId: id(t.vanId), vanCode: t.vanCode, vanName: t.vanName, salesmanId: t.salesmanId, salesmanName: t.salesmanName,
        invoiced: round2(mine.reduce((s, d) => s + num(d.totalAmount), 0)), openNow: round2(mine.reduce((s, d) => s + num(d.outstandingAmount), 0)),
        ...Object.fromEntries(Object.entries(money).map(([k, v]) => [k, round2(v)])),
        cashVariance: t.status === "SETTLED" ? num(t.settlement?.cashVariance) : null,
      };
    });
    return answer(ctx, rules.collectionReport({ trips: rows, by: ctx.q.by || "van" }));
  }

  /** 8. Stops called and bought, why not, hours on the road, and the route customers nobody called on. */
  static async coverage(query, viewer) {
    const ctx = contextOf(query, viewer);
    const trips = await tripsIn(ctx.q);
    const tripIds = trips.map((t) => t._id);
    const [invoices, visits, routes, money] = await Promise.all([
      documentsOf(trips, "sales_order", "partyId createdAt vanTripRef"),
      tripIds.length ? VanVisit.find({ tripId: { $in: tripIds } }).select("tripId customerId reason").lean() : [],
      VanRoute.find({ _id: { $in: [...new Set(trips.map((t) => id(t.routeId)).filter(Boolean))] } }).select("name customers").lean(),
      tripMoney(tripIds),
    ]);
    const routeOf = new Map(routes.map((r) => [id(r), r]));
    const zone = orgLocale.timezone();
    const minute = (at) => {
      const local = new Date(new Date(at).getTime() + tz.offsetMinutes(new Date(at), zone) * 60000);
      return local.getUTCHours() * 60 + local.getUTCMinutes();
    };
    const calledAnywhere = new Set();
    const rows = trips.map((t) => {
      const sales = invoices.filter((d) => id(d.vanTripRef.tripId) === id(t));
      const buyers = new Set(sales.map((d) => id(d.partyId)));
      const called = new Set([...buyers, ...visits.filter((v) => id(v.tripId) === id(t)).map((v) => id(v.customerId))]);
      for (const c of called) calledAnywhere.add(c);
      const stops = new Set((routeOf.get(id(t.routeId))?.customers || []).map((c) => id(c.customerId)));
      const times = sales.map((d) => d.createdAt).filter(Boolean).sort((a, b) => new Date(a) - new Date(b));
      const hours = t.departedAt && t.unload?.at ? (new Date(t.unload.at) - new Date(t.departedAt)) / 3600000 : null;
      const m = money.get(id(t));
      return {
        tripId: id(t), tripNo: t.tripNo, date: dayOf(t.date), vanId: id(t.vanId), vanCode: t.vanCode, vanName: t.vanName,
        salesmanId: t.salesmanId, salesmanName: t.salesmanName,
        planned: stops.size, calledOnRoute: [...called].filter((c) => stops.has(c)).length, called: called.size, bought: buyers.size,
        callsTarget: t.target?.calls ?? null, hours: hours !== null && hours > 0 ? round2(hours) : null,
        netSales: round2((m?.sales || 0) - (m?.returns || 0)),
        firstSale: times.length ? minute(times[0]) : null, lastSale: times.length ? minute(times[times.length - 1]) : null,
        farSales: (t.pings || []).filter((p) => p.kind === "sale" && p.far).length,
      };
    });
    const missed = routes.flatMap((r) => (r.customers || []).filter((c) => !calledAnywhere.has(id(c.customerId))).map((c) => ({ customerId: id(c.customerId), name: c.name || "", routeName: r.name })));
    const unnamed = await customerNames(missed.filter((c) => !c.name).map((c) => c.customerId));
    const notCalled = missed.map((c) => ({ ...c, name: c.name || unnamed.get(c.customerId)?.name || "" }))
      .sort((a, b) => a.routeName.localeCompare(b.routeName) || a.name.localeCompare(b.name)).slice(0, 500);
    return answer(ctx, rules.coverageReport({ trips: rows, by: ctx.q.by || "van", visits, notCalled }));
  }
}

module.exports = VanAnalysisService;
