// Promotions on a van sale (pure: no Mongoose, no clock). Three kinds:
//
//   slab   - buy at least `minQty` of an item (or of a category) and each unit is `percent` % off;
//   bxgy   - for every `buyQty` of an item bought, `freeQty` of `freeStockId` (default the same item) is given free;
//   basket - an invoice worth at least `minValue` (after line discounts) is `percent` % off on every line.
//
// Order: highest `priority` first. On one line, the best slab wins unless every slab on it is `stackable` (then they
// combine). A promotion that is NOT stackable on a line stops a basket from adding to that line. Free goods are lines
// of their own at price 0: they leave the van and the books at cost like any other line, so a promotion is never
// stock that silently disappears. The same rule runs on the phone (src/lib/promotions.js) so an offline slip shows
// the offer the server will give.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const idOf = (v) => (v && typeof v === "object" ? String(v._id || v) : v == null ? "" : String(v));
const day = (d) => (d ? String(d).slice(0, 10) : "");
const KINDS = ["slab", "bxgy", "basket"];

class PromotionError extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Good on this day, switched on, and for this customer / route (an empty list means everyone). */
function appliesTo(p, { date, customerId, routeId } = {}) {
  if (!p || p.active === false) return false;
  const d = day(date);
  if (p.validFrom && d && d < p.validFrom) return false;
  if (p.validTo && d && d > p.validTo) return false;
  const cust = (p.customerIds || []).map(idOf);
  const routes = (p.routeIds || []).map(idOf);
  if (!cust.length && !routes.length) return true;
  return cust.includes(idOf(customerId)) || routes.includes(idOf(routeId));
}

/** Does the promotion cover this item (by the item, or its category; none named = every item)? */
function covers(p, line) {
  const items = (p.stockIds || []).map(idOf);
  const cats = (p.categoryIds || []).map(idOf);
  if (!items.length && !cats.length) return true;
  return items.includes(idOf(line.itemId)) || (line.categoryId && cats.includes(idOf(line.categoryId)));
}

/** Two discounts one after the other: 10 % then 5 % is 14.5 %, never 15 %. */
const combine = (a, b) => round2(100 - ((100 - a) * (100 - b)) / 100);
const value = (l) => Number(l.qty) * Number(l.price) * (1 - (Number(l.discountPercent) || 0) / 100);

/**
 * lines: [{ itemId, categoryId?, qty, price, discountPercent? }]. promos: every candidate (the caller filters nothing).
 * -> { lines: same order, with discountPercent and promoIds; free: [{ stockId, qty, promoId }]; applied: [{ id, name, kind, text }] }
 */
function apply(lines = [], promos = [], ctx = {}) {
  const live = promos.filter((p) => KINDS.includes(p.kind) && appliesTo(p, ctx)).sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0));
  const out = lines.map((l) => ({ ...l, discountPercent: Number(l.discountPercent) || 0, promoIds: [], locked: false }));
  const applied = new Map();
  const note = (p, text) => { if (!applied.has(idOf(p._id))) applied.set(idOf(p._id), { id: idOf(p._id), name: p.name, kind: p.kind, text }); };

  // slabs: per line, the best one, or all of them when they are all stackable
  for (const l of out) {
    const hits = live.filter((p) => p.kind === "slab" && covers(p, l) && Number(l.qty) + 1e-9 >= (Number(p.minQty) || 0));
    if (!hits.length) continue;
    const stack = hits.every((p) => p.stackable);
    const chosen = stack ? hits : [hits.reduce((best, p) => (Number(p.percent) > Number(best.percent) ? p : best))];
    for (const p of chosen) {
      l.discountPercent = combine(l.discountPercent, Number(p.percent) || 0);
      l.promoIds.push(idOf(p._id));
      if (!p.stackable) l.locked = true;
      note(p, `${p.percent}% off ${p.minQty > 1 ? `from ${p.minQty} units` : "each unit"}`);
    }
  }

  // buy X get Y: added up by the free item, so two promotions giving the same item free make one line
  const free = new Map();
  for (const p of live.filter((x) => x.kind === "bxgy")) {
    const buyQty = Number(p.buyQty) || 0;
    if (!(buyQty > 0) || !(Number(p.freeQty) > 0)) continue;
    const bought = out.filter((l) => covers(p, l)).reduce((t, l) => t + Number(l.qty), 0);
    const times = Math.floor((bought + 1e-9) / buyQty);
    if (!times) continue;
    const target = idOf(p.freeStockId) || idOf(out.find((l) => covers(p, l))?.itemId);
    if (!target) continue;
    const key = target;
    const prev = free.get(key) || { stockId: target, qty: 0, promoId: idOf(p._id) };
    prev.qty += times * Number(p.freeQty);
    free.set(key, prev);
    note(p, `${p.freeQty} free for every ${buyQty}`);
  }

  // basket: on the value after line discounts, never over a line a non-stackable promotion already holds
  const total = out.reduce((t, l) => t + value(l), 0);
  const basket = live.filter((p) => p.kind === "basket" && total + 0.005 >= (Number(p.minValue) || 0));
  if (basket.length) {
    const best = basket.reduce((b, p) => (Number(p.percent) > Number(b.percent) ? p : b));
    const open = out.filter((l) => !l.locked);
    if (open.length) {
      for (const l of open) {
        l.discountPercent = combine(l.discountPercent, Number(best.percent) || 0);
        l.promoIds.push(idOf(best._id));
      }
      note(best, `${best.percent}% off an order of ${round2(best.minValue)} or more`);
    }
  }

  return {
    lines: out.map((l) => { const copy = { ...l }; delete copy.locked; return copy; }),
    free: [...free.values()].map((f) => ({ ...f, qty: round2(f.qty) })),
    applied: [...applied.values()],
  };
}

/** Normalise a promotion from a form. */
function validatePromotion(input = {}) {
  const name = String(input.name || "").trim().slice(0, 80);
  if (!name) throw new PromotionError("Give the promotion a name", "PROMOTION_NAME_REQUIRED");
  const kind = String(input.kind || "");
  if (!KINDS.includes(kind)) throw new PromotionError("Choose what kind of offer it is", "PROMOTION_KIND_INVALID");
  const validFrom = day(input.validFrom);
  const validTo = day(input.validTo);
  const isDay = (d) => !d || /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!isDay(validFrom) || !isDay(validTo)) throw new PromotionError("Use real dates", "INVALID_DATE");
  if (validFrom && validTo && validFrom > validTo) throw new PromotionError("The offer ends before it starts", "INVALID_RANGE");
  const num = (v, label, { min = 0, max = Infinity, whole = false } = {}) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max || (whole && !Number.isInteger(n))) throw new PromotionError(`Enter a valid ${label}`, "PROMOTION_VALUE_INVALID", { field: label });
    return n;
  };
  const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map(idOf).filter(Boolean))];
  const out = {
    name, kind, validFrom, validTo,
    priority: input.priority === undefined || input.priority === "" ? 0 : num(input.priority, "priority", { min: 0, max: 100, whole: true }),
    stackable: input.stackable === true,
    stockIds: ids(input.stockIds), categoryIds: ids(input.categoryIds),
    customerIds: ids(input.customerIds), routeIds: ids(input.routeIds),
  };
  if (kind === "slab") {
    out.minQty = num(input.minQty ?? 1, "minimum quantity", { min: 0 });
    out.percent = num(input.percent, "discount %", { min: 0.01, max: 100 });
  } else if (kind === "bxgy") {
    out.buyQty = num(input.buyQty, "quantity to buy", { min: 1 });
    out.freeQty = num(input.freeQty, "quantity given free", { min: 0.001 });
    out.freeStockId = idOf(input.freeStockId) || "";
    if (!out.freeStockId && out.stockIds.length !== 1) throw new PromotionError("Say which item is given free", "FREE_ITEM_REQUIRED");
  } else {
    out.minValue = num(input.minValue, "order value", { min: 0 });
    out.percent = num(input.percent, "discount %", { min: 0.01, max: 100 });
  }
  return out;
}

module.exports = { KINDS, PromotionError, appliesTo, covers, combine, apply, validatePromotion };
