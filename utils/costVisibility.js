// What an item COSTS the business is not for everyone who may look at stock, an order or a list. A salesperson who can see an item and its
// selling price must not be able to read the margin from the same row. The permission is `inventory.viewCost` (utils/permissions.js:
// Owner, Administrator, Manager, Accountant and Purchase officer hold it). Pure: no database, no request.
//
// The filter works on the RESPONSE, by field name, at the routers that carry cost: it removes these keys wherever they appear in the JSON.
// That is deliberately blunt: a field added to a cost-carrying model later is still visible until its name is added here, which is why the list
// is an allow-nothing-new set in the tests (utils/__tests__/costVisibility.test.js plants every key and checks it goes).

// A stock item's cost, a document line's snapshot of it, the cost each movement carried, and the totals built from them.
const COST_KEYS = Object.freeze([
  "purchasePrice", // the item's average unit cost
  "costValue", // total cost on hand
  "currentPurchasePrice", // the cost snapshot on a document line
  "unitCost", "rateBefore", "rateAfter", "costPoolAfter", "cogsAmount", // a stock movement's costing
  "totalStockValue", "valueAtCost", "receiptCost", "avgCost", // totals and report columns
]);

// On a movement `totalValue` is a COST (quantity x unit cost); elsewhere the name means other things, so it is added only for the routers where it is cost.
const MOVEMENT_COST_KEYS = Object.freeze([...COST_KEYS, "totalValue"]);

const SEE_COST = "inventory.viewCost";

// grants: the caller's permission keys (an array or a Set). Anything unreadable is "may not".
function mayViewCost(admin) {
  const g = admin?.grants;
  if (!g) return false;
  return Array.isArray(g) ? g.includes(SEE_COST) : typeof g.has === "function" ? g.has(SEE_COST) : false;
}

// A copy of `value` without the keys, at any depth. Dates and other non-plain values are kept as they are.
function withoutKeys(value, keys) {
  const drop = keys instanceof Set ? keys : new Set(keys);
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      const out = {};
      for (const [k, x] of Object.entries(v)) if (!drop.has(k)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value);
}

module.exports = { SEE_COST, COST_KEYS, MOVEMENT_COST_KEYS, mayViewCost, withoutKeys };
