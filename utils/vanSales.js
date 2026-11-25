// Van sales: the pure rules (no Mongoose, no clock).
//
// A salesman loads stock onto a van, sells and collects on the road, brings what is left back and settles the day.
// The ERP holds one quantity per item for the whole organisation, so stock on a van is DERIVED from documents, the
// way utils/jobWork.js derives "with the job worker": loading moves nothing and posts nothing, and the goods leave
// the books only when an invoice raised on the trip is approved (the normal sales path: FEFO, average cost, ledger).
//
//   physical on the van  = loaded - sold + returned (good and damaged)
//   sellable on the van  = loaded - sold + returned in good condition
//   damaged on the van   = returned damaged (restocked by the return in the books, unsellable in the world)
//
// Only a trip that is still LOADING / ON_ROUTE holds stock. Once the van is unloaded the goods are back at the depot.

const STATUSES = ["LOADING", "ON_ROUTE", "UNLOADED", "SETTLED", "CANCELLED"];
const HOLDING = new Set(["LOADING", "ON_ROUTE"]); // a trip in these states has stock on the van
const SELLING = new Set(["ON_ROUTE"]); // and only this one may sell, collect or take a return
const EPS = 0.0005;

const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const idOf = (v) => (v && typeof v === "object" ? String(v._id || v) : v == null ? "" : String(v));
const text = (v, max = 200) => String(v ?? "").trim().slice(0, max);

class VanError extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Add `qty` of an item to a Map(stockId -> qty). */
function bump(map, stockId, qty) {
  const k = idOf(stockId);
  if (!k) return map;
  map.set(k, round3((map.get(k) || 0) + Number(qty || 0)));
  return map;
}

/** Everything loaded on a trip (the first load and every top-up), as Map(stockId -> qty). */
function loadedOf(trip) {
  const out = new Map();
  for (const load of trip?.loads || []) for (const l of load.lines || []) bump(out, l.stockId, l.qty);
  return out;
}

/** What approved invoices on the trip took off the van, as Map(stockId -> qty). Services are not stocked: skip them. */
function soldOf(invoices) {
  const out = new Map();
  for (const inv of invoices || []) {
    for (const l of inv.items || []) if (l.itemType !== "service") bump(out, l.itemId, l.qty);
  }
  return out;
}

/** What approved sales returns on the trip brought back: { good: Map, damaged: Map } (a line with no condition is good). */
function returnedOf(returns) {
  const good = new Map();
  const damaged = new Map();
  for (const r of returns || []) {
    for (const l of r.items || []) {
      if (l.itemType === "service") continue;
      bump(l.returnCondition === "damaged" ? damaged : good, l.itemId, l.qty);
    }
  }
  return { good, damaged };
}

/**
 * What is on the van. `sellable` is what may still be sold; `physical` is what is really in the van (the depot's free
 * stock must leave it alone); `damaged` is the part of physical that cannot be sold. A trip that is not holding stock
 * has nothing on the van.
 */
function onVan({ status, loaded = new Map(), sold = new Map(), returned = { good: new Map(), damaged: new Map() } }) {
  const sellable = new Map();
  const physical = new Map();
  const damaged = new Map();
  if (!HOLDING.has(status)) return { sellable, physical, damaged };
  const ids = new Set([...loaded.keys(), ...sold.keys(), ...returned.good.keys(), ...returned.damaged.keys()]);
  for (const id of ids) {
    const l = loaded.get(id) || 0;
    const s = sold.get(id) || 0;
    const g = returned.good.get(id) || 0;
    const d = returned.damaged.get(id) || 0;
    const can = round3(l - s + g);
    const dmg = round3(d);
    if (Math.abs(can) > EPS) sellable.set(id, can);
    if (Math.abs(dmg) > EPS) damaged.set(id, dmg);
    const phys = round3(can + dmg);
    if (Math.abs(phys) > EPS) physical.set(id, phys);
  }
  return { sellable, physical, damaged };
}

/** Add several trips' physical stock together: what is on every van at once, as Map(stockId -> qty). */
function onVansAll(perTrip) {
  const out = new Map();
  for (const p of perTrip || []) for (const [id, q] of p.physical || p) bump(out, id, q);
  return out;
}

/**
 * The depot's free stock for one item: what the books hold, less what is out with job workers and what is sitting in
 * vans. Never below zero.
 */
function freeDepot({ currentStock = 0, withJobWorker = 0, onVans = 0 }) {
  return Math.max(0, round3(Number(currentStock) - Number(withJobWorker) - Number(onVans)));
}

/** Check and tidy the lines of a load: positive quantities, one row per item, nothing blank. */
function validateLoadLines(lines) {
  if (!Array.isArray(lines) || !lines.length) throw new VanError("Add at least one item to load", "LOAD_EMPTY");
  const merged = new Map();
  lines.forEach((l, i) => {
    const n = i + 1;
    const stockId = idOf(l?.stockId);
    if (!stockId) throw new VanError(`Line ${n}: choose an item`, "ITEM_REQUIRED", { line: n });
    const qty = Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new VanError(`Line ${n}: enter a quantity above zero`, "QTY_INVALID", { line: n });
    const cur = merged.get(stockId) || { stockId, itemName: text(l.itemName), qty: 0 };
    cur.qty = round3(cur.qty + qty);
    if (!cur.itemName) cur.itemName = text(l.itemName);
    merged.set(stockId, cur);
  });
  return [...merged.values()];
}

/** Which lines ask for more than `available` (Map(stockId -> qty)) holds? [{stockId, wanted, available}] */
function shortages(lines, available) {
  const out = [];
  const wanted = new Map();
  for (const l of lines || []) bump(wanted, l.itemId ?? l.stockId, l.qty);
  for (const [id, w] of wanted) {
    const have = available.get(id) || 0;
    if (w > have + EPS) out.push({ stockId: id, wanted: w, available: round3(have) });
  }
  return out;
}

/**
 * What the count at unload should show, item by item: the sellable goods that should be back, and the damaged ones.
 * `counted` is [{stockId, good, damaged}] from the person counting; an item not mentioned counts as nothing found.
 */
function unloadVariance({ sellable = new Map(), damaged = new Map() }, counted = []) {
  const found = new Map();
  for (const c of counted) {
    const id = idOf(c.stockId);
    if (!id) continue;
    const g = Number(c.good ?? 0);
    const d = Number(c.damaged ?? 0);
    if (!(g >= 0) || !(d >= 0)) throw new VanError("A count cannot be negative", "COUNT_NEGATIVE", { stockId: id });
    const cur = found.get(id) || { good: 0, damaged: 0 };
    found.set(id, { good: round3(cur.good + g), damaged: round3(cur.damaged + d) });
  }
  const ids = new Set([...sellable.keys(), ...damaged.keys(), ...found.keys()]);
  const rows = [];
  for (const id of ids) {
    const eg = sellable.get(id) || 0;
    const ed = damaged.get(id) || 0;
    const c = found.get(id) || { good: 0, damaged: 0 };
    rows.push({
      stockId: id,
      expectedGood: round3(eg), countedGood: c.good,
      expectedDamaged: round3(ed), countedDamaged: c.damaged,
      // units found minus units that should be there (good and damaged together: a damaged box is still a box)
      difference: round3(c.good + c.damaged - eg - ed),
    });
  }
  return rows;
}

/**
 * What settling does to the BOOKS' stock for one counted row. The sales return restocked a damaged unit and the van
 * still holds it, so the books carry expectedGood + expectedDamaged for this van; the world holds countedGood at the
 * depot and countedDamaged in the bin. Two moves bring them together:
 *   damage    = -countedDamaged            (the damaged goods leave stock, they cannot be sold)
 *   variance  = + difference               (units short or over: what is found less what should be there)
 * Net: countedGood - expectedGood - expectedDamaged, which is what the books must change by.
 */
function stockMoves(row) {
  return {
    stockId: row.stockId,
    damage: -round3(row.countedDamaged),
    variance: round3(row.difference),
  };
}

/**
 * The cash side of a settlement. The van's cash account holds what the salesman took; they hand some amount over.
 * ONE journal carries it, and it always balances:
 *   Dr main cash (handed) + Dr salesman shortages (short)  =  Cr van cash (expected) + Cr cash over/short (over)
 */
function cashSettlement({ expected, handed }) {
  const e = round2(expected);
  const h = round2(handed);
  if (h < 0) throw new VanError("The cash handed in cannot be negative", "CASH_NEGATIVE");
  const short = h < e ? round2(e - h) : 0;
  const over = h > e ? round2(h - e) : 0;
  return { expected: e, handed: h, short, over, variance: round2(h - e), balanced: short === 0 && over === 0 };
}

/** Cheques the van took that were not handed in: the numbers expected less the numbers handed over. */
function missingCheques(expected = [], handedNos = []) {
  const have = new Set((handedNos || []).map((n) => text(n, 40).toLowerCase()));
  return (expected || []).filter((c) => !have.has(text(c.chequeNo, 40).toLowerCase()));
}

/** A route's customers for a day, in the order they are visited, each with whether they were sold to or collected from. */
function routeToday(route, weekday, done = {}) {
  if (!route) return [];
  const days = Array.isArray(route.days) ? route.days : [];
  if (days.length && Number.isInteger(weekday) && !days.includes(weekday)) return [];
  return [...(route.customers || [])]
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    .map((c) => ({
      customerId: idOf(c.customerId), name: c.name || "", seq: c.seq ?? 0,
      sold: Boolean(done.sold?.has?.(idOf(c.customerId))),
      collected: Boolean(done.collected?.has?.(idOf(c.customerId))),
      visit: done.visited?.get?.(idOf(c.customerId)) || null,
    }));
}

/**
 * The strike rate: of the customers a van called on, how many bought. A call is a customer invoiced on the trip or a
 * visit recorded without a sale; one customer is one call however many times they were seen. Null when nobody was
 * called on (nothing to measure is not 0%).
 */
function calls({ buyers = [], visited = [] }) {
  const b = new Set(buyers.map(idOf));
  const all = new Set([...b, ...visited.map(idOf)]);
  return { productive: b.size, calls: all.size, strikeRate: all.size ? Math.round((b.size / all.size) * 1000) / 10 : null };
}

/** Is the cash a van carries past its limit? A limit of null or absent is no limit. */
const overCashLimit = (cash, limit) => limit !== null && limit !== undefined && Number(limit) >= 0 && round2(cash) > round2(limit);

/** May `status` move to `next`? The one place the trip's lifecycle is written down. */
const MOVES = {
  LOADING: ["ON_ROUTE", "CANCELLED"],
  ON_ROUTE: ["UNLOADED"],
  UNLOADED: ["SETTLED"],
  SETTLED: [],
  CANCELLED: [],
};
const canMove = (status, next) => (MOVES[status] || []).includes(next);

/** Normalise the fields a van is created or edited with. */
function validateVan(input = {}) {
  const code = text(input.code, 20).toUpperCase();
  const name = text(input.name, 80);
  if (!code) throw new VanError("Give the van a short code", "VAN_CODE_REQUIRED");
  if (!/^[A-Z0-9-]{1,20}$/.test(code)) throw new VanError("The van code uses letters, digits and dashes only", "VAN_CODE_INVALID");
  if (!name) throw new VanError("Give the van a name", "VAN_NAME_REQUIRED");
  let cashLimit = null;
  if (input.cashLimit !== undefined && input.cashLimit !== null && input.cashLimit !== "") {
    cashLimit = Number(input.cashLimit);
    if (!Number.isFinite(cashLimit) || cashLimit < 0) throw new VanError("The cash limit is an amount of zero or more", "VAN_CASH_LIMIT_INVALID");
    cashLimit = round2(cashLimit);
  }
  let offlineBlock = 0;
  if (input.offlineBlock !== undefined && input.offlineBlock !== null && input.offlineBlock !== "") {
    offlineBlock = Number(input.offlineBlock);
    if (!Number.isInteger(offlineBlock) || offlineBlock < 0 || offlineBlock > 200) throw new VanError("Reserve between 0 and 200 invoice numbers for offline sales", "VAN_OFFLINE_BLOCK_INVALID");
  }
  return { code, name, plate: text(input.plate, 20).toUpperCase(), cashLimit, offlineBlock, ...targetsOf(input) };
}

/**
 * A van's daily targets: what it should sell (an amount) and how many customers it should call on in a day. Both
 * optional; blank means no target, never zero. Kept on the van and copied onto each trip as it opens, so changing a
 * target later never rewrites how an earlier day is judged.
 */
function targetsOf(input = {}) {
  const out = {};
  const blank = (v) => v === undefined || v === null || v === "";
  if ("dailySalesTarget" in input) {
    if (blank(input.dailySalesTarget)) out.dailySalesTarget = null;
    else {
      const v = Number(input.dailySalesTarget);
      if (!Number.isFinite(v) || v < 0 || v > 1e9) throw new VanError("The daily sales target is an amount of zero or more", "VAN_TARGET_INVALID");
      out.dailySalesTarget = round2(v);
    }
  }
  if ("dailyCallsTarget" in input) {
    if (blank(input.dailyCallsTarget)) out.dailyCallsTarget = null;
    else {
      const v = Number(input.dailyCallsTarget);
      if (!Number.isInteger(v) || v < 0 || v > 500) throw new VanError("The daily calls target is a whole number from 0 to 500", "VAN_TARGET_INVALID");
      out.dailyCallsTarget = v;
    }
  }
  return out;
}

/** How far a trip is toward its targets: done, the target, the share (capped at 100 for the bar, never for the figure) and what is left. */
function targetProgress({ sales = 0, calls = 0, target } = {}) {
  if (!target || (target.sales == null && target.calls == null)) return null;
  const one = (done, goal, money) => (goal == null || !(Number(goal) > 0) ? null : {
    target: money ? round2(goal) : Number(goal),
    done: money ? round2(done) : Number(done),
    pct: Math.round((Number(done) / Number(goal)) * 100),
    toGo: money ? round2(Math.max(0, goal - done)) : Math.max(0, Number(goal) - Number(done)),
    hit: Number(done) >= Number(goal),
  });
  return { sales: one(Number(sales) || 0, target.sales, true), calls: one(Number(calls) || 0, target.calls, false) };
}

/** Normalise a route: a name, the weekdays it runs (0 = Sunday), and its customers in visit order. */
function validateRoute(input = {}) {
  const name = text(input.name, 80);
  if (!name) throw new VanError("Give the route a name", "ROUTE_NAME_REQUIRED");
  const days = [...new Set((Array.isArray(input.days) ? input.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
  const seen = new Set();
  const customers = [];
  for (const c of Array.isArray(input.customers) ? input.customers : []) {
    const id = idOf(c.customerId);
    if (!id || seen.has(id)) continue; // a customer is on a route once
    seen.add(id);
    customers.push({ customerId: id, name: text(c.name, 150), seq: customers.length });
  }
  const priceListId = idOf(input.priceListId) || null;
  return { name, days, customers, priceListId };
}

/**
 * What to load for the next run of a route, each figure with the reason behind it:
 *   want = what pre-orders ask for + the average sold per run over the last runs (history), less what is already on
 *   the van; never more than the depot has free. A pre-order counts in full; the average is rounded UP to a whole unit.
 * history: [Map(stockId -> qty sold on that run)]; preorders / onVan / free / names: Map keyed by stockId.
 * -> [{ stockId, itemName, qty, why: { preorder, average, runs, onVan, free, capped } }], largest first.
 */
function suggestLoad({ preorders = new Map(), history = [], onVan: holding = new Map(), free = new Map(), names = new Map(), extraPercent = 0 } = {}) {
  const runs = history.length;
  const margin = 1 + (Number(extraPercent) > 0 ? Number(extraPercent) : 0) / 100; // a safety margin on the average, never on a pre-order
  const ids = new Set([...preorders.keys(), ...history.flatMap((h) => [...h.keys()])]);
  const out = [];
  for (const id of ids) {
    const pre = round3(preorders.get(id) || 0);
    const average = runs ? round3(history.reduce((t, h) => t + Number(h.get(id) || 0), 0) / runs) : 0;
    const have = round3(holding.get(id) || 0);
    let want = Math.max(0, pre + Math.ceil(average * margin - EPS) - have);
    const avail = free.has(id) ? Math.max(0, round3(free.get(id))) : Infinity;
    const capped = want > avail + EPS;
    if (capped) want = avail;
    want = round3(want);
    if (want <= EPS) continue;
    out.push({ stockId: id, itemName: names.get(id) || "", qty: want, why: { preorder: pre, average, runs, onVan: have, free: avail === Infinity ? null : avail, capped } });
  }
  return out.sort((a, b) => b.qty - a.qty);
}

/**
 * The batches FEFO would hand the van for `qty` (earliest expiry first) that expire before `mustLastUntil` (the trip
 * day plus the shelf life the route's customers ask for). A warning only: short-dated stock may be loaded on purpose.
 * batches: [{ batchNo, expiryDate: "YYYY-MM-DD" | null, qty }] already in FEFO order.
 */
function expiringOnLoad(batches = [], qty, mustLastUntil) {
  const out = [];
  let left = Number(qty) || 0;
  for (const b of batches) {
    if (left <= EPS) break;
    const take = Math.min(left, Number(b.qty) || 0);
    left = round3(left - take);
    // a Date from the database prints as "Sat Nov 21 ...", which does not sort: take its ISO day
    const exp = !b.expiryDate ? "" : b.expiryDate instanceof Date ? b.expiryDate.toISOString().slice(0, 10) : String(b.expiryDate).slice(0, 10);
    if (exp && mustLastUntil && exp < mustLastUntil) out.push({ batchNo: b.batchNo || "", expiryDate: exp, qty: round3(take) });
  }
  return out;
}

/** The next day (after `fromDay`) a route runs, by its weekdays (0 = Sunday); no weekdays = tomorrow. */
function nextRunDay(days = [], fromDay) {
  const runs = new Set((days || []).map(Number));
  for (let n = 1; n <= 7; n += 1) {
    const d = addDays(fromDay, n);
    if (!runs.size || runs.has(new Date(`${d}T00:00:00Z`).getUTCDay())) return d;
  }
  return addDays(fromDay, 1);
}

/** "YYYY-MM-DD" plus whole days. */
function addDays(dayText, n) {
  const d = new Date(`${String(dayText).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (Number(n) || 0));
  return d.toISOString().slice(0, 10);
}

// ---- phase 5: the fleet ---------------------------------------------------------------------------------------

const FAR_METRES = 300; // a sale or visit further than this from the customer's pinned place is flagged
const QUIET_HOURS = 2; // a van out with nothing done for this long is flagged on the board

/** Metres between two points (haversine). Null when either is missing. */
function distanceM(a, b) {
  if (!a || !b || ![a.lat, a.lng, b.lat, b.lng].every((v) => Number.isFinite(Number(v)))) return null;
  const R = 6371000;
  const rad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}

/**
 * Where the phone was against where the customer is. A flag, never a refusal: the phone's location can be poor, and
 * the accuracy it reports widens the allowance (a reading good to 200 m is not "far" at 350 m).
 * -> { distanceM, far } or null when either place is unknown.
 */
function farFrom(customerLoc, here, limit = FAR_METRES) {
  const d = distanceM(customerLoc, here);
  if (d === null) return null;
  const slack = Math.max(0, Number(here?.accuracy) || 0);
  return { distanceM: d, far: d > limit + slack };
}

/** Normalise an odometer reading: a whole or decimal number of km, 0 to 9,999,999. Null when none was given. */
function odometerOf(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 9999999) throw new VanError("Enter the odometer reading in km", "ODOMETER_INVALID");
  return round2(n);
}

/** The km a trip ran, or null. A reading back below the one going out is refused where it is entered. */
const kmRun = (odo) => (odo && Number.isFinite(odo.out) && Number.isFinite(odo.in) ? round2(odo.in - odo.out) : null);

/**
 * One van on the supervisor's board. stops: the route as routeToday gives it; lastAt: the last thing done (a sale,
 * a payment, a visit); now: a Date. -> { done, total, next, lastAt, quietMinutes, quiet }
 */
function boardRow({ status, stops = [], lastAt = null, departedAt = null, now = new Date(), quietHours = QUIET_HOURS }) {
  const served = (s) => s.sold || s.collected || Boolean(s.visit);
  const done = stops.filter(served).length;
  const next = stops.find((s) => !served(s)) || null;
  const since = lastAt || departedAt;
  const quietMinutes = since ? Math.max(0, Math.round((now.getTime() - new Date(since).getTime()) / 60000)) : null;
  return {
    done, total: stops.length, next: next ? { customerId: next.customerId, name: next.name } : null,
    lastAt: lastAt || null, quietMinutes,
    quiet: status === "ON_ROUTE" && quietMinutes !== null && quietMinutes >= quietHours * 60 && done < stops.length,
  };
}

/**
 * What a route (or salesman, or van) made over its settled trips. Each trip row:
 *   { key, name, sales, cost, returns, returnsCost, damaged, expenses, cashVariance, km }
 * where sales / returns are net of VAT and cost / returnsCost are cost of goods. Gross margin = (sales - returns) -
 * (cost - returnsCost); contribution = gross margin - damaged - expenses + cashVariance (a shortage is negative).
 * -> [{ key, name, trips, sales, ..., grossMargin, contribution, marginPct, perKm }] largest contribution first.
 */
function routeProfit(rows = []) {
  const by = new Map();
  for (const r of rows) {
    const k = String(r.key || "none");
    const a = by.get(k) || { key: k, name: r.name || "No route", trips: 0, sales: 0, cost: 0, returns: 0, returnsCost: 0, damaged: 0, expenses: 0, cashVariance: 0, km: 0, kmTrips: 0 };
    a.trips += 1;
    for (const f of ["sales", "cost", "returns", "returnsCost", "damaged", "expenses", "cashVariance"]) a[f] = round2(a[f] + (Number(r[f]) || 0));
    if (Number.isFinite(r.km) && r.km !== null) { a.km = round2(a.km + r.km); a.kmTrips += 1; }
    by.set(k, a);
  }
  return [...by.values()].map((a) => {
    const netSales = round2(a.sales - a.returns);
    const grossMargin = round2(netSales - (a.cost - a.returnsCost));
    const contribution = round2(grossMargin - a.damaged - a.expenses + a.cashVariance);
    return {
      ...a, netSales, grossMargin, contribution,
      marginPct: netSales > 0 ? round2((contribution / netSales) * 100) : null,
      perKm: a.km > 0 ? round2(contribution / a.km) : null,
    };
  }).sort((x, y) => y.contribution - x.contribution);
}

/**
 * What a salesman should know at a customer's door, from that customer's own invoices (newest first, each
 * `{number, date, lines: [{stockId, name, qty}]}`) and what is on the van now (`onVan`: Map or object stockId -> qty):
 *  - lastOrder: the latest invoice, its lines merged per item, each marked with how many the van holds now;
 *  - usual: the items bought most often (in at least two invoices, or the only one there is), with the average
 *    quantity, best first - only what the van can sell now;
 *  - notLately: items bought in two or more of the OLDER invoices and in none of the last three - a sale slipping
 *    away - again only what the van holds.
 * Pure: nothing stored, nothing guessed beyond the customer's own history.
 */
function customerInsight({ invoices = [], onVan } = {}) {
  const held = onVan instanceof Map ? onVan : new Map(Object.entries(onVan || {}));
  const qtyOn = (id) => Number(held.get(String(id))) || 0;
  const merge = (lines = []) => {
    const m = new Map();
    for (const l of lines) {
      const id = String(l.stockId || "");
      if (!id || !(Number(l.qty) > 0)) continue;
      const cur = m.get(id) || { stockId: id, name: l.name || "", qty: 0 };
      cur.qty = round3(cur.qty + Number(l.qty));
      m.set(id, cur);
    }
    return [...m.values()];
  };
  const list = invoices.map((i) => ({ number: i.number, date: i.date, lines: merge(i.lines) })).filter((i) => i.lines.length);
  const last = list[0];
  const lastOrder = last ? { number: last.number, date: last.date, lines: last.lines.map((l) => ({ ...l, onVan: qtyOn(l.stockId) })) } : null;
  const seen = new Map();
  list.forEach((inv, idx) => {
    for (const l of inv.lines) {
      const cur = seen.get(l.stockId) || { stockId: l.stockId, name: l.name, count: 0, qty: 0, recent: false, older: 0 };
      cur.count += 1;
      cur.qty = round3(cur.qty + l.qty);
      if (idx < 3) cur.recent = true; else cur.older += 1;
      if (!cur.name && l.name) cur.name = l.name;
      seen.set(l.stockId, cur);
    }
  });
  const minCount = list.length <= 1 ? 1 : 2;
  const average = (x) => Math.max(1, Math.round(x.qty / x.count));
  const usual = [...seen.values()]
    .filter((x) => x.count >= minCount && qtyOn(x.stockId) > 0 && (list.length <= 3 || x.recent))
    .sort((a, b) => b.count - a.count || b.qty - a.qty || String(a.name).localeCompare(String(b.name)))
    .slice(0, 6)
    .map((x) => ({ stockId: x.stockId, name: x.name, times: x.count, avgQty: average(x), onVan: qtyOn(x.stockId) }));
  const notLately = list.length > 3
    ? [...seen.values()]
      .filter((x) => !x.recent && x.older >= 2 && qtyOn(x.stockId) > 0)
      .sort((a, b) => b.older - a.older || b.qty - a.qty)
      .slice(0, 5)
      .map((x) => ({ stockId: x.stockId, name: x.name, times: x.older, avgQty: average(x), onVan: qtyOn(x.stockId) }))
    : [];
  return { invoices: list.length, lastOrder, usual, notLately };
}

/**
 * The figures an owner judges a van, a salesman or a route by, from rolled-up counts (`{sales, invoices, lines, calls,
 * productive, expenses}`): the average drop (what one invoice is worth), lines per productive call (how wide a
 * basket is), strike rate (of the customers called on, the share that bought), and cost per drop (road expenses per
 * invoice). Null, never zero, when there is nothing to divide by.
 */
function kpis(a = {}) {
  const n = (v) => Number(v) || 0;
  return {
    // before VAT when the caller has it (the owner compares drops with the profit report, which is net of VAT)
    dropSize: n(a.invoices) ? round2(n(a.netSales ?? a.sales) / n(a.invoices)) : null,
    linesPerCall: n(a.productive) ? round2(n(a.lines) / n(a.productive)) : null,
    strikeRate: n(a.calls) ? Math.round((n(a.productive) / n(a.calls)) * 1000) / 10 : null,
    costPerDrop: n(a.invoices) ? round2(n(a.expenses) / n(a.invoices)) : null,
  };
}

/** Sales and invoices per calendar day over a period (rows carry `day` "YYYY-MM-DD"); every day of the range is present. */
function salesByDay(rows = [], from, to) {
  const m = new Map();
  if (from && to && from <= to) for (let d = from, i = 0; d <= to && i < 400; d = addDays(d, 1), i += 1) m.set(d, { day: d, sales: 0, invoices: 0 });
  for (const r of rows) {
    const d = String(r.day || "").slice(0, 10);
    if (!d) continue;
    const cur = m.get(d) || { day: d, sales: 0, invoices: 0 };
    cur.sales = round2(cur.sales + (Number(r.sales) || 0));
    cur.invoices += Number(r.invoices) || 0;
    m.set(d, cur);
  }
  return [...m.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Why goods came back over a set of trips: one row per reason with how many returns, what they credited and how many of
 * them had no invoice behind them, biggest amount first. A return recorded before reasons existed is "Not given".
 * `amountOf(record)` supplies the credit for an older record that did not store its own.
 */
const NOT_GIVEN = "Not given";
function returnsByReason(trips, amountOf = () => 0) {
  const by = new Map();
  for (const t of trips || []) {
    for (const r of t.returns || []) {
      const reason = r.reason || NOT_GIVEN;
      const row = by.get(reason) || { reason, count: 0, amount: 0, withoutInvoice: 0 };
      row.count += 1;
      row.amount = round2(row.amount + (Number.isFinite(Number(r.amount)) && r.amount !== null && r.amount !== undefined ? Number(r.amount) : Number(amountOf(r)) || 0));
      if (r.withoutInvoice === true) row.withoutInvoice += 1;
      by.set(reason, row);
    }
  }
  return [...by.values()].sort((a, b) => b.amount - a.amount || b.count - a.count || a.reason.localeCompare(b.reason));
}

module.exports = {
  STATUSES, HOLDING, SELLING, MOVES, VanError, NOT_GIVEN, returnsByReason,
  round2, round3, idOf,
  loadedOf, soldOf, returnedOf, onVan, onVansAll, freeDepot,
  validateLoadLines, shortages, unloadVariance, stockMoves, cashSettlement, missingCheques, routeToday,
  canMove, validateVan, validateRoute, overCashLimit, calls,
  suggestLoad, expiringOnLoad, addDays, nextRunDay,
  FAR_METRES, QUIET_HOURS, distanceM, farFrom, odometerOf, kmRun, boardRow, routeProfit,
  targetsOf, targetProgress, customerInsight, kpis, salesByDay,
};
