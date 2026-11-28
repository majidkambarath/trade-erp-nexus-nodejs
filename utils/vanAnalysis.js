// The van analysis reports: the pure sums (no Mongoose, no clock). services/vansales/vanAnalysisService.js reads the
// documents and hands plain rows in; everything added up, divided and ranked happens here.
//
// Money is in the base currency, NET of VAT unless a field says otherwise. A figure with nothing to divide by is null,
// never 0. Figures made from cost (margin, losses, contribution) come from SETTLED trips only: a trip still out can
// change. Every cost-derived field is named in COST_FIELDS, so a caller who may not see costs gets none of them.

const { addDays, isRealDay } = require("./tz");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const num = (n) => Number(n) || 0;
const pct = (part, whole) => (whole > 0 ? Math.round((num(part) / whole) * 1000) / 10 : null);
const per = (a, b) => (b > 0 ? round2(num(a) / b) : null);
const str = (v) => (v === undefined || v === null ? "" : String(v));
const monthOf = (day) => str(day).slice(0, 7);

const MAX_DAYS = 731;
const GROUPS = ["van", "salesman"];
const ITEM_GROUPS = ["item", "category", "customer", "route"];
const TREND_MONTHS = [6, 12, 24];

class AnalysisError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

/**
 * The query of an analysis report, strictly read: { from, to, vanId, salesmanId, routeId, by, months }. No dates means
 * the last 24 months; at most 731 days; an id is 24 hex characters.
 */
function readQuery(query = {}, today) {
  const text = (k) => {
    const v = query[k];
    if (v === undefined || v === null || v === "") return "";
    if (typeof v !== "string") throw new AnalysisError(`${k} is not valid`, "INVALID_FILTER");
    return v;
  };
  const day = (k) => {
    const v = text(k);
    if (v && !isRealDay(v)) throw new AnalysisError("Enter the dates as real calendar days", "INVALID_DATE");
    return v;
  };
  const id = (k) => {
    const v = text(k);
    if (v && !/^[a-f0-9]{24}$/i.test(v)) throw new AnalysisError(`Choose a ${k.replace("Id", "")} from the list`, "INVALID_FILTER");
    return v;
  };
  const to = day("to") || today;
  const from = day("from") || addDays(to, -(MAX_DAYS - 2));
  if (from > to) throw new AnalysisError("The period starts after it ends", "INVALID_RANGE");
  if (daysBetween(from, to) + 1 > MAX_DAYS) throw new AnalysisError("Choose a period of two years or less", "RANGE_TOO_LONG");
  const by = text("by");
  const months = text("months") ? Number(text("months")) : 12;
  if (!TREND_MONTHS.includes(months)) throw new AnalysisError("Show 6, 12 or 24 months", "INVALID_FILTER");
  return { from, to, vanId: id("vanId"), salesmanId: id("salesmanId"), routeId: id("routeId"), by, months };
}

/** The period of the same length just before. */
function previousPeriod({ from, to }) {
  const length = daysBetween(from, to) + 1;
  const end = addDays(from, -1);
  return { from: addDays(end, -(length - 1)), to: end };
}

/** Every month "YYYY-MM" a period touches, oldest first. */
function monthsIn(from, to) {
  const out = [];
  for (let m = monthOf(from); m <= monthOf(to) && out.length < 40; ) {
    out.push(m);
    const [y, mo] = m.split("-").map(Number);
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
  }
  return out;
}

/** The first day of the month `n - 1` months before `to`'s month (a trend of n months ending at `to`). */
function trendStart(to, n) {
  let [y, m] = to.split("-").map(Number);
  m -= n - 1;
  while (m < 1) { m += 12; y -= 1; }
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

const COST_FIELDS = ["cost", "returnsCost", "grossMargin", "marginPct", "damagedValue", "expiredValue", "differenceValue", "lossValue", "contribution", "backValue", "unitCost"];

/** The same answer with every cost-derived figure removed, at any depth. */
function withoutCost(value) {
  if (Array.isArray(value)) return value.map(withoutCost);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !COST_FIELDS.includes(k)).map(([k, v]) => [k, withoutCost(v)]));
}

/** Rows keyed and added: `into(row, source)` adds one source row; `make(source)` starts a new one. */
function groupBy(rows, keyOf, make, into) {
  const out = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!out.has(k)) out.set(k, make(r));
    into(out.get(k), r);
  }
  return [...out.values()];
}

const vanFields = (r) => ({ key: str(r.vanId), vanId: str(r.vanId), vanCode: r.vanCode || "", vanName: r.vanName || "" });
const whoOf = (by) => (by === "salesman"
  ? { key: (r) => str(r.salesmanId), name: (r) => r.salesmanName || "Unknown" }
  : { key: (r) => str(r.vanId), name: (r) => `${r.vanCode || ""}${r.vanName ? ` ${r.vanName}` : ""}`.trim() });

// ---- 1. the vans' scorecard -------------------------------------------------------------------------------------
const SCORE_SUMS = ["allTrips", "trips", "days", "km", "invoices", "sales", "returns", "netSales", "cost", "returnsCost", "damagedValue", "expiredValue", "differenceValue", "road", "office", "expenses", "cashVariance"];

function emptyScore(base) {
  return { ...base, ...Object.fromEntries(SCORE_SUMS.map((k) => [k, 0])), byKind: {} };
}

function finishScore(a) {
  const netSales = round2(a.sales - a.returns);
  const grossMargin = round2(netSales - (a.cost - a.returnsCost));
  const expenses = round2(a.road + a.office);
  return {
    ...a, netSales, expenses, grossMargin,
    contribution: round2(grossMargin - a.damagedValue - a.expiredValue + a.differenceValue - expenses + a.cashVariance),
    returnsPct: pct(a.returns, a.sales),
    marginPct: pct(grossMargin, netSales),
    expensePct: pct(expenses, netSales),
    costPerKm: per(expenses, a.km),
    salesPerKm: per(netSales, a.km),
  };
}

/**
 * One row per van. `trips`: every trip of the period that was not cancelled, each with its settled figures
 * { vanId, vanCode, vanName, date, settled, km, invoices, sales, returns, cost, returnsCost, damagedValue,
 *   expiredValue, differenceValue, cashVariance, road: [{ kind, net }] }. `office`: approved office expenses
 * [{ vanId, vanCode, kind, net }]. Money from trips not yet settled is left out; the count of them is returned.
 */
function vanRows(trips = [], office = []) {
  const by = new Map();
  const row = (r) => {
    const k = str(r.vanId);
    if (!by.has(k)) by.set(k, { ...emptyScore(vanFields(r)), dates: new Set() });
    const a = by.get(k);
    if (!a.vanName && r.vanName) a.vanName = r.vanName;
    return a;
  };
  for (const t of trips) {
    const a = row(t);
    a.allTrips += 1;
    if (!t.settled) continue;
    a.trips += 1;
    a.dates.add(str(t.date).slice(0, 10));
    if (Number.isFinite(t.km)) a.km = round2(a.km + t.km);
    for (const f of ["invoices", "sales", "returns", "cost", "returnsCost", "damagedValue", "expiredValue", "differenceValue", "cashVariance"]) a[f] = round2(a[f] + num(t[f]));
    for (const e of t.road || []) {
      a.road = round2(a.road + num(e.net));
      a.byKind[e.kind] = round2((a.byKind[e.kind] || 0) + num(e.net));
    }
  }
  for (const e of office) {
    const a = row(e);
    a.office = round2(a.office + num(e.net));
    a.byKind[e.kind] = round2((a.byKind[e.kind] || 0) + num(e.net));
  }
  return [...by.values()].map(({ dates, ...a }) => finishScore({ ...a, days: dates.size }));
}

/** The fleet's total and what an average van made (ratios of the total). */
function fleetOf(rows) {
  const total = emptyScore({ key: "total" });
  for (const r of rows) {
    for (const f of SCORE_SUMS) total[f] = round2(total[f] + num(r[f]));
    for (const [k, v] of Object.entries(r.byKind || {})) total.byKind[k] = round2((total.byKind[k] || 0) + v);
  }
  const done = finishScore(total);
  const n = rows.length;
  // each added figure divided by the number of vans; the ratios are the fleet's own
  const average = n
    ? { ...done, key: "average", ...Object.fromEntries([...SCORE_SUMS, "grossMargin", "contribution"].map((f) => [f, round2(done[f] / n)])), byKind: Object.fromEntries(Object.entries(done.byKind).map(([k, v]) => [k, round2(v / n)])) }
    : null;
  return { total: done, average, vans: n };
}

/** The scorecard, with the same figures for the period before beside each van; best contribution first. */
function scorecard({ trips = [], office = [], previousTrips = [], previousOffice = [] }) {
  const rows = vanRows(trips, office);
  const before = new Map(vanRows(previousTrips, previousOffice).map((r) => [r.key, r]));
  const brief = (r) => (r ? { trips: r.trips, netSales: r.netSales, expenses: r.expenses, contribution: r.contribution } : { trips: 0, netSales: 0, expenses: 0, contribution: 0 });
  const withBefore = rows.map((r) => ({ ...r, previous: brief(before.get(r.key)) }))
    .sort((a, b) => b.contribution - a.contribution || a.vanCode.localeCompare(b.vanCode));
  const fleet = fleetOf(rows);
  return {
    rows: withBefore,
    total: { ...fleet.total, previous: brief(fleetOf([...before.values()]).total) },
    average: fleet.average,
    unsettled: trips.filter((t) => !t.settled).length,
  };
}

// ---- 2. expenses ----------------------------------------------------------------------------------------------
/**
 * `register`: every expense, [{ date, voucherNo, source: "road"|"office", vanId, vanCode, vanName, tripNo, kind, label,
 * net, vat, total, paidFrom, status: "approved"|"pending" }]. `km`: Map(vanId -> km run in the period). `labels`: the
 * organisation's current names by kind (a kind since removed keeps the name its vouchers carry). Totals count approved
 * expenses; pending ones are counted apart.
 */
function expenseReport({ register = [], km = new Map(), labels = new Map(), from, to }) {
  const approved = register.filter((r) => r.status === "approved");
  const pendingRows = register.filter((r) => r.status === "pending");
  const labelOf = (r) => labels.get(r.kind) || r.label || r.kind;
  const sum = (rows, f) => round2(rows.reduce((t, r) => t + num(r[f]), 0));
  const totalNet = sum(approved, "net");
  const kmAll = round2([...km.values()].reduce((t, v) => t + num(v), 0));

  const kinds = groupBy(approved, (r) => r.kind,
    (r) => ({ kind: r.kind, label: labelOf(r), count: 0, net: 0, vat: 0, total: 0 }),
    (a, r) => { a.count += 1; for (const f of ["net", "vat", "total"]) a[f] = round2(a[f] + num(r[f])); })
    .map((a) => ({ ...a, share: pct(a.net, totalNet), perKm: per(a.net, kmAll) }))
    .sort((a, b) => b.net - a.net || a.label.localeCompare(b.label));

  const vanKeys = new Map();
  for (const r of approved) if (!vanKeys.has(str(r.vanId))) vanKeys.set(str(r.vanId), vanFields(r));
  const vans = [...vanKeys.values()].map((v) => {
    const mine = approved.filter((r) => str(r.vanId) === v.vanId);
    const byKind = {};
    for (const r of mine) byKind[r.kind] = round2((byKind[r.kind] || 0) + num(r.net));
    const run = num(km.get(v.vanId));
    const net = sum(mine, "net");
    return {
      ...v, km: run, net, road: sum(mine.filter((r) => r.source === "road"), "net"), office: sum(mine.filter((r) => r.source === "office"), "net"),
      byKind, perKm: per(net, run), perKmByKind: Object.fromEntries(Object.entries(byKind).map(([k, n]) => [k, per(n, run)])),
    };
  }).sort((a, b) => b.net - a.net || a.vanCode.localeCompare(b.vanCode));

  const months = monthsIn(from, to).map((month) => {
    const mine = approved.filter((r) => monthOf(r.date) === month);
    const byKind = {};
    for (const r of mine) byKind[r.kind] = round2((byKind[r.kind] || 0) + num(r.net));
    return { month, net: sum(mine, "net"), byKind };
  });

  const rows = register
    .map((r) => ({ ...r, label: labelOf(r) }))
    .sort((a, b) => str(b.date).localeCompare(str(a.date)) || str(b.voucherNo).localeCompare(str(a.voucherNo)));
  return {
    kinds, vans, months, rows,
    total: { count: approved.length, net: totalNet, vat: sum(approved, "vat"), total: sum(approved, "total"), km: kmAll, perKm: per(totalNet, kmAll) },
    pending: { count: pendingRows.length, total: sum(pendingRows, "total") },
  };
}

// ---- 3. returns and losses ------------------------------------------------------------------------------------
const RETURN_GROUPS = {
  van: { key: (r) => str(r.vanId), name: (r) => r.vanCode || "" },
  route: { key: (r) => str(r.routeId) || "none", name: (r) => r.routeName || "No route" },
  customer: { key: (r) => str(r.customerId), name: (r) => r.customerName || "Unknown" },
  item: { key: (r) => str(r.stockId), name: (r) => r.itemName || "Unknown" },
  reason: { key: (r) => r.reason || "Not given", name: (r) => r.reason || "Not given" },
};

const emptyReturn = (key, name) => ({ key, name, notes: new Set(), qty: 0, credit: 0, goodQty: 0, damagedQty: 0, expiredQty: 0, damagedValue: 0, expiredValue: 0 });
function addReturn(a, l) {
  a.notes.add(str(l.docId));
  a.qty = round3(a.qty + num(l.qty));
  a.credit = round2(a.credit + num(l.credit));
  const kind = l.condition === "damaged" || l.condition === "expired" ? l.condition : "good";
  a[`${kind}Qty`] = round3(a[`${kind}Qty`] + num(l.qty));
  if (kind !== "good") a[`${kind}Value`] = round2(a[`${kind}Value`] + num(l.cost));
}
const finishReturn = ({ notes, ...a }, sales) => ({ ...a, count: notes.size, sales: round2(sales), pct: pct(a.credit, sales), lossValue: round2(a.damagedValue + a.expiredValue) });

/**
 * `lines`: what came back, one per item and condition of a credit note: { docId, vanId, vanCode, routeId, routeName,
 * customerId, customerName, stockId, itemName, reason, condition, qty, credit (net), cost (of those goods) }.
 * `sales`: net sales of the same trips per van / route / customer / item, as Maps by key, and `total`.
 * `counted`: settled counts per van and item { vanId, vanCode, stockId, itemName, damaged, expired, returnedDamaged,
 * returnedExpired, unitCost }: what was found beyond what customers brought back was damaged or expired on the van.
 */
function returnReport({ lines = [], sales = {}, counted = [] }) {
  const groups = {};
  for (const [name, g] of Object.entries(RETURN_GROUPS)) {
    groups[name] = groupBy(lines, g.key, (l) => emptyReturn(g.key(l), g.name(l)), addReturn)
      .map((a) => finishReturn(a, name === "reason" ? num(sales.total) : num(sales[name]?.get(a.key))))
      .sort((a, b) => b.credit - a.credit || b.qty - a.qty || a.name.localeCompare(b.name));
  }
  const all = emptyReturn("total", "Total");
  for (const l of lines) addReturn(all, l);
  const onVan = groupBy(counted, (c) => `${c.vanId}|${c.stockId}`,
    (c) => ({ key: `${c.vanId}|${c.stockId}`, vanId: str(c.vanId), vanCode: c.vanCode || "", stockId: str(c.stockId), itemName: c.itemName || "", damaged: 0, expired: 0, returnedDamaged: 0, returnedExpired: 0, value: 0 }),
    (a, c) => {
      for (const f of ["damaged", "expired", "returnedDamaged", "returnedExpired"]) a[f] = round3(a[f] + num(c[f]));
      a.value = round2(a.value + (Math.max(0, num(c.damaged) - num(c.returnedDamaged)) + Math.max(0, num(c.expired) - num(c.returnedExpired))) * num(c.unitCost));
    })
    .map((a) => ({ key: a.key, vanId: a.vanId, vanCode: a.vanCode, stockId: a.stockId, itemName: a.itemName, damagedQty: round3(Math.max(0, a.damaged - a.returnedDamaged)), expiredQty: round3(Math.max(0, a.expired - a.returnedExpired)), lossValue: a.value }))
    .filter((a) => a.damagedQty > 0 || a.expiredQty > 0)
    .sort((a, b) => b.lossValue - a.lossValue || a.itemName.localeCompare(b.itemName));
  return { groups, total: finishReturn(all, num(sales.total)), onVan };
}

// ---- 4. the trend ---------------------------------------------------------------------------------------------
/** Month by month for each van and the fleet: net sales, gross margin, losses, expenses, contribution. */
function trendReport({ trips = [], office = [], months = [] }) {
  const empty = () => months.map((month) => ({ month, netSales: 0, grossMargin: 0, lossValue: 0, expenses: 0, contribution: 0 }));
  const fleet = empty();
  const vans = new Map();
  const slot = (r, day) => {
    const i = months.indexOf(monthOf(day));
    if (i < 0) return null;
    const k = str(r.vanId);
    if (!vans.has(k)) vans.set(k, { ...vanFields(r), rows: empty() });
    return [fleet[i], vans.get(k).rows[i]];
  };
  const add = (cells, f, v) => cells.forEach((c) => { c[f] = round2(c[f] + v); });
  for (const t of trips) {
    if (!t.settled) continue;
    const cells = slot(t, t.date);
    if (!cells) continue;
    const net = num(t.sales) - num(t.returns);
    const margin = net - (num(t.cost) - num(t.returnsCost));
    const loss = num(t.damagedValue) + num(t.expiredValue) - num(t.differenceValue);
    const road = (t.road || []).reduce((s, e) => s + num(e.net), 0);
    add(cells, "netSales", net);
    add(cells, "grossMargin", margin);
    add(cells, "lossValue", loss);
    add(cells, "expenses", road);
    add(cells, "contribution", margin - loss - road + num(t.cashVariance));
  }
  for (const e of office) {
    const cells = slot(e, e.date);
    if (!cells) continue;
    add(cells, "expenses", num(e.net));
    add(cells, "contribution", -num(e.net));
  }
  const total = (rows) => rows.reduce((t, r) => ({ netSales: round2(t.netSales + r.netSales), grossMargin: round2(t.grossMargin + r.grossMargin), lossValue: round2(t.lossValue + r.lossValue), expenses: round2(t.expenses + r.expenses), contribution: round2(t.contribution + r.contribution) }), { netSales: 0, grossMargin: 0, lossValue: 0, expenses: 0, contribution: 0 });
  return {
    months,
    vans: [...vans.values()].map((v) => ({ ...v, total: total(v.rows) })).sort((a, b) => b.total.netSales - a.total.netSales || a.vanCode.localeCompare(b.vanCode)),
    fleet: { rows: fleet, total: total(fleet) },
    unsettled: trips.filter((t) => !t.settled).length,
  };
}

// ---- 5. items and customers -------------------------------------------------------------------------------------
const ITEM_KEYS = {
  item: { key: (r) => str(r.stockId), name: (r) => r.itemName || "Unknown", sub: (r) => r.itemCode || "" },
  category: { key: (r) => str(r.categoryId) || "none", name: (r) => r.category || "Uncategorised", sub: () => "" },
  customer: { key: (r) => str(r.customerId), name: (r) => r.customerName || "Unknown", sub: (r) => r.customerCode || "" },
  route: { key: (r) => str(r.routeId) || "none", name: (r) => r.routeName || "No route", sub: () => "" },
};

/** `lines`: { month, kind: "sale"|"return", qty, net, ...the group's fields }. Sales add, returns take off. */
function itemReport({ lines = [], by = "item", months = [] }) {
  const grouping = Object.hasOwn(ITEM_KEYS, by) ? by : "item";
  const g = ITEM_KEYS[grouping];
  const rows = groupBy(lines, g.key,
    (l) => ({ key: g.key(l), name: g.name(l), sub: g.sub(l), qty: 0, sales: 0, returns: 0, netSales: 0, months: Object.fromEntries(months.map((m) => [m, 0])) }),
    (a, l) => {
      const sign = l.kind === "return" ? -1 : 1;
      a.qty = round3(a.qty + sign * num(l.qty));
      if (sign > 0) a.sales = round2(a.sales + num(l.net));
      else a.returns = round2(a.returns + num(l.net));
      a.netSales = round2(a.sales - a.returns);
      if (l.month in a.months) a.months[l.month] = round2(a.months[l.month] + sign * num(l.net));
    })
    .sort((a, b) => b.netSales - a.netSales || a.name.localeCompare(b.name));
  const totalNet = round2(rows.reduce((t, r) => t + r.netSales, 0));
  return {
    by: grouping, months,
    rows: rows.map((r) => ({ ...r, share: pct(r.netSales, totalNet) })),
    total: {
      qty: round3(rows.reduce((t, r) => t + r.qty, 0)), sales: round2(rows.reduce((t, r) => t + r.sales, 0)), returns: round2(rows.reduce((t, r) => t + r.returns, 0)), netSales: totalNet,
      months: Object.fromEntries(months.map((m) => [m, round2(rows.reduce((t, r) => t + r.months[m], 0))])),
    },
  };
}

// ---- 6. loads -------------------------------------------------------------------------------------------------
const LOAD_SUMS = ["trips", "loaded", "sold", "good", "damaged", "expired", "differenceUnits", "differenceValue", "backValue", "requested", "accepted"];

/**
 * `trips`: { vanId, vanCode, vanName, salesmanId, salesmanName, counted (was it counted back in), loaded, sold, good,
 * damaged, expired, differenceUnits, differenceValue, backValue, requested, accepted }. Units counted back come from
 * counted trips only, so sell-through and what came back are of those; the others are counted apart.
 */
function loadReport({ trips = [], by = "van" }) {
  const g = whoOf(by);
  const add = (a, t) => {
    if (!t.counted) { a.uncounted += 1; return; }
    a.trips += 1;
    for (const f of LOAD_SUMS.slice(1)) a[f] = round3(a[f] + num(t[f]));
  };
  const finish = (a) => ({ ...a, differenceValue: round2(a.differenceValue), backValue: round2(a.backValue), sellThrough: pct(a.sold, a.loaded), fillRate: pct(a.accepted, a.requested) });
  const make = (key, name) => ({ key, name, uncounted: 0, ...Object.fromEntries(LOAD_SUMS.map((f) => [f, 0])) });
  const rows = groupBy(trips, g.key, (t) => make(g.key(t), g.name(t)), add).map(finish)
    .sort((a, b) => b.sold - a.sold || a.name.localeCompare(b.name));
  const total = make("total", "Total");
  for (const t of trips) add(total, t);
  return { by: GROUPS.includes(by) ? by : "van", rows, total: finish(total) };
}

// ---- 7. collections and credit --------------------------------------------------------------------------------
const MONEY_SUMS = ["trips", "invoiced", "atDoor", "onCredit", "oldCollected", "onAccount", "cash", "cheque", "card", "transfer", "transferWaiting", "collected", "openNow", "cashShort", "cashOver"];

/**
 * `trips`: { date, vanId, ..., salesmanId, ..., invoiced (incl. VAT), atDoor (this trip's receipts against this trip's
 * invoices), oldCollected (against any other invoice), onAccount, cash, cheque, card, transfer (approved), transferWaiting,
 * openNow (still owed on this trip's invoices today), cashVariance (null until settled) }.
 */
function collectionReport({ trips = [], by = "van" }) {
  const g = whoOf(by);
  const make = (key, name) => ({ key, name, ...Object.fromEntries(MONEY_SUMS.map((f) => [f, 0])) });
  const add = (a, t) => {
    a.trips += 1;
    for (const f of ["invoiced", "atDoor", "oldCollected", "onAccount", "cash", "cheque", "card", "transfer", "transferWaiting", "openNow"]) a[f] = round2(a[f] + num(t[f]));
    a.onCredit = round2(a.invoiced - a.atDoor);
    a.collected = round2(a.cash + a.cheque + a.card + a.transfer);
    const v = num(t.cashVariance);
    if (v < 0) a.cashShort = round2(a.cashShort - v);
    if (v > 0) a.cashOver = round2(a.cashOver + v);
  };
  const finish = (a) => ({ ...a, collectionPct: pct(a.collected, a.invoiced), atDoorPct: pct(a.atDoor, a.invoiced) });
  const rows = groupBy(trips, g.key, (t) => make(g.key(t), g.name(t)), add).map(finish)
    .sort((a, b) => b.collected - a.collected || a.name.localeCompare(b.name));
  const total = make("total", "Total");
  for (const t of trips) add(total, t);
  const days = groupBy(trips.filter((t) => num(t.cashVariance) !== 0), (t) => str(t.date).slice(0, 10),
    (t) => ({ day: str(t.date).slice(0, 10), short: 0, over: 0 }),
    (a, t) => { const v = num(t.cashVariance); if (v < 0) a.short = round2(a.short - v); else a.over = round2(a.over + v); })
    .sort((a, b) => b.day.localeCompare(a.day));
  return { by: GROUPS.includes(by) ? by : "van", rows, total: finish(total), days };
}

// ---- 8. coverage and productivity -------------------------------------------------------------------------------
/** "08:05" from minutes after midnight; "" when unknown. */
const clock = (m) => (Number.isFinite(m) ? `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}` : "");

/**
 * `trips`: { tripNo, date, vanId, ..., salesmanId, ..., planned (stops on the route as it is today), calledOnRoute,
 * called, bought, callsTarget (null = none), hours (null when unknown), netSales, firstSale, lastSale (minutes after
 * midnight, local), farSales }. `visits`: [{ reason }] with no sale. `notCalled`: route customers nobody called on.
 */
function coverageReport({ trips = [], by = "van", visits = [], notCalled = [] }) {
  const g = whoOf(by);
  const make = (key, name) => ({ key, name, trips: 0, planned: 0, calledOnRoute: 0, called: 0, bought: 0, withTarget: 0, targetMet: 0, hours: 0, timedSales: 0, farSales: 0, starts: [], ends: [] });
  const add = (a, t) => {
    a.trips += 1;
    for (const f of ["planned", "calledOnRoute", "called", "bought", "farSales"]) a[f] += num(t[f]);
    if (t.callsTarget > 0) { a.withTarget += 1; if (num(t.called) >= t.callsTarget) a.targetMet += 1; }
    if (t.hours > 0) { a.hours = round2(a.hours + t.hours); a.timedSales = round2(a.timedSales + num(t.netSales)); }
    if (Number.isFinite(t.firstSale)) a.starts.push(t.firstSale);
    if (Number.isFinite(t.lastSale)) a.ends.push(t.lastSale);
  };
  const mean = (list) => (list.length ? list.reduce((s, x) => s + x, 0) / list.length : null);
  const finish = ({ starts, ends, timedSales, ...a }) => ({
    ...a, coveragePct: pct(a.calledOnRoute, a.planned), strikeRate: pct(a.bought, a.called), salesPerHour: per(timedSales, a.hours),
    firstSale: clock(mean(starts)), lastSale: clock(mean(ends)),
  });
  const rows = groupBy(trips, g.key, (t) => make(g.key(t), g.name(t)), add).map(finish)
    .sort((a, b) => b.bought - a.bought || a.name.localeCompare(b.name));
  const total = make("total", "Total");
  for (const t of trips) add(total, t);
  const reasons = groupBy(visits, (v) => v.reason || "other", (v) => ({ reason: v.reason || "other", count: 0 }), (a) => { a.count += 1; })
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  const list = trips.map((t) => ({
    tripNo: t.tripNo, tripId: str(t.tripId), date: str(t.date).slice(0, 10), vanCode: t.vanCode, salesmanName: t.salesmanName,
    planned: num(t.planned), called: num(t.called), bought: num(t.bought), hours: t.hours ?? null, firstSale: clock(t.firstSale), lastSale: clock(t.lastSale), farSales: num(t.farSales),
  })).sort((a, b) => b.date.localeCompare(a.date) || str(b.tripNo).localeCompare(str(a.tripNo)));
  return { by: GROUPS.includes(by) ? by : "van", rows, total: finish(total), reasons, notCalled, trips: list };
}

module.exports = {
  AnalysisError, readQuery, previousPeriod, monthsIn, trendStart, COST_FIELDS, withoutCost, MAX_DAYS, ITEM_GROUPS,
  vanRows, fleetOf, scorecard, expenseReport, returnReport, trendReport, itemReport, loadReport, collectionReport, coverageReport, clock,
};
