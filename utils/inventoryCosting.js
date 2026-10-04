// Weighted-average costing engine. Pure functions, no I/O, no Mongoose, so it can be tested
// in isolation and survives a move to another database.
//
// A "pool" is the cost state of one item: { quantity, costValue, avgRate }.
//   - avgRate is the established weighted-average cost per unit. It is STICKY: an empty or
//     negative pool keeps the last good rate instead of publishing 0 (a full sale drives
//     quantity and value to 0, and 0/0 would erase the rate).
//   - A sale never changes avgRate. The selling price is not a parameter of anything here.
//
// Direction (stock up/down) and cost basis are separate axes:
//   purchase       -> in,  cost = documented purchase cost
//   purchaseReturn -> out, cost = documented purchase cost of the returned goods
//   sale           -> out, cost = quantity x avgRate (COGS)
//   salesReturn    -> in,  cost = the original sale's COGS rate, else the current avgRate

const RATE_DP = 5;
const VALUE_DP = 2;

// Half-up rounding with a tiny nudge so 1.005 -> 1.01 instead of 1.00 (binary float noise).
const roundTo = (n, dp) => {
  const f = 10 ** dp;
  const v = Number(n) || 0;
  return Math.sign(v) * (Math.round(Math.abs(v) * f + 1e-9) / f);
};
const roundRate = (n) => roundTo(n, RATE_DP);
const roundValue = (n) => roundTo(n, VALUE_DP);

const emptyPool = (avgRate = 0) => ({ quantity: 0, costValue: 0, avgRate: roundRate(avgRate) });

// Sticky: only publish a new average when the pool is positive in both quantity and value.
const recalcAvg = (quantity, costValue, previousAvg) =>
  quantity > 0 && costValue > 0 ? roundRate(costValue / quantity) : previousAvg;

function assertQty(qty) {
  if (!Number.isFinite(qty) || qty < 0) throw new RangeError(`Invalid quantity: ${qty}`);
}

function applyPurchase(pool, { qty, cost }) {
  assertQty(qty);
  const cost2 = roundValue(cost);
  // A sale that overdrew the pool was costed at the last average. When a later purchase
  // covers that shortfall, the difference is a true-up booked on THIS purchase's date, so
  // the earlier sale's period is never restated.
  let trueUp = 0;
  if (pool.quantity < 0 && qty > 0) {
    const covered = Math.min(qty, -pool.quantity);
    trueUp = roundValue(covered * (cost2 / qty) - covered * pool.avgRate);
  }
  const quantity = roundTo(pool.quantity + qty, 6);
  const costValue = roundValue(pool.costValue + cost2);
  return {
    pool: { quantity, costValue, avgRate: recalcAvg(quantity, costValue, pool.avgRate) },
    cost: cost2,
    rate: qty > 0 ? roundRate(cost2 / qty) : pool.avgRate,
    trueUp,
    costBasis: "purchase",
  };
}

function applyPurchaseReturn(pool, { qty, cost, rate }) {
  assertQty(qty);
  // Withdraw the ORIGINAL purchase cost: the document cost, else qty x rate, else qty x avg.
  const out = roundValue(cost ?? (rate != null ? qty * rate : qty * pool.avgRate));
  const quantity = roundTo(pool.quantity - qty, 6);
  // At zero quantity nothing may be left behind as value, or dust accumulates.
  const costValue = quantity === 0 ? 0 : roundValue(pool.costValue - out);
  return {
    pool: { quantity, costValue, avgRate: recalcAvg(quantity, costValue, pool.avgRate) },
    cost: out,
    rate: qty > 0 ? roundRate(out / qty) : pool.avgRate,
    costBasis: "purchaseReturn",
  };
}

// lockedCost: the cost already stamped on this sale. Used when replaying history so a sale in a
// closed period is never restated; the pool still moves by the sale's quantity.
function applySale(pool, { qty, lockedCost }) {
  assertQty(qty);
  const covered = Math.min(qty, Math.max(pool.quantity, 0));
  const short = qty - covered;
  // Emptying the pool takes the exact remainder so the 5-dp rate residue cannot be left
  // behind (or over-issued). Any quantity beyond the pool is costed at the last average.
  const coveredCost =
    covered > 0 && covered === pool.quantity ? pool.costValue : roundValue(covered * pool.avgRate);
  const shortCost = roundValue(short * pool.avgRate);
  const cogs = lockedCost != null ? roundValue(lockedCost) : roundValue(coveredCost + shortCost);
  const quantity = roundTo(pool.quantity - qty, 6);
  const costValue = roundValue(pool.costValue - cogs);
  return {
    // avgRate is carried forward verbatim: a sale never changes the established average.
    pool: { quantity, costValue, avgRate: pool.avgRate },
    cost: cogs,
    rate: qty > 0 ? roundRate(cogs / qty) : pool.avgRate,
    costBasis: "sale",
    short: short > 0 ? roundTo(short, 6) : 0,
  };
}

function applySalesReturn(pool, { qty, cogsRate, cogs }) {
  assertQty(qty);
  // Restore at what the goods originally cost us, never at the selling price.
  const back = roundValue(cogs ?? qty * (cogsRate ?? pool.avgRate));
  const quantity = roundTo(pool.quantity + qty, 6);
  const costValue = roundValue(pool.costValue + back);
  return {
    pool: { quantity, costValue, avgRate: recalcAvg(quantity, costValue, pool.avgRate) },
    cost: back,
    rate: qty > 0 ? roundRate(back / qty) : pool.avgRate,
    costBasis: "salesReturn",
  };
}

const APPLY = {
  purchase: applyPurchase,
  purchaseReturn: applyPurchaseReturn,
  sale: applySale,
  salesReturn: applySalesReturn,
};

// document type -> cost basis (the second axis, independent of direction)
const COST_BASIS_BY_TYPE = {
  purchase_order: "purchase",
  purchase_return: "purchaseReturn",
  sales_order: "sale",
  sales_return: "salesReturn",
};

function applyMovement(pool, costBasis, args) {
  const fn = APPLY[costBasis];
  if (!fn) throw new Error(`Unknown cost basis: ${costBasis}`);
  return fn(pool, args);
}

// Replay one item's movements, in order, from a seed pool. Returns the final pool and one
// result per movement (each carrying rateBefore/rateAfter for the audit trail).
function replayCostPool(movements, seed = emptyPool()) {
  let pool = seed;
  const results = movements.map((m) => {
    const before = pool;
    const r = applyMovement(pool, m.costBasis, m);
    pool = r.pool;
    return {
      ...r,
      rateBefore: before.avgRate,
      rateAfter: pool.avgRate,
      costPoolAfter: pool.costValue,
      poolQtyAfter: pool.quantity,
    };
  });
  return { pool, results };
}

module.exports = {
  RATE_DP,
  VALUE_DP,
  COST_BASIS_BY_TYPE,
  roundTo,
  roundRate,
  roundValue,
  emptyPool,
  recalcAvg,
  applyPurchase,
  applyPurchaseReturn,
  applySale,
  applySalesReturn,
  applyMovement,
  replayCostPool,
};
