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

test("a van over its cash limit is flagged; no limit means never over", () => {
  assert.equal(v.overCashLimit(5000.01, 5000), true);
  assert.equal(v.overCashLimit(5000, 5000), false);
  assert.equal(v.overCashLimit(1e9, null), false);
  assert.equal(v.overCashLimit(1, 0), true, "a limit of zero means hand everything in");
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
  assert.deepEqual(v.validateVan({ code: " van-1 ", name: "Van One", plate: "dxb 123" }), { code: "VAN-1", name: "Van One", plate: "DXB 123", cashLimit: null, offlineBlock: 0 });
  assert.equal(v.validateVan({ code: "V", name: "x", cashLimit: "5000" }).cashLimit, 5000);
  assert.throws(() => v.validateVan({ code: "V", name: "x", cashLimit: -1 }), (e) => e.code === "VAN_CASH_LIMIT_INVALID");
  assert.throws(() => v.validateVan({ name: "x" }), (e) => e.code === "VAN_CODE_REQUIRED");
  assert.throws(() => v.validateVan({ code: "a b", name: "x" }), (e) => e.code === "VAN_CODE_INVALID");
  const r = v.validateRoute({ name: "North", days: [3, 1, 3, 9], customers: [{ customerId: "a" }, { customerId: "a" }, { customerId: "b" }] });
  assert.deepEqual(r.days, [1, 3]);
  assert.deepEqual(r.customers.map((c) => [c.customerId, c.seq]), [["a", 0], ["b", 1]]);
});

test("suggested load: pre-orders in full, the average sold per run rounded up, less what is on the van, capped by the depot", () => {
  const m = (o) => new Map(Object.entries(o));
  const r = v.suggestLoad({
    preorders: m({ rice: 5 }),
    history: [m({ rice: 10, oil: 3 }), m({ rice: 12, oil: 2 }), m({ rice: 11 })],
    onVan: m({ rice: 4 }),
    free: m({ rice: 100, oil: 1 }),
    names: m({ rice: "Rice", oil: "Oil" }),
  });
  assert.deepEqual(r[0], { stockId: "rice", itemName: "Rice", qty: 12, why: { preorder: 5, average: 11, runs: 3, onVan: 4, free: 100, capped: false } });
  assert.equal(r[1].stockId, "oil");
  assert.equal(r[1].qty, 1, "oil averages 1.667 -> 2, but only 1 is free");
  assert.equal(r[1].why.capped, true);
  assert.deepEqual(v.suggestLoad({ history: [m({ rice: 2 })], onVan: m({ rice: 5 }) }), [], "already enough on the van");
  assert.deepEqual(v.suggestLoad({}), [], "a route never run and nothing pre-ordered suggests nothing");
});

test("expiry on loading: the FEFO batches that cover the quantity, named when they die before the shelf life asked", () => {
  const batches = [{ batchNo: "B1", expiryDate: "2026-11-20", qty: 5 }, { batchNo: "B2", expiryDate: "2026-12-30", qty: 50 }];
  assert.deepEqual(v.expiringOnLoad(batches, 3, "2026-11-24"), [{ batchNo: "B1", expiryDate: "2026-11-20", qty: 3 }]);
  assert.deepEqual(v.expiringOnLoad(batches, 20, "2026-11-24"), [{ batchNo: "B1", expiryDate: "2026-11-20", qty: 5 }]);
  assert.deepEqual(v.expiringOnLoad(batches, 20, "2026-11-19"), []);
  assert.equal(v.expiringOnLoad([{ batchNo: "D", expiryDate: new Date("2026-11-20T12:00:00Z"), qty: 1 }], 1, "2026-11-24").length, 1, "a real Date from the database");
  assert.equal(v.addDays("2026-11-28", 7), "2026-12-05");
});

test("the next run of a route is its next weekday after today, else tomorrow", () => {
  // 2026-11-17 is a Tuesday (2)
  assert.equal(v.nextRunDay([2, 4], "2026-11-17"), "2026-11-19", "Tuesday's run is today: the next is Thursday");
  assert.equal(v.nextRunDay([2], "2026-11-17"), "2026-11-24");
  assert.equal(v.nextRunDay([], "2026-11-17"), "2026-11-18");
});

test("distance: haversine in metres, a flag widened by the phone's own accuracy, never a refusal", () => {
  const shop = { lat: 25.2048, lng: 55.2708 };
  assert.equal(v.distanceM(shop, shop), 0);
  const d = v.distanceM(shop, { lat: 25.2048, lng: 55.2758 }); // ~0.005 deg of longitude at 25 N
  assert.ok(d > 480 && d < 520, `${d}`);
  assert.deepEqual(v.farFrom(shop, { lat: 25.2048, lng: 55.2758 }), { distanceM: d, far: true });
  assert.equal(v.farFrom(shop, { lat: 25.2048, lng: 55.2758, accuracy: 250 }).far, false, "a poor reading is not called far");
  assert.equal(v.farFrom(null, shop), null, "a customer never pinned: nothing to compare");
  assert.equal(v.distanceM(shop, { lat: "x", lng: 1 }), null);
});

test("odometer readings and the km a trip ran", () => {
  assert.equal(v.odometerOf(""), null);
  assert.equal(v.odometerOf("123456.7"), 123456.7);
  assert.throws(() => v.odometerOf(-1), { code: "ODOMETER_INVALID" });
  assert.equal(v.kmRun({ out: 1000, in: 1086.5 }), 86.5);
  assert.equal(v.kmRun({ out: 1000 }), null);
});

test("the board: stops served, the next one, and a van quiet for two hours on the road", () => {
  const stops = [{ customerId: "a", name: "A", sold: true }, { customerId: "b", name: "B", visit: { reason: "closed" } }, { customerId: "c", name: "C" }];
  const now = new Date("2026-11-17T12:00:00Z");
  const r = v.boardRow({ status: "ON_ROUTE", stops, lastAt: "2026-11-17T09:30:00Z", now });
  assert.deepEqual([r.done, r.total, r.next.name, r.quietMinutes, r.quiet], [2, 3, "C", 150, true]);
  assert.equal(v.boardRow({ status: "ON_ROUTE", stops, lastAt: "2026-11-17T11:00:00Z", now }).quiet, false);
  assert.equal(v.boardRow({ status: "LOADING", stops, lastAt: null, now }).quiet, false, "not out yet");
  assert.equal(v.boardRow({ status: "ON_ROUTE", stops: stops.slice(0, 2), lastAt: "2026-11-17T06:00:00Z", now }).quiet, false, "every stop served: done for the day");
  assert.equal(v.boardRow({ status: "ON_ROUTE", stops, departedAt: "2026-11-17T08:00:00Z", now }).quietMinutes, 240, "nothing done since it went out");
});

test("route profit: sales less returns, cost of goods, damage, road expenses and the cash short, per route", () => {
  const rows = v.routeProfit([
    { key: "r1", name: "North", sales: 1000, cost: 600, returns: 100, returnsCost: 60, damaged: 20, expenses: 50, cashVariance: -10, km: 80 },
    { key: "r1", name: "North", sales: 500, cost: 300, returns: 0, returnsCost: 0, damaged: 0, expenses: 30, cashVariance: 0, km: null },
    { key: "r2", name: "South", sales: 200, cost: 190, returns: 0, returnsCost: 0, damaged: 0, expenses: 40, cashVariance: 0 },
  ]);
  const n = rows[0];
  assert.equal(n.key, "r1");
  assert.deepEqual([n.trips, n.netSales, n.grossMargin, n.contribution, n.km, n.kmTrips], [2, 1400, 560, 450, 80, 1]);
  assert.equal(n.marginPct, 32.14);
  assert.equal(n.perKm, 5.63);
  assert.deepEqual([rows[1].contribution, rows[1].perKm], [-30, null], "a route that lost money, never driven on record");
});
