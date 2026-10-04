const test = require("node:test");
const assert = require("node:assert/strict");
const {
  emptyPool,
  applyPurchase,
  applySale,
  applyPurchaseReturn,
  applySalesReturn,
  replayCostPool,
} = require("../inventoryCosting");

test("regression: 100 @ 10 then 50 @ 12 averages 10.66667 (old code gave 6.75)", () => {
  let pool = emptyPool();
  pool = applyPurchase(pool, { qty: 100, cost: 1000 }).pool;
  pool = applyPurchase(pool, { qty: 50, cost: 600 }).pool;
  assert.equal(pool.quantity, 150);
  assert.equal(pool.costValue, 1600);
  assert.equal(pool.avgRate, 10.66667);
});

test("a sale never changes the average", () => {
  let pool = applyPurchase(emptyPool(), { qty: 100, cost: 1000 }).pool;
  const sale = applySale(pool, { qty: 40 });
  assert.equal(sale.pool.avgRate, pool.avgRate);
  assert.equal(sale.cost, 400);
  assert.equal(sale.pool.quantity, 60);
});

test("sticky rate: emptying the pool keeps the last good average", () => {
  let pool = applyPurchase(emptyPool(), { qty: 10, cost: 55 }).pool;
  pool = applySale(pool, { qty: 10 }).pool;
  assert.equal(pool.quantity, 0);
  assert.equal(pool.costValue, 0);
  assert.equal(pool.avgRate, 5.5);
});

test("worked example: sum of COGS equals total purchase cost exactly", () => {
  // A worked example with large quantities, to catch rounding residue.
  const movements = [
    { costBasis: "purchase", qty: 36000, cost: 18769833.0 },
    { costBasis: "purchase", qty: 37000, cost: 19762200.24 },
    ...[5000, 5000, 20000, 5000, 1000, 10000, 10000, 17000].map((qty) => ({
      costBasis: "sale",
      qty,
    })),
  ];
  const { pool, results } = replayCostPool(movements);
  assert.equal(results[1].rateAfter, 527.83607);
  assert.equal(results[2].cost, 2639180.35); // 5,000 x 527.83607
  assert.equal(results[4].cost, 10556721.4); // 20,000 x 527.83607
  const cogs = results.filter((r) => r.costBasis === "sale").reduce((s, r) => s + r.cost, 0);
  assert.equal(Math.round(cogs * 100) / 100, 38532033.24);
  // The invariant: purchases - COGS === pool value, to the cent.
  assert.equal(pool.quantity, 0);
  assert.equal(pool.costValue, 0);
});

test("overselling costs the shortfall at the last average and leaves a negative pool", () => {
  let pool = applyPurchase(emptyPool(), { qty: 10, cost: 100 }).pool;
  const sale = applySale(pool, { qty: 15 });
  assert.equal(sale.short, 5);
  assert.equal(sale.cost, 150);
  assert.equal(sale.pool.quantity, -5);
});

test("a later purchase that covers a short sale books a true-up", () => {
  let pool = applyPurchase(emptyPool(), { qty: 10, cost: 100 }).pool; // avg 10
  pool = applySale(pool, { qty: 15 }).pool; // 5 short, provisionally 10 each
  const buy = applyPurchase(pool, { qty: 20, cost: 240 }); // real cost 12 each
  assert.equal(buy.trueUp, 10); // 5 x (12 - 10)
});

test("purchase return withdraws the original cost; zero quantity leaves no dust", () => {
  let pool = applyPurchase(emptyPool(), { qty: 3, cost: 10 }).pool; // avg 3.33333
  const r = applyPurchaseReturn(pool, { qty: 3, cost: 10 });
  assert.equal(r.pool.quantity, 0);
  assert.equal(r.pool.costValue, 0);
});

test("sales return restores at the original COGS rate, not the current average", () => {
  let pool = applyPurchase(emptyPool(), { qty: 10, cost: 100 }).pool;
  pool = applyPurchase(pool, { qty: 10, cost: 200 }).pool; // avg 15
  const r = applySalesReturn(pool, { qty: 2, cogsRate: 10 });
  assert.equal(r.cost, 20);
  assert.equal(r.costBasis, "salesReturn");
});

test("every replayed movement records rate before and after", () => {
  const { results } = replayCostPool([
    { costBasis: "purchase", qty: 10, cost: 100 },
    { costBasis: "purchase", qty: 10, cost: 200 },
  ]);
  assert.equal(results[0].rateBefore, 0);
  assert.equal(results[0].rateAfter, 10);
  assert.equal(results[1].rateBefore, 10);
  assert.equal(results[1].rateAfter, 15);
});

test("a locked sale keeps its stamped cost while quantity still leaves the pool", () => {
  const pool = applyPurchase(emptyPool(), { qty: 100, cost: 1200 }).pool; // avg 12
  const sale = applySale(pool, { qty: 10, lockedCost: 100 }); // stamped at 10/unit in a closed period
  assert.equal(sale.cost, 100);
  assert.equal(sale.pool.quantity, 90);
  assert.equal(sale.pool.costValue, 1100);
  assert.equal(sale.pool.avgRate, 12);
});
