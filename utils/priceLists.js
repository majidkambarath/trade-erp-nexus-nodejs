// Price lists: which price a customer pays for an item (pure: no Mongoose, no clock).
//
//   1. a list that names the CUSTOMER, in force on the day, with a line for the item;
//   2. else the list the ROUTE names, in force on the day, with a line for the item;
//   3. else the item's own sales price.
// Within a list, the line with the largest minimum quantity the sale reaches wins (a quantity break). Two customer
// lists that both name the customer: the one with the lower price for this item and quantity wins, so overlapping
// deals never charge a customer more than any one of them promised.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const idOf = (v) => (v && typeof v === "object" ? String(v._id || v) : v == null ? "" : String(v));
const day = (d) => (d ? String(d).slice(0, 10) : "");

class PriceListError extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Is the list good on this day? Inactive lists never are. */
function inForce(list, onDay) {
  if (!list || list.active === false) return false;
  const d = day(onDay);
  if (list.validFrom && d && d < list.validFrom) return false;
  if (list.validTo && d && d > list.validTo) return false;
  return true;
}

/** The list's price for an item at a quantity, or null when the list has no line it reaches. */
function linePrice(list, stockId, qty) {
  const id = idOf(stockId);
  const q = Number(qty) || 0;
  const hits = (list?.lines || []).filter((l) => idOf(l.stockId) === id && q + 1e-9 >= (Number(l.minQty) || 0));
  if (!hits.length) return null;
  hits.sort((a, b) => (Number(b.minQty) || 0) - (Number(a.minQty) || 0));
  return round2(hits[0].price);
}

/**
 * The price a customer pays. `lists` is every list that might apply (the caller reads them once).
 * -> { price, source: "customer" | "route" | "item", listId, listName }
 */
function priceFor({ stockId, qty = 1, customerId, routeListId, date, lists = [], itemPrice = 0 }) {
  const cust = idOf(customerId);
  const live = lists.filter((l) => inForce(l, date));
  let best = null;
  for (const l of live.filter((x) => (x.customerIds || []).some((c) => idOf(c) === cust))) {
    const p = linePrice(l, stockId, qty);
    if (p !== null && (best === null || p < best.price)) best = { price: p, source: "customer", listId: idOf(l._id), listName: l.name };
  }
  if (best) return best;
  const route = live.find((l) => idOf(l._id) === idOf(routeListId));
  if (route) {
    const p = linePrice(route, stockId, qty);
    if (p !== null) return { price: p, source: "route", listId: idOf(route._id), listName: route.name };
  }
  return { price: round2(itemPrice), source: "item", listId: "", listName: "" };
}

/** Normalise a list from a form: a name, the days, the customers, one line per item and quantity break. */
function validateList(input = {}) {
  const name = String(input.name || "").trim().slice(0, 80);
  if (!name) throw new PriceListError("Give the price list a name", "PRICE_LIST_NAME_REQUIRED");
  const validFrom = day(input.validFrom);
  const validTo = day(input.validTo);
  const isDay = (d) => !d || /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (!isDay(validFrom) || !isDay(validTo)) throw new PriceListError("Use real dates", "INVALID_DATE");
  if (validFrom && validTo && validFrom > validTo) throw new PriceListError("The list ends before it starts", "INVALID_RANGE");
  const seen = new Set();
  const lines = [];
  (Array.isArray(input.lines) ? input.lines : []).forEach((l, i) => {
    const stockId = idOf(l.stockId);
    if (!stockId) return;
    const price = Number(l.price);
    const minQty = l.minQty === undefined || l.minQty === "" ? 1 : Number(l.minQty);
    if (!Number.isFinite(price) || price < 0) throw new PriceListError(`Line ${i + 1}: enter a price of zero or more`, "PRICE_INVALID", { line: i + 1 });
    if (!Number.isFinite(minQty) || minQty < 0) throw new PriceListError(`Line ${i + 1}: the minimum quantity is zero or more`, "MIN_QTY_INVALID", { line: i + 1 });
    const key = `${stockId}:${minQty}`;
    if (seen.has(key)) throw new PriceListError(`Line ${i + 1}: that item already has a price at this quantity`, "DUPLICATE_PRICE_LINE", { line: i + 1 });
    seen.add(key);
    lines.push({ stockId, itemName: String(l.itemName || "").slice(0, 150), price: round2(price), minQty });
  });
  const customerIds = [...new Set((Array.isArray(input.customerIds) ? input.customerIds : []).map(idOf).filter(Boolean))];
  return { name, validFrom, validTo, customerIds, lines };
}

module.exports = { PriceListError, inForce, linePrice, priceFor, validateList };
