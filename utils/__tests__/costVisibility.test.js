const test = require("node:test");
const assert = require("node:assert/strict");
const { COST_KEYS, MOVEMENT_COST_KEYS, SEE_COST, mayViewCost, withoutKeys } = require("../costVisibility");

test("only a caller whose grants hold inventory.viewCost may see cost", () => {
  assert.equal(SEE_COST, "inventory.viewCost");
  assert.equal(mayViewCost({ grants: ["sales.view", "inventory.viewCost"] }), true);
  assert.equal(mayViewCost({ grants: new Set(["inventory.viewCost"]) }), true);
  assert.equal(mayViewCost({ grants: ["inventory.view", "sales.view"] }), false);
  assert.equal(mayViewCost({ grants: [] }), false);
  assert.equal(mayViewCost({}), false);
  assert.equal(mayViewCost(null), false);
  assert.equal(mayViewCost({ grants: "inventory.viewCost" }), false, "a string is not a list of grants");
});

test("every cost key is removed at any depth, and nothing else is", () => {
  const planted = Object.fromEntries(COST_KEYS.map((k) => [k, "LEAK"]));
  const body = {
    data: { rows: [{ name: "Widget", salesPrice: 60, stockDetails: { ...planted, sku: "X" } }], total: 1, ...planted },
    when: new Date("2026-11-18T00:00:00Z"),
    nothing: null,
  };
  const out = withoutKeys(body, COST_KEYS);
  assert.ok(!JSON.stringify(out).includes("LEAK"));
  assert.equal(out.data.rows[0].salesPrice, 60);
  assert.equal(out.data.rows[0].stockDetails.sku, "X");
  assert.equal(out.data.total, 1);
  assert.ok(out.when instanceof Date, "a date is kept as a date");
  assert.equal(out.nothing, null);
  assert.ok("purchasePrice" in body.data, "the original is not changed");
});

test("totalValue is cost on a movement only, so it is removed only where the router says so", () => {
  const row = { totalValue: 400, salesPrice: 1 };
  assert.deepEqual(withoutKeys(row, COST_KEYS), row);
  assert.deepEqual(withoutKeys(row, MOVEMENT_COST_KEYS), { salesPrice: 1 });
});

test("the cost keys are exactly the ones the stock and movement models use for cost", () => {
  for (const k of ["purchasePrice", "costValue", "unitCost", "cogsAmount", "rateBefore", "rateAfter", "costPoolAfter", "currentPurchasePrice"]) assert.ok(COST_KEYS.includes(k), k);
  for (const k of ["salesPrice", "price", "rate", "lineTotal", "totalAmount", "vatAmount"]) assert.ok(!MOVEMENT_COST_KEYS.includes(k), `${k} is not a cost`);
});
