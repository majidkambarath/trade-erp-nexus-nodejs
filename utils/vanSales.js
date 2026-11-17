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
    }));
}

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
  return { code, name, plate: text(input.plate, 20).toUpperCase() };
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
  return { name, days, customers };
}

module.exports = {
  STATUSES, HOLDING, SELLING, MOVES, VanError,
  round2, round3, idOf,
  loadedOf, soldOf, returnedOf, onVan, onVansAll, freeDepot,
  validateLoadLines, shortages, unloadVariance, stockMoves, cashSettlement, missingCheques, routeToday,
  canMove, validateVan, validateRoute,
};
