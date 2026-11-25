// Returnable containers on the vans (crates, bottles, cylinders): the arithmetic, with no database, so the services, the
// settlement and the tests share it. A container is never a stock item (see models/modules/vansales/containerTypeModel.js).
//
//   containersIn  how many containers some goods take: qty x perUnit per type (a 1L milk at 1/12 of a crate)
//   givenFor      what a sale hands out: the containers its goods take, a part container rounded UP (5 milk = 1 crate)
//   depositOf     what the moves are worth in deposit: (given - collected) x deposit, positive = the customer owes it
//   expectedOnVan what should come back on the van: the containers the loaded goods left in (whole), less what was
//                 given, plus what was collected. Goods returned on the road bring their containers back only if the
//                 salesman records them as collected: a return does not move containers by itself.

const EPS = 1e-9;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
// an id as text: an ObjectId prints as its hex, a populated document gives its _id
const idOf = (v) => (v === null || v === undefined ? "" : typeof v === "object" && v._id ? String(v._id) : String(v));

class ContainerError extends Error {
  constructor(message, code, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const isNum = (v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "");

/** A container type as it may be saved. -> { code, name, deposit, active, items } or throws ContainerError. */
function validateType(input) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const code = typeof src.code === "string" ? src.code.trim().toUpperCase() : "";
  if (!/^[A-Z0-9][A-Z0-9-]{0,11}$/.test(code)) throw new ContainerError("Give the container a short code: letters, digits or a dash, up to 12", "CONTAINER_CODE_INVALID", { field: "code" });
  const name = typeof src.name === "string" ? src.name.trim() : "";
  if (!name || name.length > 60) throw new ContainerError("Name the container (up to 60 characters)", "CONTAINER_NAME_INVALID", { field: "name" });
  const deposit = src.deposit === undefined || src.deposit === null || src.deposit === "" ? 0 : isNum(src.deposit) ? Number(src.deposit) : NaN;
  if (!Number.isFinite(deposit) || deposit < 0 || deposit > 100000) throw new ContainerError("The deposit is an amount from 0 to 100,000 (0 for none)", "CONTAINER_DEPOSIT_INVALID", { field: "deposit" });
  const rawItems = src.items === undefined ? [] : src.items;
  if (!Array.isArray(rawItems)) throw new ContainerError("Send the items as a list", "CONTAINER_ITEMS_INVALID", { field: "items" });
  const seen = new Set();
  const items = rawItems.map((it, i) => {
    const stockId = typeof it?.stockId === "string" ? it.stockId : "";
    if (!/^[a-f0-9]{24}$/i.test(stockId)) throw new ContainerError(`Item ${i + 1}: choose an item`, "CONTAINER_ITEMS_INVALID", { field: "items" });
    if (seen.has(stockId)) throw new ContainerError(`Item ${i + 1} is listed twice`, "CONTAINER_ITEMS_INVALID", { field: "items" });
    seen.add(stockId);
    const perUnit = isNum(it.perUnit) ? Number(it.perUnit) : NaN;
    if (!Number.isFinite(perUnit) || perUnit <= 0 || perUnit > 100) throw new ContainerError(`Item ${i + 1}: how many containers one unit takes, above 0 (1/12 = 0.0833 for a crate of 12)`, "CONTAINER_ITEMS_INVALID", { field: "items" });
    return { stockId, perUnit: Math.round(perUnit * 10000) / 10000 };
  });
  return { code, name, deposit: round2(deposit), active: src.active !== false, items };
}

/** Map(stockId -> { typeId, perUnit }) from the types (an item belongs to one type: the first listing it wins). */
function itemIndex(types) {
  const out = new Map();
  for (const t of types || []) {
    if (t.active === false) continue;
    for (const it of t.items || []) {
      const k = String(it.stockId);
      if (!out.has(k)) out.set(k, { typeId: String(t._id || t.id), perUnit: Number(it.perUnit) || 0 });
    }
  }
  return out;
}

/** How many containers some goods take: Map(typeId -> exact number). `lines` is [{ stockId | itemId, qty }] or a Map(stockId -> qty). */
function containersIn(lines, types) {
  const index = itemIndex(types);
  const pairs = lines instanceof Map ? [...lines] : (lines || []).map((l) => [idOf(l.stockId || l.itemId), Number(l.qty) || 0]);
  const out = new Map();
  for (const [stockId, qty] of pairs) {
    const hit = index.get(String(stockId));
    if (!hit || !(qty > 0)) continue;
    out.set(hit.typeId, round3((out.get(hit.typeId) || 0) + qty * hit.perUnit));
  }
  return out;
}

/** What a sale hands out, in whole containers (a part container is a container): Map(typeId -> n). */
function givenFor(lines, types) {
  const out = new Map();
  for (const [typeId, n] of containersIn(lines, types)) out.set(typeId, Math.ceil(n - EPS));
  return out;
}

const whole = (raw) => (isNum(raw) ? Number(raw) : raw === undefined || raw === null || raw === "" ? 0 : NaN);

/**
 * The containers a person says changed hands: [{ typeId, given, collected }], whole numbers of zero or more, one row
 * per type (repeats added together), rows with nothing in them dropped. Throws ContainerError on anything else.
 */
function cleanMoves(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ContainerError("Send the containers as a list", "CONTAINERS_INVALID");
  const by = new Map();
  raw.forEach((r, i) => {
    const typeId = typeof r?.typeId === "string" ? r.typeId : "";
    if (!/^[a-f0-9]{24}$/i.test(typeId)) throw new ContainerError(`Containers line ${i + 1}: choose the container`, "CONTAINERS_INVALID", { line: i + 1 });
    const given = whole(r.given);
    const collected = whole(r.collected);
    for (const [n, what] of [[given, "given"], [collected, "collected"]]) {
      if (!Number.isInteger(n) || n < 0 || n > 100000) throw new ContainerError(`Containers line ${i + 1}: ${what} is a whole number of zero or more`, "CONTAINERS_INVALID", { line: i + 1 });
    }
    const cur = by.get(typeId) || { typeId, given: 0, collected: 0 };
    cur.given += given;
    cur.collected += collected;
    by.set(typeId, cur);
  });
  return [...by.values()].filter((m) => m.given > 0 || m.collected > 0);
}

/** What the moves are worth in deposit, given each type's deposit (Map or object typeId -> amount). Positive: the customer owes it. */
function depositOf(moves, depositByType) {
  const dep = (id) => Number(depositByType instanceof Map ? depositByType.get(String(id)) : depositByType?.[String(id)]) || 0;
  return round2((moves || []).reduce((t, m) => t + ((Number(m.given) || 0) - (Number(m.collected) || 0)) * dep(m.typeId), 0));
}

/** A customer's holding per type from their moves: Map(typeId -> given less collected). */
function holdings(moves) {
  const out = new Map();
  for (const m of moves || []) out.set(String(m.typeId), (out.get(String(m.typeId)) || 0) + (Number(m.given) || 0) - (Number(m.collected) || 0));
  return out;
}

/**
 * What should be on the van per type at count-in: whole containers the loaded goods left in, less those given to
 * customers, plus those collected from them. Map(typeId -> n).
 */
function expectedOnVan({ loaded, moves }, types) {
  const out = new Map();
  for (const [typeId, n] of containersIn(loaded, types)) out.set(typeId, Math.ceil(n - EPS));
  for (const m of moves || []) {
    const id = String(m.typeId);
    out.set(id, (out.get(id) || 0) - (Number(m.given) || 0) + (Number(m.collected) || 0));
  }
  return out;
}

/** The count-in rows: [{ typeId, name, expected, counted, difference, value }] (value = missing x deposit, 0 for none). */
function countRows(expected, counted, types) {
  const byType = new Map((types || []).map((t) => [String(t._id || t.id), t]));
  const ids = new Set([...expected.keys(), ...counted.keys()]);
  return [...ids].map((typeId) => {
    const t = byType.get(typeId) || {};
    const e = expected.get(typeId) || 0;
    const c = counted.has(typeId) ? counted.get(typeId) : e;
    const difference = c - e;
    return { typeId, name: t.name || "", code: t.code || "", expected: e, counted: c, difference, value: round2(Math.max(0, -difference) * (Number(t.deposit) || 0)) };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { ContainerError, validateType, itemIndex, containersIn, givenFor, cleanMoves, depositOf, holdings, expectedOnVan, countRows, round2 };
