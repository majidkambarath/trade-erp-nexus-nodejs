const mongoose = require("mongoose");
const Stock = require("../../models/modules/stockModel");
require("../../models/modules/uomModel"); // registers "UOM" for the unit populate
const Category = require("../../models/modules/categoryModel");
const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const StockBatch = require("../../models/modules/stockBatchModel");
const Transaction = require("../../models/modules/transactionModel");
const Customer = require("../../models/modules/customerModel");
const Vendor = require("../../models/modules/vendorModel");
const { LedgerAccount, LedgerEntry } = require("../../models/modules/financial/financialModels");
const AccountConfigService = require("../financial/accountConfigService");
const LedgerReportsService = require("./ledgerReportsService");
const orgLocale = require("../../utils/orgLocale");
const AppError = require("../../utils/AppError");
const { round2 } = require("../../utils/accounting");
const { getTenant } = require("../../utils/tenant");

// Stock reports: valuation, movement summary, item ledger, sales / purchase analysis, expiry, slow
// stock and reorder. They read InventoryMovement (the stock audit trail), Stock, StockBatch and
// Transaction, and the valuation and movement reports are reconciled to the Inventory account of
// the general ledger.
//
// HOW QUANTITY AND VALUE ARE DERIVED (the choice every figure here rests on)
//   A position "as on" a date is the SUM of the signed effect of every live movement dated up to
//   the end of that day in the organisation's zone - not the `newStock` / `costPoolAfter` of the last movement.
//   `newStock` and the pool snapshots are a running chain in the order movements were CREATED:
//   a back-dated document, a reversal or a recost makes the "last movement by date" a different
//   row from the "last movement written", so reading the chain at a date is wrong whenever
//   history was edited. A sum is order-independent and additive, which also makes
//   closing = opening + in - out hold exactly for quantity and for value.
//   - Quantity: sum of `quantity` (signed: + in, - out).
//   - Value:    sum of sign(quantity) x |totalValue|. totalValue is the cost that moved with the
//               stock - exactly the figure the ledger posts to the Inventory account - so a sum of
//               it compares to the ledger line by line. (Stock.costValue is only a running total;
//               it is what the sum should equal, and the tests check that it does.)
//   - Average cost: the item's last live `rateAfter` (the engine keeps it sticky when a pool empties);
//               value / quantity only for history with no rate. Value is the exact cost on hand, so
//               qty x average can differ from it by a rounding fraction of a fils per unit.
//   - A movement is LIVE unless it was reversed (isReversed) or is itself a reversal row
//               (referenceNumber "REV-..."). The pair cancels, exactly as a reversed ledger entry
//               drops out of every ledger report, so stock and ledger agree about deleted documents.
//   - History that starts mid-stream (an item created with stock but no INITIAL_STOCK movement)
//               shows up as the `previousStock` of the first movement ever written. That quantity,
//               valued at the pool rate before it, is added to the opening position as an
//               "implicit opening" so the totals are not understated; it never counts as a
//               period movement and, having no ledger posting, is listed in the reconciliation.

const DAY = 86400000;
const QTY_EPS = 0.0005;
const MAX_LEDGER_ROWS = 5000;

const BUCKETS = ["purchases", "purchaseReturns", "sales", "salesReturns", "writeOffs", "adjustments"];
const BUCKET_OF_EVENT = {
  PURCHASE_RECEIVE: "purchases",
  PURCHASE_RETURN: "purchaseReturns",
  SALES_DISPATCH: "sales",
  SALES_RETURN: "salesReturns",
  DAMAGED_STOCK: "writeOffs",
  // INITIAL_STOCK, STOCK_ADJUSTMENT, TRANSFER_IN / TRANSFER_OUT -> adjustments
};
const OUT_BUCKETS = new Set(["purchaseReturns", "sales", "writeOffs"]);
// Approval is a status of its own; PAID / PARTIAL are what documents approved by older versions may still carry.
const APPROVED = ["APPROVED", "PAID", "PARTIAL"];
const EVENT_LABEL = {
  PURCHASE_RECEIVE: "Purchase", PURCHASE_RETURN: "Purchase return", SALES_DISPATCH: "Sale", SALES_RETURN: "Sales return",
  INITIAL_STOCK: "Opening stock", OPENING_STOCK: "Opening stock", STOCK_ADJUSTMENT: "Stock adjustment", DAMAGED_STOCK: "Write-off",
  TRANSFER_IN: "Transfer in", TRANSFER_OUT: "Transfer out",
};

// Live movements only (see the note above).
const LIVE = { isReversed: { $ne: true }, referenceNumber: { $not: /^REV-/ } };
const SIGN = { $cond: [{ $gt: ["$quantity", 0] }, 1, { $cond: [{ $lt: ["$quantity", 0] }, -1, 0] }] };
const SIGNED_VALUE = { $multiply: [SIGN, { $abs: { $ifNull: ["$totalValue", 0] } }] };
const BUCKET_EXPR = {
  $switch: {
    branches: Object.entries(BUCKET_OF_EVENT).map(([event, bucket]) => ({ case: { $eq: ["$eventType", event] }, then: bucket })),
    default: "adjustments",
  },
};

const r2 = (n) => round2(n) || 0; // `|| 0` turns -0 into 0
const r5 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e5) / 1e5 || 0;
const r6 = (n) => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6 || 0;
const signedValue = (m) => Math.sign(m.quantity) * Math.abs(Number(m.totalValue) || 0);
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const orgToday = (now = new Date()) => orgLocale.today(now);
const monthStart = () => `${orgToday().slice(0, 7)}-01`;
const isObjectIdText = (v) => /^[0-9a-f]{24}$/i.test(String(v));

function objectId(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (!isObjectIdText(value)) throw new AppError(`${label} is not valid`, 400, "INVALID_ID");
  return new mongoose.Types.ObjectId(String(value));
}

// { start, end } as the organisation's days. `to` defaults to today; a missing `from` leaves the start open.
function span({ from, to, defaultFrom } = {}) {
  const f = from || defaultFrom || null;
  const t = to || orgToday();
  const start = f ? LedgerReportsService.dayStart(f) : null;
  const end = LedgerReportsService.dayEnd(t);
  if (start && start > end) throw new AppError("The start date is after the end date", 400, "INVALID_RANGE");
  return { start, end, from: f, to: t };
}

function wholeNumber(value, fallback, { min, max, label }) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new AppError(`${label} must be a whole number from ${min} to ${max}`, 400, "INVALID_PARAMETER");
  return n;
}

// ------------------------------------------------------------------ item master

async function itemMaster() {
  const [stocks, categories] = await Promise.all([
    Stock.find({})
      .select("itemId sku itemName category status reorderLevel purchasePrice costValue currentStock vendorId unitOfMeasure")
      .populate("unitOfMeasure", "shortCode")
      .lean(),
    Category.find({}).select("name").lean(),
  ]);
  const categoryName = new Map(categories.map((c) => [String(c._id), c.name]));
  const byCode = new Map();
  const byId = new Map();
  for (const s of stocks) {
    const meta = {
      stockId: String(s._id), itemId: s.itemId, sku: s.sku, itemName: s.itemName,
      categoryId: s.category ? String(s.category) : null,
      categoryName: categoryName.get(String(s.category)) || "Uncategorised",
      unit: s.unitOfMeasure?.shortCode || "", status: s.status,
      currentStock: Number(s.currentStock) || 0, reorderLevel: Number(s.reorderLevel) || 0,
      purchasePrice: Number(s.purchasePrice) || 0, vendorId: s.vendorId ? String(s.vendorId) : null,
    };
    byCode.set(s.itemId, meta);
    byId.set(meta.stockId, meta);
  }
  return { byCode, byId, categoryName };
}

// Movements outlive the item master: a deleted item keeps its history, and its value is still in
// the ledger, so it stays in the totals under a clear name.
const metaOf = (master, code) =>
  master.byCode.get(code) || {
    stockId: null, itemId: code, sku: "", itemName: `${code} (deleted item)`, categoryId: null, categoryName: "Uncategorised",
    unit: "", status: "Deleted", currentStock: null, reorderLevel: 0, purchasePrice: 0, vendorId: null, deleted: true,
  };

function itemFilter({ categoryId, search }) {
  const cat = categoryId ? String(objectId(categoryId, "categoryId")) : null;
  const needle = String(search || "").trim();
  const rx = needle ? new RegExp(escapeRegex(needle), "i") : null;
  return (m) => (!cat || m.categoryId === cat) && (!rx || rx.test(m.itemName) || rx.test(m.sku) || rx.test(m.itemId));
}

// ------------------------------------------------------------------ positions

const blank = () => ({ qty: 0, value: 0 });
const addTo = (target, qty, value) => { target.qty += qty; target.value += value; };

function emptyPosition(code) {
  return { stockId: code, open: blank(), flows: Object.fromEntries(BUCKETS.map((b) => [b, blank()])), seed: blank(), lastRate: null, close: blank() };
}

// Per item (keyed by Stock.itemId): opening (before `start`, plus any implicit opening), the
// period's movements by kind, and closing, everything up to the end of `end`. With no `start`
// the whole history is "period" and only the closing figure matters (valuation).
async function positions({ start = null, end }) {
  const [flows, rates, seeds] = await Promise.all([
    InventoryMovement.aggregate([
      { $match: { ...LIVE, date: { $lte: end } } },
      {
        $group: {
          _id: { stockId: "$stockId", bucket: BUCKET_EXPR, phase: start ? { $cond: [{ $lt: ["$date", start] }, "open", "period"] } : "period" },
          qty: { $sum: "$quantity" },
          value: { $sum: SIGNED_VALUE },
        },
      },
    ]),
    InventoryMovement.aggregate([
      { $match: { ...LIVE, rateAfter: { $ne: null }, date: { $lte: end } } },
      { $group: { _id: "$stockId", rate: { $top: { sortBy: { date: -1, createdAt: -1, _id: -1 }, output: "$rateAfter" } } } },
    ]),
    // The first movement ever written for the item (reversed or not): its previousStock is what
    // was on hand before any history existed.
    InventoryMovement.aggregate([
      { $group: { _id: "$stockId", first: { $top: { sortBy: { createdAt: 1, _id: 1 }, output: { prev: "$previousStock", rate: "$rateBefore", unit: "$unitCost" } } } } },
    ]),
  ]);

  const items = new Map();
  const at = (code) => {
    if (!items.has(code)) items.set(code, emptyPosition(code));
    return items.get(code);
  };
  const all = Object.fromEntries(BUCKETS.map((b) => [b, blank()]));
  const seedTotal = blank();

  for (const f of flows) {
    const p = at(f._id.stockId);
    if (f._id.phase === "open") addTo(p.open, f.qty, f.value);
    else addTo(p.flows[f._id.bucket], f.qty, f.value);
    addTo(all[f._id.bucket], f.qty, f.value);
  }
  for (const s of seeds) {
    const prev = Number(s.first?.prev) || 0;
    if (!prev) continue;
    const p = at(s._id);
    p.seed = { qty: prev, value: r2(prev * (Number(s.first.rate ?? s.first.unit) || 0)) };
    addTo(p.open, p.seed.qty, p.seed.value);
    addTo(seedTotal, p.seed.qty, p.seed.value);
  }
  for (const r of rates) if (items.has(r._id)) items.get(r._id).lastRate = r.rate;
  for (const p of items.values()) finalise(p);
  return { items, all, seedTotal, end };
}

function finalise(p) {
  p.open = { qty: r6(p.open.qty), value: r2(p.open.value) };
  for (const b of BUCKETS) p.flows[b] = { qty: r6(p.flows[b].qty), value: r2(p.flows[b].value) };
  p.close = {
    qty: r6(p.open.qty + BUCKETS.reduce((t, b) => t + p.flows[b].qty, 0)),
    value: r2(p.open.value + BUCKETS.reduce((t, b) => t + p.flows[b].value, 0)),
  };
  return p;
}

// The engine's own average (rateAfter of the last live movement, 5 dp) is what the app shows as the item's
// cost, so it is the one reported; value / qty stands in only for history that carries no rate.
const avgCostOf = (p) => (p.lastRate != null ? r5(p.lastRate) : p.close.qty > 0 ? r5(p.close.value / p.close.qty) : 0);
const totalStockValue = (pos) => r2([...pos.items.values()].reduce((t, p) => t + p.close.value, 0));
const isCurrent = (end) => end.getTime() >= Date.now();

// ------------------------------------------------------------------ reconciliation to the ledger

// What each stock source should have posted to the Inventory account, and where it does not.
const SOURCES = [
  { key: "opening", label: "Opening stock and manual adjustments", bucket: "adjustments", types: ["opening_stock", "stock_adjustment"], note: "Opening stock (Opening balances) and manual quantity changes are posted to the ledger. A difference here is a quantity typed on a new item, or a change made while ledger posting was off: enter a journal against the Inventory account to bring the ledger in line." },
  { key: "purchases", label: "Purchases", bucket: "purchases", types: ["purchase_order"] },
  { key: "purchaseReturns", label: "Purchase returns", bucket: "purchaseReturns", types: ["purchase_return"] },
  { key: "sales", label: "Cost of goods sold", bucket: "sales", types: ["sales_order"] },
  { key: "salesReturns", label: "Sales returns", bucket: "salesReturns", types: ["sales_return"] },
  { key: "writeOffs", label: "Stock write-offs", bucket: "writeOffs", types: ["stock_writeoff"] },
];

// The stock value against the Inventory account (config key inventory-asset) at the end of a day.
// Ledger balance = debits - credits of live entries dated up to that day. Every figure is an exact
// round2 total, and the difference is split by source so it can be explained, not just reported.
async function reconcile({ pos, stockValue }) {
  const postingEnabled = await AccountConfigService.isPostingEnabled();
  let accountId;
  try {
    accountId = await AccountConfigService.resolveAccount("inventory-asset");
  } catch (err) {
    if (err.code !== "ACCOUNT_NOT_CONFIGURED") throw err;
    return {
      available: false, postingEnabled, stockValue,
      reason: "The Inventory account is not mapped under Accounting > Account configuration, so stock cannot be compared with the ledger.",
    };
  }
  const [account, ledgerRows] = await Promise.all([
    LedgerAccount.findById(accountId).select("accountName accountCode").lean(),
    LedgerEntry.aggregate([
      { $match: { accountId: new mongoose.Types.ObjectId(String(accountId)), isReversed: { $ne: true }, date: { $lte: pos.end } } },
      { $group: { _id: "$voucherType", net: { $sum: { $subtract: ["$debitAmount", "$creditAmount"] } } } },
    ]),
  ]);
  const ledgerByType = new Map(ledgerRows.map((r) => [r._id, r.net]));
  const ledgerBalance = r2(ledgerRows.reduce((t, r) => t + r.net, 0));

  const lines = [];
  let assigned = 0;
  for (const s of SOURCES) {
    const stock = r2(pos.all[s.bucket].value + (s.key === "opening" ? pos.seedTotal.value : 0));
    const ledger = r2(s.types.reduce((t, type) => t + (ledgerByType.get(type) || 0), 0));
    assigned += ledger;
    lines.push({ key: s.key, label: s.label, stock, ledger, difference: r2(stock - ledger), ...(s.note ? { note: s.note } : {}) });
  }
  const manual = r2(ledgerBalance - assigned);
  lines.push({ key: "journals", label: "Journals and other vouchers posted to Inventory", stock: 0, ledger: manual, difference: r2(-manual), note: "Posted to the ledger by hand; no stock movement stands behind them." });

  const difference = r2(stockValue - ledgerBalance);
  return {
    available: true,
    account: { id: String(accountId), code: account?.accountCode || "", name: account?.accountName || "Inventory" },
    postingEnabled, asOn: orgToday(pos.end),
    stockValue, ledgerBalance, difference,
    reconciles: Math.abs(difference) < 0.005,
    lines: lines.filter((l) => l.stock || l.ledger),
    unexplained: r2(difference - lines.reduce((t, l) => t + l.difference, 0)),
    ...(postingEnabled ? {} : { warning: "Ledger posting is switched off, so approved documents are not reaching the Inventory account." }),
  };
}

// ------------------------------------------------------------------ the service

class StockReportsService {
  static EVENT_LABEL = EVENT_LABEL;

  // Items and categories for the report filters.
  static async lookups() {
    const master = await itemMaster();
    return {
      items: [...master.byCode.values()]
        .sort((a, b) => a.itemName.localeCompare(b.itemName))
        .map((m) => ({ id: m.stockId, code: m.itemId, name: m.itemName, sku: m.sku, unit: m.unit, categoryId: m.categoryId, status: m.status })),
      categories: [...master.categoryName.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  // ---------------------------------------------------------------- 1. Stock valuation

  // Quantity, average cost and value per item (or category) as on a date, with the ledger check.
  // The reconciliation always covers ALL items; a category / search filter only narrows the rows.
  static async valuation({ asOn, categoryId, search, groupBy = "item", includeZero = false } = {}) {
    if (!["item", "category"].includes(groupBy)) throw new AppError("groupBy must be item or category", 400, "INVALID_GROUP");
    const { end, to } = span({ to: asOn });
    const keep = itemFilter({ categoryId, search });
    const [master, pos] = await Promise.all([itemMaster(), positions({ end })]);

    // Today's quantity is also on the item master. Where the two disagree the history is
    // incomplete (stock written straight to the item without a movement), and the row says so.
    const current = isCurrent(end);
    if (current) for (const m of master.byCode.values()) if (Math.abs(m.currentStock) >= QTY_EPS && !pos.items.has(m.itemId)) pos.items.set(m.itemId, finalise(emptyPosition(m.itemId)));

    const rows = [];
    for (const p of pos.items.values()) {
      const meta = metaOf(master, p.stockId);
      if (!keep(meta)) continue;
      const { qty, value } = p.close;
      const outOfSync = current && meta.currentStock !== null && Math.abs(qty - meta.currentStock) >= QTY_EPS;
      if (!includeZero && qty === 0 && value === 0 && !outOfSync) continue;
      rows.push({
        stockId: meta.stockId, itemId: meta.itemId, sku: meta.sku, itemName: meta.itemName, unit: meta.unit,
        categoryId: meta.categoryId, categoryName: meta.categoryName,
        qty, avgCost: avgCostOf(p), value,
        ...(qty < 0 ? { negative: true } : {}),
        ...(outOfSync ? { outOfSync: true, recordedQty: meta.currentStock } : {}),
      });
    }
    rows.sort((a, b) => a.itemName.localeCompare(b.itemName));

    const value = r2(rows.reduce((t, r) => t + r.value, 0));
    const share = (v) => (value > 0 ? r2((v / value) * 100) : null);
    const totals = {
      items: rows.length, qty: r6(rows.reduce((t, r) => t + r.qty, 0)), value,
      negativeItems: rows.filter((r) => r.negative).length, outOfSyncItems: rows.filter((r) => r.outOfSync).length,
    };

    let out = rows.map((r) => ({ ...r, sharePct: share(r.value) }));
    if (groupBy === "category") {
      const groups = new Map();
      for (const r of rows) {
        const key = r.categoryId || "none";
        if (!groups.has(key)) groups.set(key, { categoryId: r.categoryId, categoryName: r.categoryName, items: 0, value: 0 });
        const g = groups.get(key);
        g.items += 1;
        g.value = r2(g.value + r.value);
      }
      out = [...groups.values()].map((g) => ({ ...g, sharePct: share(g.value) })).sort((a, b) => a.categoryName.localeCompare(b.categoryName));
    }

    const stockValue = totalStockValue(pos);
    const reconciliation = await reconcile({ pos, stockValue });
    return {
      asOn: to, groupBy, rows: out, totals,
      reconciliation: { ...reconciliation, filtered: Boolean(categoryId || String(search || "").trim()) },
    };
  }

  // ---------------------------------------------------------------- 2. Stock movement summary

  // Opening, what came in and went out by kind, and closing - for quantity and for value.
  //   closing = opening + purchases + salesReturns + adjustments - purchaseReturns - sales - writeOffs
  // `adjustments` is signed (opening-stock entries and manual corrections can go either way).
  static async movement({ from, to, categoryId, search, includeZero = false } = {}) {
    const w = span({ from, to, defaultFrom: monthStart() });
    const keep = itemFilter({ categoryId, search });
    const [master, pos] = await Promise.all([itemMaster(), positions({ start: w.start, end: w.end })]);

    const flowOf = (p, bucket) => {
      const f = p.flows[bucket];
      const sign = OUT_BUCKETS.has(bucket) ? -1 : 1; // out buckets are summed negative; show them as magnitudes
      return { qty: r6(f.qty * sign), value: r2(f.value * sign) };
    };
    const zero = (x) => x.qty === 0 && x.value === 0;
    const rows = [];
    for (const p of pos.items.values()) {
      const meta = metaOf(master, p.stockId);
      if (!keep(meta)) continue;
      const row = {
        stockId: meta.stockId, itemId: meta.itemId, sku: meta.sku, itemName: meta.itemName, unit: meta.unit,
        categoryId: meta.categoryId, categoryName: meta.categoryName,
        opening: p.open, ...Object.fromEntries(BUCKETS.map((b) => [b, flowOf(p, b)])), closing: p.close,
      };
      if (!includeZero && zero(row.opening) && zero(row.closing) && BUCKETS.every((b) => zero(row[b]))) continue;
      rows.push(row);
    }
    rows.sort((a, b) => a.itemName.localeCompare(b.itemName));

    const sum = (pick) => ({ qty: r6(rows.reduce((t, r) => t + pick(r).qty, 0)), value: r2(rows.reduce((t, r) => t + pick(r).value, 0)) });
    const totals = { opening: sum((r) => r.opening), ...Object.fromEntries(BUCKETS.map((b) => [b, sum((r) => r[b])])), closing: sum((r) => r.closing) };

    const reconciliation = await reconcile({ pos, stockValue: totalStockValue(pos) });
    return { from: w.from, to: w.to, rows, totals, reconciliation: { ...reconciliation, filtered: Boolean(categoryId || String(search || "").trim()) } };
  }

  // ---------------------------------------------------------------- 3. Item stock ledger

  static async itemLedger({ itemId, from, to } = {}) {
    if (!itemId) throw new AppError("itemId is required", 400, "ITEM_REQUIRED");
    let stock = isObjectIdText(itemId) ? await Stock.findById(itemId).populate("unitOfMeasure", "shortCode").populate("category", "name").lean() : null;
    if (!stock) stock = await Stock.findOne({ itemId: String(itemId) }).populate("unitOfMeasure", "shortCode").populate("category", "name").lean();
    const code = stock?.itemId || String(itemId);
    if (!stock && !(await InventoryMovement.exists({ stockId: code }))) throw new AppError("Stock item not found", 404, "ITEM_NOT_FOUND");

    const w = span({ from, to });
    const [moves, first] = await Promise.all([
      InventoryMovement.find({ stockId: code, ...LIVE, date: { $lte: w.end } }).sort({ date: 1, createdAt: 1, _id: 1 }).lean(),
      InventoryMovement.findOne({ stockId: code }).sort({ createdAt: 1, _id: 1 }).select("previousStock rateBefore unitCost").lean(),
    ]);

    const prev = Number(first?.previousStock) || 0;
    const implicit = prev ? { qty: prev, value: r2(prev * (Number(first.rateBefore ?? first.unitCost) || 0)) } : blank();
    let qty = implicit.qty;
    let value = implicit.value;
    let lastRate = null;
    const inPeriod = [];
    for (const m of moves) {
      if (m.rateAfter != null) lastRate = m.rateAfter;
      if (w.start && m.date < w.start) {
        qty += m.quantity;
        value += signedValue(m);
      } else inPeriod.push(m);
    }
    const opening = { qty: r6(qty), value: r2(value) };

    const detail = await StockReportsService.documentDetail(inPeriod.slice(0, MAX_LEDGER_ROWS), stock);
    const totals = { qtyIn: 0, qtyOut: 0, valueIn: 0, valueOut: 0 };
    const rows = [];
    for (const m of inPeriod) {
      const sv = signedValue(m);
      qty += m.quantity;
      value += sv;
      const incoming = m.quantity > 0;
      totals[incoming ? "qtyIn" : "qtyOut"] += Math.abs(m.quantity);
      totals[incoming ? "valueIn" : "valueOut"] += Math.abs(sv);
      if (rows.length < MAX_LEDGER_ROWS) {
        const d = detail.get(String(m._id)) || {};
        rows.push({
          id: String(m._id), date: m.date, documentNo: m.referenceNumber, eventType: m.eventType,
          typeLabel: EVENT_LABEL[m.eventType] || m.eventType, partyName: d.partyName || "", batchNo: d.batchNo || m.batchNumber || "",
          notes: m.notes || "",
          qtyIn: incoming ? r6(m.quantity) : 0, qtyOut: incoming ? 0 : r6(-m.quantity),
          unitCost: r5(m.unitCost != null && m.unitCost !== 0 ? m.unitCost : m.quantity ? Math.abs(Number(m.totalValue) || 0) / Math.abs(m.quantity) : 0),
          valueIn: incoming ? r2(Math.abs(sv)) : 0, valueOut: incoming ? 0 : r2(Math.abs(sv)),
          balanceQty: r6(qty), balanceValue: r2(value),
        });
      }
    }
    const closing = { qty: r6(qty), value: r2(value) };
    return {
      item: {
        id: stock ? String(stock._id) : null, itemId: code, sku: stock?.sku || "", itemName: stock?.itemName || `${code} (deleted item)`,
        unit: stock?.unitOfMeasure?.shortCode || "", categoryName: stock?.category?.name || "Uncategorised",
      },
      from: w.from, to: w.to, opening, rows,
      totals: { qtyIn: r6(totals.qtyIn), qtyOut: r6(totals.qtyOut), valueIn: r2(totals.valueIn), valueOut: r2(totals.valueOut) },
      closing: { ...closing, avgCost: closing.qty > 0 ? r5(closing.value / closing.qty) : r5(lastRate || 0) },
      truncated: inPeriod.length > MAX_LEDGER_ROWS,
    };
  }

  // Party name and batch numbers for ledger rows that come from a trade document.
  static async documentDetail(moves, stock) {
    const ids = [...new Set(moves.filter((m) => m.referenceType === "Transaction").map((m) => String(m.referenceId)))].map((id) => new mongoose.Types.ObjectId(id));
    const detail = new Map();
    if (!ids.length) return detail;
    const [txs, receipts] = await Promise.all([
      Transaction.find({ _id: { $in: ids } }).select("type partyId partyTypeRef items.itemId items.allocations items.batchNumber").lean(),
      stock ? StockBatch.find({ sourceTransactionId: { $in: ids }, stockId: stock._id }).select("sourceTransactionId batchNumber").lean() : [],
    ]);
    const customers = new Set(txs.filter((t) => t.partyTypeRef !== "Vendor").map((t) => String(t.partyId)));
    const vendors = new Set(txs.filter((t) => t.partyTypeRef === "Vendor").map((t) => String(t.partyId)));
    const [cs, vs] = await Promise.all([
      Customer.find({ _id: { $in: [...customers] } }).select("customerName").lean(),
      Vendor.find({ _id: { $in: [...vendors] } }).select("vendorName").lean(),
    ]);
    const names = new Map([...cs.map((c) => [String(c._id), c.customerName]), ...vs.map((v) => [String(v._id), v.vendorName])]);
    const txById = new Map(txs.map((t) => [String(t._id), t]));
    const received = new Map();
    for (const b of receipts) received.set(String(b.sourceTransactionId), [...(received.get(String(b.sourceTransactionId)) || []), b.batchNumber]);

    for (const m of moves) {
      const tx = txById.get(String(m.referenceId));
      if (!tx) continue;
      const lines = stock ? tx.items.filter((l) => String(l.itemId) === String(stock._id)) : [];
      const batches = new Set([...(received.get(String(tx._id)) || []), ...lines.flatMap((l) => (l.allocations || []).map((a) => a.batchNumber)), ...lines.map((l) => l.batchNumber)].filter(Boolean));
      detail.set(String(m._id), { partyName: names.get(String(tx.partyId)) || "", batchNo: [...batches].join(", ") });
    }
    return detail;
  }

  // ---------------------------------------------------------------- 4. Sales / purchase analysis

  // direction=sales:     quantity, net revenue (VAT excluded, returns subtracted), cost of goods sold
  //                      (the ACTUAL cogsAmount stamped on the movements), gross profit, margin, share.
  // direction=purchases: quantity, net purchase value (VAT excluded, returns subtracted), average
  //                      price paid, vendor count.
  // Revenue comes from approved document lines (lineTotal - vatAmount, the VAT-exclusive value after
  // line discounts). A header-level settlement discount is not allocated to items.
  static async salesAnalysis({ from, to, groupBy = "item", direction = "sales", categoryId, search } = {}) {
    if (!["sales", "purchases"].includes(direction)) throw new AppError("direction must be sales or purchases", 400, "INVALID_DIRECTION");
    const by = ["customer", "vendor", "party"].includes(groupBy) ? "party" : groupBy;
    if (!["item", "category", "party"].includes(by)) throw new AppError("groupBy must be item, category or customer", 400, "INVALID_GROUP");
    const w = span({ from, to, defaultFrom: monthStart() });
    const sales = direction === "sales";
    const types = sales ? ["sales_order", "sales_return"] : ["purchase_order", "purchase_return"];
    const keep = itemFilter({ categoryId, search });

    const [master, lines, costs] = await Promise.all([
      itemMaster(),
      Transaction.aggregate([
        { $match: { type: { $in: types }, status: { $in: APPROVED }, isOpening: { $ne: true }, date: { $gte: w.start || new Date(0), $lte: w.end } } },
        { $unwind: "$items" },
        {
          $group: {
            _id: { item: "$items.itemId", party: "$partyId", type: "$type" },
            qty: { $sum: "$items.qty" },
            net: { $sum: { $subtract: ["$items.lineTotal", { $ifNull: ["$items.vatAmount", 0] }] } },
            docs: { $addToSet: "$_id" },
          },
        },
      ]),
      sales
        ? InventoryMovement.aggregate([
            { $match: { ...LIVE, referenceType: "Transaction", eventType: { $in: ["SALES_DISPATCH", "SALES_RETURN"] }, date: { $gte: w.start || new Date(0), $lte: w.end } } },
            { $lookup: { from: "transactions", localField: "referenceId", foreignField: "_id", as: "tx", pipeline: [{ $match: { status: { $in: APPROVED } } }, { $project: { partyId: 1 } }] } },
            { $unwind: "$tx" },
            {
              $group: {
                _id: { code: "$stockId", party: "$tx.partyId", event: "$eventType" },
                cost: { $sum: { $abs: { $ifNull: [{ $cond: [{ $eq: ["$eventType", "SALES_DISPATCH"] }, { $ifNull: ["$cogsAmount", "$totalValue"] }, "$totalValue"] }, 0] } } },
              },
            },
          ])
        : [],
    ]);

    const groups = new Map();
    const allSuppliers = new Set();
    const group = (meta, party) => {
      const key = by === "item" ? meta.itemId : by === "category" ? meta.categoryId || "none" : String(party);
      if (!groups.has(key)) {
        groups.set(key, {
          key, name: by === "item" ? meta.itemName : by === "category" ? meta.categoryName : "", code: by === "item" ? meta.sku || meta.itemId : "",
          out: 0, back: 0, outValue: 0, backValue: 0, outCost: 0, backCost: 0, docs: new Set(), suppliers: new Set(), partyId: by === "party" ? String(party) : null,
        });
      }
      return groups.get(key);
    };

    for (const l of lines) {
      const meta = master.byId.get(String(l._id.item)) || { itemId: `deleted:${l._id.item}`, sku: "", itemName: "Deleted item", categoryId: null, categoryName: "Uncategorised" };
      if (!keep(meta)) continue;
      const g = group(meta, l._id.party);
      const isReturn = l._id.type === types[1];
      g[isReturn ? "back" : "out"] += l.qty;
      g[isReturn ? "backValue" : "outValue"] += l.net;
      l.docs.forEach((d) => g.docs.add(String(d)));
      if (!isReturn) {
        g.suppliers.add(String(l._id.party));
        allSuppliers.add(String(l._id.party));
      }
    }
    for (const c of costs) {
      const meta = metaOf(master, c._id.code);
      if (!keep(meta)) continue;
      group(meta, c._id.party)[c._id.event === "SALES_RETURN" ? "backCost" : "outCost"] += c.cost;
    }

    // names for party groups
    if (by === "party") {
      const ids = [...groups.values()].map((g) => g.partyId);
      const Party = sales ? Customer : Vendor;
      const field = sales ? "customerName" : "vendorName";
      const parties = await Party.find({ _id: { $in: ids } }).select(field).lean();
      const names = new Map(parties.map((p) => [String(p._id), p[field]]));
      for (const g of groups.values()) g.name = names.get(g.partyId) || "Unknown party";
    }

    const allDocs = new Set();
    let list = [...groups.values()].map((g) => {
      g.docs.forEach((d) => allDocs.add(d));
      const quantity = r6(g.out - g.back);
      const netValue = r2(g.outValue - g.backValue);
      const base = { key: g.key, name: g.name, code: g.code, quantity, documents: g.docs.size };
      if (!sales) {
        return {
          ...base, purchasedQty: r6(g.out), returnedQty: r6(g.back), purchased: r2(g.outValue), returned: r2(g.backValue), netValue,
          avgPrice: quantity > 0 ? r5(netValue / quantity) : null, vendors: by === "party" ? 1 : g.suppliers.size,
        };
      }
      const cogs = r2(g.outCost - g.backCost);
      const grossProfit = r2(netValue - cogs);
      return {
        ...base, soldQty: r6(g.out), returnedQty: r6(g.back), revenue: r2(g.outValue), returns: r2(g.backValue),
        netRevenue: netValue, cogs, grossProfit, marginPct: netValue > 0 ? r2((grossProfit / netValue) * 100) : null,
      };
    });
    const valueKey = sales ? "netRevenue" : "netValue";
    list.sort((a, b) => b[valueKey] - a[valueKey] || a.name.localeCompare(b.name));
    const sum = (k) => r2(list.reduce((t, r) => t + r[k], 0));
    const total = sum(valueKey);
    list = list.map((r) => ({ ...r, sharePct: total > 0 ? r2((r[valueKey] / total) * 100) : null }));

    const totals = sales
      ? (() => {
          const cogs = sum("cogs");
          const grossProfit = r2(total - cogs);
          return {
            quantity: r6(list.reduce((t, r) => t + r.quantity, 0)), revenue: sum("revenue"), returns: sum("returns"), netRevenue: total, cogs, grossProfit,
            marginPct: total > 0 ? r2((grossProfit / total) * 100) : null, documents: allDocs.size,
          };
        })()
      : {
          quantity: r6(list.reduce((t, r) => t + r.quantity, 0)), purchased: sum("purchased"), returned: sum("returned"), netValue: total,
          avgPrice: list.reduce((t, r) => t + r.quantity, 0) > 0 ? r5(total / list.reduce((t, r) => t + r.quantity, 0)) : null,
          vendors: allSuppliers.size, documents: allDocs.size,
        };
    return { from: w.from, to: w.to, groupBy: by === "party" ? (sales ? "customer" : "vendor") : by, direction, rows: list, totals };
  }

  // ---------------------------------------------------------------- 5. Batch expiry

  // Batches with stock on hand that expire within `withinDays` days or already have, in first-expiry-
  // first-out order. Value is quantity x the item's CURRENT average cost: batches are not cost layers
  // (see StockBatch), and a write-off leaves stock at that average, so this is what writing the
  // batch off would cost. The receipt cost is shown for information.
  static async expiry({ withinDays, categoryId, search, now = new Date() } = {}) {
    const days = wholeNumber(withinDays, 30, { min: 0, max: 3650, label: "withinDays" });
    const keep = itemFilter({ categoryId, search });
    const { companyId } = getTenant();
    const [master, batches] = await Promise.all([
      itemMaster(),
      StockBatch.find({ companyId, status: "active", qtyOnHand: { $gt: 0 }, expiryDate: { $ne: null, $lte: new Date(now.getTime() + days * DAY) } })
        .sort({ expiryDate: 1, receivedAt: 1, _id: 1 })
        .lean(),
    ]);

    const rank = new Map();
    const rows = [];
    for (const b of batches) {
      const meta = master.byId.get(String(b.stockId)) || { stockId: String(b.stockId), itemId: b.itemCode || "", sku: "", itemName: `${b.itemCode || "Unknown"} (deleted item)`, categoryId: null, categoryName: "Uncategorised", unit: "", purchasePrice: b.unitCost || 0 };
      if (!keep(meta)) continue;
      const unitCost = r5(meta.purchasePrice || b.unitCost || 0);
      const expiry = new Date(b.expiryDate);
      const n = (rank.get(meta.stockId) || 0) + 1;
      rank.set(meta.stockId, n);
      rows.push({
        batchId: String(b._id), batchNumber: b.batchNumber, stockId: meta.stockId, itemId: meta.itemId, sku: meta.sku, itemName: meta.itemName, unit: meta.unit,
        categoryName: meta.categoryName, qtyOnHand: r6(b.qtyOnHand), expiryDate: b.expiryDate, receivedAt: b.receivedAt, sourceTransactionNo: b.sourceTransactionNo || "",
        daysToExpiry: Math.ceil((expiry - now) / DAY) || 0, expired: expiry < now, fefoRank: n,
        unitCost, receiptCost: r5(b.unitCost || 0), valueAtCost: r2(b.qtyOnHand * unitCost),
      });
    }
    const part = (list) => ({ batches: list.length, qty: r6(list.reduce((t, r) => t + r.qtyOnHand, 0)), value: r2(list.reduce((t, r) => t + r.valueAtCost, 0)) });
    const expired = rows.filter((r) => r.expired);
    const expiring = rows.filter((r) => !r.expired);
    return {
      withinDays: days, asOn: orgToday(now), rows,
      totals: { ...part(rows), items: new Set(rows.map((r) => r.stockId)).size, expired: part(expired), expiring: part(expiring) },
    };
  }

  // ---------------------------------------------------------------- 6. Slow-moving and reorder

  // Items with stock on hand and no sale in the last `days` days, largest value first. An item that
  // has never sold is measured from its first receipt, so stock that arrived yesterday is not
  // called dead. Quantity and value come from the same positions as the valuation report.
  static async slowMoving({ days, categoryId, search, now = new Date() } = {}) {
    const n = wholeNumber(days, 90, { min: 1, max: 3650, label: "days" });
    const keep = itemFilter({ categoryId, search });
    const [master, pos, activity] = await Promise.all([
      itemMaster(),
      positions({ end: now }),
      InventoryMovement.aggregate([
        { $match: { ...LIVE, date: { $lte: now } } },
        {
          $group: {
            _id: "$stockId",
            lastSale: { $max: { $cond: [{ $eq: ["$eventType", "SALES_DISPATCH"] }, "$date", null] } },
            firstIn: { $min: { $cond: [{ $gt: ["$quantity", 0] }, "$date", null] } },
          },
        },
      ]),
    ]);
    const seen = new Map(activity.map((a) => [a._id, a]));
    const cutoff = now.getTime() - n * DAY;
    const stockValue = totalStockValue(pos);

    const rows = [];
    for (const p of pos.items.values()) {
      if (!(p.close.qty > 0)) continue;
      const meta = metaOf(master, p.stockId);
      if (!keep(meta)) continue;
      const a = seen.get(p.stockId) || {};
      const reference = a.lastSale || a.firstIn || null; // last sale, else first receipt
      if (reference && reference.getTime() >= cutoff) continue;
      rows.push({
        stockId: meta.stockId, itemId: meta.itemId, sku: meta.sku, itemName: meta.itemName, unit: meta.unit, categoryName: meta.categoryName,
        qty: p.close.qty, avgCost: avgCostOf(p), value: p.close.value,
        lastSaleDate: a.lastSale || null, neverSold: !a.lastSale, firstReceivedAt: a.firstIn || null,
        daysSince: reference ? Math.floor((now.getTime() - reference.getTime()) / DAY) : null,
      });
    }
    rows.sort((x, y) => y.value - x.value || x.itemName.localeCompare(y.itemName));
    const value = r2(rows.reduce((t, r) => t + r.value, 0));
    return {
      days: n, asOn: orgToday(now), rows,
      totals: { items: rows.length, value, neverSold: rows.filter((r) => r.neverSold).length, pctOfStockValue: stockValue > 0 ? r2((value / stockValue) * 100) : null, stockValue },
    };
  }

  // Active items whose quantity on the item master is at or below their reorder level (a level of
  // 0 means "not managed"). The item master quantity is used because it is what sales check against.
  static async reorder({ categoryId, search } = {}) {
    const keep = itemFilter({ categoryId, search });
    const master = await itemMaster();
    const vendorIds = [...new Set([...master.byCode.values()].map((m) => m.vendorId).filter(Boolean))];
    const vendors = await Vendor.find({ _id: { $in: vendorIds } }).select("vendorName").lean();
    const vendorName = new Map(vendors.map((v) => [String(v._id), v.vendorName]));

    const rows = [...master.byCode.values()]
      .filter((m) => m.status === "Active" && m.reorderLevel > 0 && m.currentStock <= m.reorderLevel && keep(m))
      .map((m) => {
        const shortfall = r6(m.reorderLevel - m.currentStock);
        return {
          stockId: m.stockId, itemId: m.itemId, sku: m.sku, itemName: m.itemName, unit: m.unit, categoryName: m.categoryName,
          qty: m.currentStock, reorderLevel: m.reorderLevel, shortfall, avgCost: r5(m.purchasePrice), shortfallValue: r2(shortfall * m.purchasePrice),
          status: m.currentStock <= 0 ? "out" : m.currentStock < m.reorderLevel ? "below" : "at", vendorName: vendorName.get(m.vendorId) || "",
        };
      })
      .sort((a, b) => a.qty / a.reorderLevel - b.qty / b.reorderLevel || a.itemName.localeCompare(b.itemName));
    return {
      rows,
      totals: { items: rows.length, outOfStock: rows.filter((r) => r.status === "out").length, shortfallValue: r2(rows.reduce((t, r) => t + r.shortfallValue, 0)) },
    };
  }
}

module.exports = StockReportsService;
