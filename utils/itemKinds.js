// Goods and services: the rules that need no database.
//
// A service item (consulting, delivery, installation, a monthly subscription) is a Stock document with
// itemType "service". It lives in the same collection as goods so Transaction.items.itemId and every item
// picker keep working, but it has no quantity on hand, no reorder level, no batches, no costing and no
// movements. A missing itemType reads as goods, so every item that existed before services needs no migration.
//
// THE ONE QUESTION every consumer asks is "is this line stocked?". Ask it here (isStocked / isService),
// never with an inline comparison, so there is one place to read when the rule changes:
//   - stock movement, batches, costing, COGS and the Inventory ledger leg  -> only for stocked lines
//   - delivery-note availability, pick lists, reorder, valuation, expiry    -> only for stocked lines
//   - revenue, VAT and the receivable                                       -> every line
//
// Pure: no Mongoose, no I/O.

const SERVICE = "service";
const GOODS = "goods";
const ITEM_TYPES = Object.freeze([GOODS, SERVICE]);

// A missing or unknown value is goods: that is what every item was before this field existed.
const itemTypeOf = (item) => (item && item.itemType === SERVICE ? SERVICE : GOODS);
const isService = (item) => itemTypeOf(item) === SERVICE;
const isStocked = (item) => !isService(item);

// Mongo filter that keeps services out of any stock figure (quantity, value, reorder, low stock).
// Spread it into a $match / find filter: { ...STOCKED_ONLY, status: "Active" }.
const STOCKED_ONLY = Object.freeze({ itemType: { $ne: SERVICE } });

// The type a request asked for, or null when it is not one we know. undefined/""/null mean "not given".
function parseItemType(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const v = String(value).trim().toLowerCase();
  return ITEM_TYPES.includes(v) ? v : null;
}

// The Stock fields a service cannot have. Zero / blank is fine (a form sends them); anything real is a mistake
// worth telling the person about rather than silently dropping.
const STOCK_ONLY_FIELDS = Object.freeze(["currentStock", "reorderLevel", "batchNumber", "expiryDate", "barcodeQrCode"]);

function stockFieldsOnService(input = {}) {
  return STOCK_ONLY_FIELDS.filter((k) => {
    const v = input[k];
    if (v === undefined || v === null || v === "") return false;
    if (k === "currentStock" || k === "reorderLevel") return Number(v) !== 0;
    return String(v).trim() !== "";
  });
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// How a document's service lines are posted, line by line, without touching the posting templates.
//   lines:  the document's items
//   kindOf: (line) => { service: boolean, incomeAccountId?, expenseAccountId? }   (looked up from the item)
// Returns the service lines' VAT-exclusive value (`net`, after line discounts: what a purchase books as
// the cost) and their gross (`gross`, before discounts: what a sale books as revenue), each split by the
// account the item names, or by null for "the company default".
function servicePlan(lines, kindOf) {
  const byAccount = { revenue: new Map(), expense: new Map() };
  let net = 0;
  let gross = 0;
  for (const line of lines || []) {
    const kind = kindOf(line);
    if (!kind || !kind.service) continue;
    const lineNet = Number(line.taxableAmount) || 0;
    const lineGross = Number(line.grossAmount) || 0;
    net += lineNet;
    gross += lineGross;
    const income = kind.incomeAccountId ? String(kind.incomeAccountId) : null;
    const expense = kind.expenseAccountId ? String(kind.expenseAccountId) : null;
    byAccount.revenue.set(income, round2((byAccount.revenue.get(income) || 0) + lineGross));
    byAccount.expense.set(expense, round2((byAccount.expense.get(expense) || 0) + lineNet));
  }
  return {
    net: round2(net),
    gross: round2(gross),
    hasServices: net > 0 || gross > 0,
    revenue: [...byAccount.revenue].map(([accountId, amount]) => ({ accountId, amount })),
    expense: [...byAccount.expense].map(([accountId, amount]) => ({ accountId, amount })),
  };
}

// Whether a purchase document needs the company's default service-expense account (some service line
// names no account of its own). Lets the caller resolve that posting key only when it is used.
const needsDefaultExpense = (plan) => plan.expense.some((g) => g.accountId === null && g.amount > 0);

// Moves the service lines' share of a document's entries onto the accounts services use.
//   entries: buildEntries() output; each carries `figure`, the figure that produced it
//   type:    the document type
//   plan:    servicePlan()
//   defaultExpenseAccountId: the resolved "service-expense" account (needed when needsDefaultExpense(plan))
//
//   sale / sales return   revenue is posted gross to "sales-revenue" (figure "gross"). A service whose item names
//                         an income account has its gross moved there; the rest stays on sales-revenue, which is
//                         the default for a service too.
//   purchase / return     stock goes to Inventory at the net of the lines (figure "netLines"). The service lines'
//                         net comes OFF that leg and goes to the item's expense account, else the default
//                         service-expense account, on the same side. No inventory leg exists for a service.
// The debit and credit totals do not change, so the document still balances; it is checked again anyway.
function routeServiceLegs(entries, type, plan, { defaultExpenseAccountId } = {}) {
  if (!plan || !plan.hasServices) return entries;
  const isSale = type === "sales_order" || type === "sales_return";
  const isPurchase = type === "purchase_order" || type === "purchase_return";
  if (!isSale && !isPurchase) return entries;

  const figure = isSale ? "gross" : "netLines";
  const source = entries.find((e) => e.figure === figure);
  if (!source) return entries;
  const side = source.debitAmount > 0 ? "debitAmount" : "creditAmount";

  // what moves off the source leg, and onto which account
  const moves = [];
  if (isSale) {
    for (const g of plan.revenue) if (g.accountId && g.amount > 0) moves.push(g);
  } else {
    for (const g of plan.expense) {
      if (!(g.amount > 0)) continue;
      const accountId = g.accountId || defaultExpenseAccountId;
      if (!accountId) {
        const err = new Error("A service line needs the service-expense account and none was resolved");
        err.code = "ACCOUNT_NOT_CONFIGURED";
        throw err;
      }
      moves.push({ accountId, amount: g.amount });
    }
  }

  let room = source[side];
  const extra = [];
  for (const m of moves) {
    const amount = round2(Math.min(m.amount, room)); // never more than the leg holds (rounding)
    if (!(amount > 0)) continue;
    room = round2(room - amount);
    extra.push({
      accountId: m.accountId,
      debitAmount: side === "debitAmount" ? amount : 0,
      creditAmount: side === "creditAmount" ? amount : 0,
      figure: isSale ? "serviceRevenue" : "serviceExpense",
    });
  }
  if (!extra.length) return entries;

  const out = entries
    .map((e) => (e === source ? { ...e, [side]: room } : e))
    .filter((e) => e.debitAmount > 0 || e.creditAmount > 0);
  out.push(...extra);

  const debit = round2(out.reduce((t, e) => t + e.debitAmount, 0));
  const credit = round2(out.reduce((t, e) => t + e.creditAmount, 0));
  if (Math.abs(debit - credit) > 0.01) {
    const err = new Error(`Unbalanced posting for ${type} after routing service lines: debit ${debit} vs credit ${credit}`);
    err.code = "UNBALANCED_POSTING";
    throw err;
  }
  return out;
}

module.exports = {
  SERVICE, GOODS, ITEM_TYPES, STOCKED_ONLY, STOCK_ONLY_FIELDS,
  itemTypeOf, isService, isStocked, parseItemType, stockFieldsOnService,
  servicePlan, needsDefaultExpense, routeServiceLegs,
};
