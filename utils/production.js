// Pure rules of a production (no Mongoose): what a valid one looks like, what it costs, and the
// ledger lines it posts. The service (services/stock/productionService.js) does the reading and writing.
//
// A production makes `finished.qty` of one goods item from:
//   - materials: other goods items taken out of stock at their average cost;
//   - costs: amounts already paid to expense accounts (travelling, coating powder, packing ...),
//     moved into the item's cost.
// The finished item comes in at materials + costs, so a sale of it books that as its cost of goods.
const { roundValue, roundRate } = require("./inventoryCosting");

const EPS = 1e-9;
const num = (v) => (v === "" || v === null || v === undefined ? NaN : Number(v));
const idOf = (v) => (v && typeof v === "object" && v._id ? String(v._id) : v == null ? "" : String(v));
const round3 = (n) => Math.round(n * 1000) / 1000;

// Each problem as { field, code, message }; an empty list means the input can be saved.
function validate(input = {}) {
  const errors = [];
  const add = (field, code, message) => errors.push({ field, code, message });
  const finishedId = idOf(input.finished?.stockId);
  const finishedQty = num(input.finished?.qty);
  if (!finishedId) add("finished.stockId", "FINISHED_ITEM_REQUIRED", "Choose the item this production makes");
  if (!(finishedQty > 0)) add("finished.qty", "INVALID_QTY", "The quantity made must be more than zero");

  const materials = Array.isArray(input.materials) ? input.materials : [];
  const costs = Array.isArray(input.costs) ? input.costs : [];
  materials.forEach((m, i) => {
    if (!idOf(m?.stockId)) add(`materials.${i}.stockId`, "MATERIAL_ITEM_REQUIRED", `Line ${i + 1}: choose the material`);
    else if (idOf(m.stockId) === finishedId) add(`materials.${i}.stockId`, "MATERIAL_IS_FINISHED_ITEM", `Line ${i + 1}: an item cannot be used to make itself`);
    if (!(num(m?.qty) > 0)) add(`materials.${i}.qty`, "INVALID_QTY", `Line ${i + 1}: the quantity used must be more than zero`);
  });
  costs.forEach((c, i) => {
    if (!idOf(c?.accountId)) add(`costs.${i}.accountId`, "COST_ACCOUNT_REQUIRED", `Cost ${i + 1}: choose the expense account`);
    const amount = num(c?.amount);
    if (!(amount > 0)) add(`costs.${i}.amount`, "INVALID_AMOUNT", `Cost ${i + 1}: the amount must be more than zero`);
    else if (Math.abs(roundValue(amount) - amount) > EPS) add(`costs.${i}.amount`, "INVALID_AMOUNT", `Cost ${i + 1}: use at most two decimals`);
  });
  if (!materials.length && !costs.length) add("materials", "NOTHING_TO_PRODUCE", "Add at least one material or one cost");
  return errors;
}

// The same item twice is one line; two costs to one account stay apart (each has its own narration).
function mergeMaterials(materials = []) {
  const byId = new Map();
  for (const m of materials) {
    const key = idOf(m.stockId);
    const prev = byId.get(key);
    if (prev) prev.qty = round3(prev.qty + Number(m.qty));
    else byId.set(key, { ...m, stockId: key, qty: round3(Number(m.qty)) });
  }
  return [...byId.values()];
}

// materialCosts: the cost each material left at (posting) or would leave at today (preview).
function totals({ materialCosts = [], costs = [], qty }) {
  const materials = roundValue(materialCosts.reduce((s, c) => s + (Number(c) || 0), 0));
  const costTotal = roundValue(costs.reduce((s, c) => s + (Number(c.amount) || 0), 0));
  const total = roundValue(materials + costTotal);
  const q = Number(qty);
  return { materials, costs: costTotal, total, unitCost: q > 0 ? roundRate(total / q) : 0 };
}

// The ledger lines of a posted production, balanced:
//   Dr Inventory              total        (the finished item in)
//   Cr Inventory              materials    (the materials out)
//   Cr costs-moved-to-stock   each cost    (one line per cost, narrated with the expense it came from)
// The expense accounts themselves are not touched: each keeps what was spent on it, and the P&L shows the
// amount moved into stock as a line of its own. A cost may name its own `contraAccountId` (the contra in the
// expense's own group, so the credit sits beside the expense in the P&L); else it goes to `absorbedAccountId`.
function ledgerLines({ inventoryAccountId, absorbedAccountId, materialsCost, costs = [], productionNo, itemName, qty }) {
  const made = `${productionNo}: ${itemName} x ${qty}`;
  const lines = [];
  const total = roundValue((Number(materialsCost) || 0) + costs.reduce((s, c) => s + (Number(c.amount) || 0), 0));
  if (total > 0) lines.push({ accountId: inventoryAccountId, debit: total, credit: 0, narration: `Made in production ${made}` });
  if (roundValue(materialsCost) > 0) {
    lines.push({ accountId: inventoryAccountId, debit: 0, credit: roundValue(materialsCost), narration: `Materials used in production ${made}` });
  }
  for (const c of costs) {
    const amount = roundValue(c.amount);
    if (!(amount > 0)) continue;
    const from = c.accountName ? `${c.accountName}` : "expense";
    lines.push({
      accountId: c.contraAccountId || absorbedAccountId, debit: 0, credit: amount,
      narration: `${from} moved to stock: production ${made}${c.narration ? ` - ${c.narration}` : ""}`,
    });
  }
  const dr = roundValue(lines.reduce((s, l) => s + l.debit, 0));
  const cr = roundValue(lines.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(dr - cr) >= 0.005) throw new Error(`Production lines do not balance: ${dr} / ${cr}`);
  return lines;
}

// The cost report: posted productions grouped by the item they made.
function costReport(productions = []) {
  const byItem = new Map();
  for (const p of productions) {
    if (p.status !== "POSTED") continue;
    const key = idOf(p.finished?.stockId);
    let row = byItem.get(key);
    if (!row) {
      row = {
        stockId: key, itemId: p.finished?.itemId, itemName: p.finished?.itemName,
        qty: 0, materials: 0, costs: 0, total: 0, unitCost: 0, count: 0,
        materialLines: new Map(), costLines: new Map(), productions: [],
      };
      byItem.set(key, row);
    }
    row.count += 1;
    row.qty = round3(row.qty + Number(p.finished?.qty || 0));
    row.materials = roundValue(row.materials + Number(p.totals?.materials || 0));
    row.costs = roundValue(row.costs + Number(p.totals?.costs || 0));
    row.total = roundValue(row.total + Number(p.totals?.total || 0));
    for (const m of p.materials || []) {
      const k = idOf(m.stockId);
      const line = row.materialLines.get(k) || { stockId: k, itemId: m.itemId, itemName: m.itemName, qty: 0, cost: 0 };
      line.qty = round3(line.qty + Number(m.qty || 0));
      line.cost = roundValue(line.cost + Number(m.cost || 0));
      row.materialLines.set(k, line);
    }
    for (const c of p.costs || []) {
      const k = idOf(c.accountId);
      const line = row.costLines.get(k) || { accountId: k, accountCode: c.accountCode, accountName: c.accountName, amount: 0 };
      line.amount = roundValue(line.amount + Number(c.amount || 0));
      row.costLines.set(k, line);
    }
    row.productions.push({
      _id: p._id, productionNo: p.productionNo, date: p.date, qty: p.finished?.qty,
      total: p.totals?.total, unitCost: p.totals?.unitCost,
    });
  }
  const items = [...byItem.values()]
    .map((r) => ({
      ...r,
      unitCost: r.qty > 0 ? roundRate(r.total / r.qty) : 0,
      materialLines: [...r.materialLines.values()].sort((a, b) => b.cost - a.cost),
      costLines: [...r.costLines.values()].sort((a, b) => b.amount - a.amount),
    }))
    .sort((a, b) => String(a.itemName || "").localeCompare(String(b.itemName || "")));
  const grand = items.reduce(
    (s, r) => ({ materials: roundValue(s.materials + r.materials), costs: roundValue(s.costs + r.costs), total: roundValue(s.total + r.total) }),
    { materials: 0, costs: 0, total: 0 }
  );
  return { items, totals: grand };
}

module.exports = { validate, mergeMaterials, totals, ledgerLines, costReport };
