const test = require("node:test");
const assert = require("node:assert/strict");
const v = require("../vanSales");

const trip = (status, loads) => ({ status, loads: loads.map((lines, i) => ({ no: i + 1, lines })) });
const M = (obj) => new Map(Object.entries(obj));
const asObj = (m) => Object.fromEntries(m);

test("what is loaded is every load and top-up added together", () => {
  const t = trip("ON_ROUTE", [[{ stockId: "a", qty: 10 }, { stockId: "b", qty: 5 }], [{ stockId: "a", qty: 4 }]]);
  assert.deepEqual(asObj(v.loadedOf(t)), { a: 14, b: 5 });
});

test("sellable is loaded - sold + good returns; physical adds the damaged ones; damaged is only the damaged", () => {
  const out = v.onVan({
    status: "ON_ROUTE",
    loaded: M({ a: 20, b: 6 }),
    sold: M({ a: 8 }),
    returned: { good: M({ a: 2 }), damaged: M({ a: 1, b: 1 }) },
  });
  assert.deepEqual(asObj(out.sellable), { a: 14, b: 6 });
  assert.deepEqual(asObj(out.damaged), { a: 1, b: 1 });
  assert.deepEqual(asObj(out.physical), { a: 15, b: 7 });
});

test("a trip that is not out holds nothing: the goods are back at the depot or never left it", () => {
  for (const status of ["UNLOADED", "SETTLED", "CANCELLED"]) {
    const out = v.onVan({ status, loaded: M({ a: 5 }) });
    assert.equal(out.sellable.size + out.physical.size + out.damaged.size, 0, status);
  }
  // LOADING does hold what is loaded (the van is being filled), though it cannot sell yet
  assert.deepEqual(asObj(v.onVan({ status: "LOADING", loaded: M({ a: 5 }) }).physical), { a: 5 });
  assert.equal(v.SELLING.has("LOADING"), false);
  assert.equal(v.SELLING.has("ON_ROUTE"), true);
});

test("only goods lines count as sold, and a return line with no condition is good", () => {
  const sold = v.soldOf([{ items: [{ itemId: "a", qty: 3 }, { itemId: "svc", qty: 1, itemType: "service" }] }, { items: [{ itemId: "a", qty: 2 }] }]);
  assert.deepEqual(asObj(sold), { a: 5 });
  const r = v.returnedOf([{ items: [{ itemId: "a", qty: 1 }, { itemId: "a", qty: 2, returnCondition: "damaged" }] }]);
  assert.deepEqual(asObj(r.good), { a: 1 });
  assert.deepEqual(asObj(r.damaged), { a: 2 });
});

test("several vans add together, and free depot stock leaves job workers and vans alone and never goes below zero", () => {
  const all = v.onVansAll([{ physical: M({ a: 5 }) }, { physical: M({ a: 3, b: 1 }) }]);
  assert.deepEqual(asObj(all), { a: 8, b: 1 });
  assert.equal(v.freeDepot({ currentStock: 100, withJobWorker: 10, onVans: 30 }), 60);
  assert.equal(v.freeDepot({ currentStock: 10, withJobWorker: 8, onVans: 8 }), 0);
});

test("a load is checked line by line and duplicates are merged", () => {
  assert.throws(() => v.validateLoadLines([]), (e) => e.code === "LOAD_EMPTY");
  assert.throws(() => v.validateLoadLines([{ stockId: "a", qty: 0 }]), (e) => e.code === "QTY_INVALID");
  assert.throws(() => v.validateLoadLines([{ qty: 1 }]), (e) => e.code === "ITEM_REQUIRED");
  const merged = v.validateLoadLines([{ stockId: "a", qty: 2, itemName: "Rice" }, { stockId: "a", qty: 3 }, { stockId: "b", qty: 1 }]);
  assert.deepEqual(merged.map((l) => [l.stockId, l.qty, l.itemName]), [["a", 5, "Rice"], ["b", 1, ""]]);
});

test("a sale larger than what is on the van is a shortage, summed across lines of one item", () => {
  const have = M({ a: 5 });
  assert.deepEqual(v.shortages([{ itemId: "a", qty: 5 }], have), []);
  assert.deepEqual(v.shortages([{ itemId: "a", qty: 3 }, { itemId: "a", qty: 3 }], have), [{ stockId: "a", wanted: 6, available: 5 }]);
  assert.deepEqual(v.shortages([{ itemId: "z", qty: 1 }], have), [{ stockId: "z", wanted: 1, available: 0 }]);
});

test("the count at unload: found less than should be there is a negative difference, damaged counts as a unit", () => {
  const shelf = { sellable: M({ a: 10, b: 4 }), damaged: M({ a: 2 }) };
  const rows = v.unloadVariance(shelf, [{ stockId: "a", good: 9, damaged: 2 }]);
  const byId = Object.fromEntries(rows.map((r) => [r.stockId, r]));
  assert.equal(byId.a.difference, -1);
  assert.equal(byId.b.difference, -4, "an item not counted at all was found nowhere");
  assert.equal(byId.b.countedGood, 0);
  assert.throws(() => v.unloadVariance(shelf, [{ stockId: "a", good: -1, damaged: 0 }]), (e) => e.code === "COUNT_NEGATIVE");
});

test("settling moves the books by exactly counted good - expected good - expected damaged", () => {
  // books carry eG + eD for the van; the world has cG at the depot and cD in the bin
  const cases = [
    { expectedGood: 10, expectedDamaged: 2, countedGood: 10, countedDamaged: 2 },
    { expectedGood: 10, expectedDamaged: 2, countedGood: 8, countedDamaged: 2 },
    { expectedGood: 10, expectedDamaged: 0, countedGood: 11, countedDamaged: 0 },
    { expectedGood: 10, expectedDamaged: 2, countedGood: 10, countedDamaged: 1 },
    { expectedGood: 0, expectedDamaged: 3, countedGood: 0, countedDamaged: 3 },
  ];
  for (const c of cases) {
    const row = { stockId: "a", ...c, difference: c.countedGood + c.countedDamaged - c.expectedGood - c.expectedDamaged };
    const m = v.stockMoves(row);
    assert.equal(m.damage + m.variance, c.countedGood - c.expectedGood - c.expectedDamaged, JSON.stringify(c));
    assert.ok(m.damage <= 0, "damaged goods only ever leave stock");
  }
});

test("cash settlement always balances: handed + short = expected + over", () => {
  for (const [expected, handed] of [[1000, 1000], [1000, 900.5], [1000, 1010], [0, 0], [250.25, 0], [0, 40]]) {
    const c = v.cashSettlement({ expected, handed });
    assert.equal(Math.round((c.handed + c.short) * 100), Math.round((c.expected + c.over) * 100), `${expected}/${handed}`);
    assert.ok(c.short === 0 || c.over === 0, "never both");
  }
  assert.equal(v.cashSettlement({ expected: 100, handed: 90 }).short, 10);
  assert.equal(v.cashSettlement({ expected: 100, handed: 90 }).variance, -10);
  assert.equal(v.cashSettlement({ expected: 100, handed: 130 }).over, 30);
  assert.throws(() => v.cashSettlement({ expected: 1, handed: -1 }), (e) => e.code === "CASH_NEGATIVE");
});

test("cheques taken but not handed in are named, whatever the case of the number", () => {
  const taken = [{ chequeNo: "ABC123", amount: 1 }, { chequeNo: "XYZ9", amount: 2 }];
  assert.deepEqual(v.missingCheques(taken, ["abc123"]).map((c) => c.chequeNo), ["XYZ9"]);
  assert.deepEqual(v.missingCheques(taken, ["abc123", "xyz9"]), []);
});

test("a route lists its customers in visit order, only on its days, with what was done", () => {
  const route = { days: [1, 3], customers: [{ customerId: "c2", name: "Two", seq: 1 }, { customerId: "c1", name: "One", seq: 0 }] };
  assert.deepEqual(v.routeToday(route, 2), [], "not a route day");
  const list = v.routeToday(route, 1, { sold: new Set(["c1"]), collected: new Set() });
  assert.deepEqual(list.map((c) => [c.customerId, c.sold, c.collected]), [["c1", true, false], ["c2", false, false]]);
  assert.equal(v.routeToday({ days: [], customers: [{ customerId: "c", seq: 0 }] }, 5).length, 1, "no days listed means any day");
});

test("the trip's life only moves forward", () => {
  assert.equal(v.canMove("LOADING", "ON_ROUTE"), true);
  assert.equal(v.canMove("ON_ROUTE", "UNLOADED"), true);
  assert.equal(v.canMove("UNLOADED", "SETTLED"), true);
  assert.equal(v.canMove("SETTLED", "ON_ROUTE"), false);
  assert.equal(v.canMove("ON_ROUTE", "LOADING"), false);
  assert.equal(v.canMove("CANCELLED", "ON_ROUTE"), false);
});

test("a van and a route are validated and tidied", () => {
  assert.deepEqual(v.validateVan({ code: " van-1 ", name: "Van One", plate: "dxb 123" }), { code: "VAN-1", name: "Van One", plate: "DXB 123" });
  assert.throws(() => v.validateVan({ name: "x" }), (e) => e.code === "VAN_CODE_REQUIRED");
  assert.throws(() => v.validateVan({ code: "a b", name: "x" }), (e) => e.code === "VAN_CODE_INVALID");
  const r = v.validateRoute({ name: "North", days: [3, 1, 3, 9], customers: [{ customerId: "a" }, { customerId: "a" }, { customerId: "b" }] });
  assert.deepEqual(r.days, [1, 3]);
  assert.deepEqual(r.customers.map((c) => [c.customerId, c.seq]), [["a", 0], ["b", 1]]);
});
