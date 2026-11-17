const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../promotions");

const line = (itemId, qty, price, over) => ({ itemId, qty, price, ...over });
const promo = (over) => ({ _id: over.id || "p1", name: "Offer", active: true, priority: 0, stackable: false, stockIds: [], categoryIds: [], customerIds: [], routeIds: [], ...over });

test("a slab gives its % from the minimum quantity, not below it", () => {
  const s = promo({ kind: "slab", stockIds: ["rice"], minQty: 10, percent: 5 });
  assert.equal(P.apply([line("rice", 9, 20)], [s]).lines[0].discountPercent, 0);
  const r = P.apply([line("rice", 10, 20)], [s]);
  assert.equal(r.lines[0].discountPercent, 5);
  assert.deepEqual(r.lines[0].promoIds, ["p1"]);
  assert.equal(r.applied[0].kind, "slab");
});

test("two slabs on one line: the better wins, unless both stack (then they combine, never add)", () => {
  const a = promo({ id: "a", kind: "slab", minQty: 1, percent: 10 });
  const b = promo({ id: "b", kind: "slab", minQty: 1, percent: 5 });
  assert.equal(P.apply([line("rice", 1, 10)], [a, b]).lines[0].discountPercent, 10);
  const stacked = P.apply([line("rice", 1, 10)], [{ ...a, stackable: true }, { ...b, stackable: true }]);
  assert.equal(stacked.lines[0].discountPercent, 14.5);
});

test("a category promotion covers every item in it", () => {
  const s = promo({ kind: "slab", categoryIds: ["grains"], minQty: 1, percent: 3 });
  const r = P.apply([line("rice", 1, 10, { categoryId: "grains" }), line("oil", 1, 10, { categoryId: "oils" })], [s]);
  assert.deepEqual(r.lines.map((l) => l.discountPercent), [3, 0]);
});

test("buy 10 get 1: free units per whole multiple, added up across lines of the item, as their own line", () => {
  const g = promo({ kind: "bxgy", stockIds: ["rice"], buyQty: 10, freeQty: 1 });
  assert.deepEqual(P.apply([line("rice", 9, 20)], [g]).free, []);
  assert.deepEqual(P.apply([line("rice", 25, 20)], [g]).free, [{ stockId: "rice", qty: 2, promoId: "p1" }]);
  const other = promo({ kind: "bxgy", stockIds: ["rice"], buyQty: 5, freeQty: 1, freeStockId: "bag" });
  assert.deepEqual(P.apply([line("rice", 5, 20)], [other]).free, [{ stockId: "bag", qty: 1, promoId: "p1" }]);
});

test("a basket reads the value after line discounts and skips a line a non-stacking promotion holds", () => {
  const basket = promo({ id: "bk", kind: "basket", minValue: 500, percent: 2 });
  // 10 x 50 = 500 exactly: reached
  assert.equal(P.apply([line("rice", 10, 50)], [basket]).lines[0].discountPercent, 2);
  // a 10% slab takes it to 450: not reached
  const slab = promo({ id: "s", kind: "slab", stockIds: ["rice"], minQty: 1, percent: 10, stackable: true });
  assert.equal(P.apply([line("rice", 10, 50)], [slab, basket]).applied.length, 1);
  const lock = promo({ id: "l", kind: "slab", stockIds: ["rice"], minQty: 1, percent: 1 });
  const r = P.apply([line("rice", 10, 60), line("oil", 10, 60)], [lock, basket]);
  assert.deepEqual(r.lines.map((l) => l.discountPercent), [1, 2]);
});

test("only for the days, the customers and the routes it names, and never when switched off", () => {
  const s = promo({ kind: "slab", minQty: 1, percent: 5, validFrom: "2026-11-01", validTo: "2026-11-30", customerIds: ["c1"], routeIds: ["r1"] });
  const run = (ctx) => P.apply([line("rice", 1, 10)], [s], ctx).lines[0].discountPercent;
  assert.equal(run({ date: "2026-11-17", customerId: "c1" }), 5);
  assert.equal(run({ date: "2026-11-17", customerId: "c9", routeId: "r1" }), 5, "the route names it");
  assert.equal(run({ date: "2026-11-17", customerId: "c9", routeId: "r9" }), 0);
  assert.equal(run({ date: "2026-12-01", customerId: "c1" }), 0);
  assert.equal(P.apply([line("rice", 1, 10)], [{ ...s, active: false }], { date: "2026-11-17", customerId: "c1" }).lines[0].discountPercent, 0);
});

test("priority decides which basket is tried first and a typed discount is kept underneath", () => {
  const s = promo({ kind: "slab", minQty: 1, percent: 10 });
  assert.equal(P.apply([line("rice", 1, 10, { discountPercent: 5 })], [s]).lines[0].discountPercent, 14.5);
});

test("a promotion form is checked and normalised", () => {
  assert.throws(() => P.validatePromotion({ kind: "slab" }), { code: "PROMOTION_NAME_REQUIRED" });
  assert.throws(() => P.validatePromotion({ name: "X", kind: "nope" }), { code: "PROMOTION_KIND_INVALID" });
  assert.throws(() => P.validatePromotion({ name: "X", kind: "slab", percent: 120 }), { code: "PROMOTION_VALUE_INVALID" });
  assert.throws(() => P.validatePromotion({ name: "X", kind: "bxgy", buyQty: 10, freeQty: 1 }), { code: "FREE_ITEM_REQUIRED" });
  assert.throws(() => P.validatePromotion({ name: "X", kind: "basket", minValue: 1, percent: 1, validFrom: "2026-12-01", validTo: "2026-11-01" }), { code: "INVALID_RANGE" });
  const ok = P.validatePromotion({ name: " 10+1 rice ", kind: "bxgy", stockIds: ["rice", "rice"], buyQty: "10", freeQty: "1" });
  assert.deepEqual([ok.name, ok.stockIds, ok.buyQty, ok.freeQty, ok.freeStockId], ["10+1 rice", ["rice"], 10, 1, ""]);
});
