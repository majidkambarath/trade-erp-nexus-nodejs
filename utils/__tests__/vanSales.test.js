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

test("expired goods back on the van are kept apart from the sellable and the damaged ones", () => {
  const returned = v.returnedOf([{ items: [{ itemId: "a", qty: 2, returnCondition: "expired" }, { itemId: "a", qty: 1, returnCondition: "damaged" }, { itemId: "b", qty: 3, returnCondition: "expired" }] }]);
  assert.deepEqual(asObj(returned.expired), { a: 2, b: 3 });
  const out = v.onVan({ status: "ON_ROUTE", loaded: M({ a: 10 }), sold: M({ a: 4 }), returned });
  assert.deepEqual(asObj(out.sellable), { a: 6 });
  assert.deepEqual(asObj(out.damaged), { a: 1 });
  assert.deepEqual(asObj(out.expired), { a: 2, b: 3 });
  assert.deepEqual(asObj(out.physical), { a: 9, b: 3 }, "the depot's free stock leaves them alone too");
  assert.deepEqual(v.RETURN_CONDITIONS, ["good", "damaged", "expired"]);
});

test("the count with expired goods: shown only where there are some, and a negative count refused", () => {
  const shelf = { sellable: M({ a: 5, b: 2 }), damaged: M({}), expired: M({ a: 2 }) };
  const rows = Object.fromEntries(v.unloadVariance(shelf, [{ stockId: "a", good: 5, damaged: 0, expired: 1 }, { stockId: "b", good: 1, damaged: 0, expired: 1 }]).map((r) => [r.stockId, r]));
  assert.deepEqual([rows.a.expectedExpired, rows.a.countedExpired, rows.a.difference], [2, 1, -1]);
  assert.deepEqual([rows.b.expectedExpired, rows.b.countedExpired, rows.b.difference], [0, 1, 0], "found expired on the van: the same unit, now expired");
  const [plain] = v.unloadVariance({ sellable: M({ c: 1 }) }, [{ stockId: "c", good: 1 }]);
  assert.equal("countedExpired" in plain, false);
  assert.throws(() => v.unloadVariance(shelf, [{ stockId: "a", good: 5, damaged: 0, expired: -1 }]), (e) => e.code === "COUNT_NEGATIVE");
});

test("a trip that is not out holds nothing: the goods are back at the depot or never left it", () => {
  for (const status of ["UNLOADED", "SETTLED", "CANCELLED"]) {
    const out = v.onVan({ status, loaded: M({ a: 5 }) });
    assert.equal(out.sellable.size + out.physical.size + out.damaged.size + out.expired.size, 0, status);
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
    { expectedGood: 6, expectedDamaged: 1, expectedExpired: 2, countedGood: 6, countedDamaged: 1, countedExpired: 2 },
    { expectedGood: 6, expectedDamaged: 0, expectedExpired: 0, countedGood: 4, countedDamaged: 0, countedExpired: 2 },
    { expectedGood: 0, expectedDamaged: 0, expectedExpired: 3, countedGood: 0, countedDamaged: 0, countedExpired: 1 },
  ];
  for (const c of cases) {
    const x = (n) => n || 0;
    const row = { stockId: "a", ...c, difference: c.countedGood + c.countedDamaged + x(c.countedExpired) - c.expectedGood - c.expectedDamaged - x(c.expectedExpired) };
    const m = v.stockMoves(row);
    assert.equal(x(m.expiry) + m.damage + m.variance, c.countedGood - c.expectedGood - c.expectedDamaged - x(c.expectedExpired), JSON.stringify(c));
    assert.ok(m.damage <= 0 && x(m.expiry) <= 0, "damaged and expired goods only ever leave stock");
    assert.equal("expiry" in m, x(c.countedExpired) > 0);
  }
});

test("cash settlement always balances: handed + short = expected + over", () => {
  for (const [expected, handed] of [[1000, 1000], [1000, 900.5], [1000, 1010], [0, 0], [250.25, 0], [0, 40], [-25, -25], [-25, -30], [-25, 0]]) {
    const c = v.cashSettlement({ expected, handed });
    assert.equal(Math.round((c.handed + c.short) * 100), Math.round((c.expected + c.over) * 100), `${expected}/${handed}`);
    assert.ok(c.short === 0 || c.over === 0, "never both");
  }
  assert.equal(v.cashSettlement({ expected: 100, handed: 90 }).short, 10);
  assert.equal(v.cashSettlement({ expected: 100, handed: 90 }).variance, -10);
  assert.equal(v.cashSettlement({ expected: 100, handed: 130 }).over, 30);
  assert.throws(() => v.cashSettlement({ expected: 1, handed: -1 }), (e) => e.code === "CASH_NEGATIVE");
  assert.throws(() => v.cashSettlement({ expected: 0, handed: -1 }), (e) => e.code === "CASH_NEGATIVE");
  // more spent than taken: paid back in full it balances; paid too much is a shortage, too little goes over
  assert.deepEqual(v.cashSettlement({ expected: -25, handed: -25 }), { expected: -25, handed: -25, short: 0, over: 0, variance: 0, balanced: true });
  assert.equal(v.cashSettlement({ expected: -25, handed: -30 }).short, 5);
  assert.equal(v.cashSettlement({ expected: -25, handed: 0 }).over, 25);
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

test("suggested load: an organisation's safety margin goes on the average, never on a pre-order, and is still rounded up", () => {
  const m = (o) => new Map(Object.entries(o));
  const base = { preorders: m({ rice: 5 }), history: [m({ rice: 10 }), m({ rice: 12 }), m({ rice: 11 })], onVan: m({}), free: m({ rice: 100 }), names: m({ rice: "Rice" }) };
  assert.equal(v.suggestLoad(base)[0].qty, 5 + 11, "no margin: what it always was");
  assert.equal(v.suggestLoad({ ...base, extraPercent: 0 })[0].qty, 16);
  assert.equal(v.suggestLoad({ ...base, extraPercent: 10 })[0].qty, 5 + 13, "11 x 1.10 = 12.1, rounded up to 13; the pre-order stays 5");
  assert.equal(v.suggestLoad({ ...base, extraPercent: -50 })[0].qty, 16, "a negative margin is not a thing");
  assert.equal(v.suggestLoad({ ...base, extraPercent: "x" })[0].qty, 16, "nor is a word");
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

// ---- phase 7: the door, targets and the owner's figures -------------------------------------------------------
test("customerInsight: the last order, the usual items and what they stopped buying, all cut to the van", () => {
  const inv = (number, ...lines) => ({ number, date: "2026-11-01", lines: lines.map(([stockId, name, qty]) => ({ stockId, name, qty })) });
  const invoices = [inv("S5", ["a", "Rice", 6], ["b", "Oil", 2]), inv("S4", ["a", "Rice", 4]), inv("S3", ["a", "Rice", 5]), inv("S2", ["c", "Sugar", 3]), inv("S1", ["c", "Sugar", 5], ["d", "Salt", 1])];
  const r = v.customerInsight({ invoices, onVan: { a: 20, b: 0, c: 9 } });
  assert.deepEqual(r.lastOrder.lines.map((l) => [l.name, l.qty, l.onVan]), [["Rice", 6, 20], ["Oil", 2, 0]], "the last order keeps a line the van no longer holds, marked 0");
  assert.deepEqual(r.usual.map((x) => [x.name, x.times, x.avgQty]), [["Rice", 3, 5]], "usual = bought often AND lately, and only what the van has");
  assert.deepEqual(r.notLately.map((x) => [x.name, x.times, x.avgQty]), [["Sugar", 2, 4]], "Sugar was bought twice before and not in the last three");
  assert.equal(v.customerInsight({ invoices: [], onVan: {} }).lastOrder, null);
  const one = v.customerInsight({ invoices: [inv("S1", ["a", "Rice", 3])], onVan: { a: 5 } });
  assert.deepEqual(one.usual.map((x) => x.name), ["Rice"], "one invoice is all there is, so it is their usual");
  assert.deepEqual(one.notLately, []);
});

test("kpis: drop size, lines per call, strike rate and cost per drop are null with nothing to divide by", () => {
  assert.deepEqual(v.kpis({ sales: 1000, invoices: 4, lines: 10, calls: 5, productive: 4, expenses: 60 }), { dropSize: 250, linesPerCall: 2.5, strikeRate: 80, costPerDrop: 15 });
  assert.deepEqual(v.kpis({}), { dropSize: null, linesPerCall: null, strikeRate: null, costPerDrop: null });
  assert.equal(v.kpis({ sales: 1050, netSales: 1000, invoices: 4 }).dropSize, 250, "the average drop is before VAT when the net figure is known");
});

test("targets: blank is no target, a bad one is refused, progress caps nothing but says what is left", () => {
  assert.equal(v.targetsOf({ dailySalesTarget: "" }).dailySalesTarget, null);
  assert.deepEqual(v.targetsOf({ dailySalesTarget: "1500.456", dailyCallsTarget: 12 }), { dailySalesTarget: 1500.46, dailyCallsTarget: 12 });
  assert.deepEqual(v.targetsOf({}), {}, "an update that names no target leaves them alone");
  assert.throws(() => v.targetsOf({ dailySalesTarget: -1 }), { code: "VAN_TARGET_INVALID" });
  assert.throws(() => v.targetsOf({ dailyCallsTarget: 2.5 }), { code: "VAN_TARGET_INVALID" });
  assert.equal(v.targetProgress({ sales: 5, target: null }), null);
  const p = v.targetProgress({ sales: 700, calls: 12, target: { sales: 1000, calls: 10 } });
  assert.deepEqual([p.sales.pct, p.sales.toGo, p.sales.hit, p.calls.pct, p.calls.toGo, p.calls.hit], [70, 300, false, 120, 0, true]);
});

test("salesByDay: every day of the period is there, quiet days as zero", () => {
  const d = v.salesByDay([{ day: "2026-11-02", sales: 5, invoices: 1 }, { day: "2026-11-02", sales: 7.5, invoices: 2 }], "2026-11-01", "2026-11-03");
  assert.deepEqual(d.map((x) => [x.day, x.sales, x.invoices]), [["2026-11-01", 0, 0], ["2026-11-02", 12.5, 3], ["2026-11-03", 0, 0]]);
});

test("returnsByReason: one row per reason, the credits added, older returns as 'Not given', biggest first", () => {
  const trips = [
    { returns: [{ reason: "Expired", amount: 40, withoutInvoice: true }, { reason: "Damaged", amount: 10.1 }] },
    { returns: [{ reason: "Expired", amount: 20.2, withoutInvoice: false }, { transactionId: "old" }] },
    {},
  ];
  assert.deepEqual(v.returnsByReason(trips, (r) => (r.transactionId === "old" ? 5 : 0)), [
    { reason: "Expired", count: 2, amount: 60.2, withoutInvoice: 1 },
    { reason: "Damaged", count: 1, amount: 10.1, withoutInvoice: 0 },
    { reason: "Not given", count: 1, amount: 5, withoutInvoice: 0 },
  ]);
  assert.deepEqual(v.returnsByReason([]), []);
});

test("load requests: an open request, what is loaded but not accepted, and what the salesman accepts", () => {
  const req = (status, lines) => ({ no: 1, status, lines });
  const trip = (status, loadRequests) => ({ status, loadRequests, loads: [] });
  assert.equal(v.openRequest(trip("LOADING", [req("ACCEPTED", []), req("REJECTED", [])])), null);
  assert.equal(v.openRequest(trip("LOADING", [req("LOADED", [])])).status, "LOADED");

  const loaded = req("LOADED", [{ stockId: "a", itemName: "Rice", requested: 10, loaded: 8 }, { stockId: "b", itemName: "Oil", requested: 5, loaded: 0 }]);
  assert.deepEqual([...v.awaitingOf(trip("LOADING", [loaded]))], [["a", 8]], "loaded, not accepted: reserved; nothing loaded of b reserves nothing");
  assert.deepEqual([...v.awaitingOf(trip("UNLOADED", [loaded]))], [], "a trip not holding stock reserves nothing");
  assert.deepEqual([...v.awaitingOf(trip("LOADING", [req("REQUESTED", [{ stockId: "a", requested: 9 }])]))], [], "asked for is not reserved");
  assert.deepEqual([...v.onVansAll([{ physical: new Map([["a", 2]]), awaiting: new Map([["a", 8]]) }])], [["a", 10]], "other vans and job work see it taken");

  assert.deepEqual(v.acceptPlan(loaded, []), { lines: [{ stockId: "a", itemName: "Rice", loaded: 8, accepted: 8 }], short: [] }, "a line not mentioned is accepted in full");
  const part = v.acceptPlan(loaded, [{ stockId: "a", accepted: "6" }]);
  assert.deepEqual(part.short, [{ stockId: "a", itemName: "Rice", loaded: 8, accepted: 6, missing: 2 }]);
  assert.equal(v.acceptPlan(loaded, [{ stockId: "a", accepted: 0 }]).lines[0].accepted, 0, "nothing at all may be accepted");
  assert.throws(() => v.acceptPlan(loaded, [{ stockId: "a", accepted: 9 }]), { code: "ACCEPT_MORE_THAN_LOADED" });
  assert.throws(() => v.acceptPlan(loaded, [{ stockId: "a", accepted: -1 }]), { code: "QTY_INVALID" });
  assert.throws(() => v.acceptPlan(loaded, [{ stockId: "a", accepted: [3] }]), { code: "QTY_INVALID" });
  assert.throws(() => v.acceptPlan(loaded, [{ stockId: "z", accepted: 1 }]), { code: "LINE_NOT_LOADED" });
});

test("a van with no route is quiet whenever nothing has been done for two hours; it has no stops to finish", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  const r = v.boardRow({ status: "ON_ROUTE", stops: [], lastAt: "2026-11-17T09:00:00Z", now });
  assert.deepEqual([r.done, r.total, r.next, r.quiet], [0, 0, null, true]);
  assert.equal(v.boardRow({ status: "ON_ROUTE", stops: [], lastAt: "2026-11-17T11:00:00Z", now }).quiet, false, "busy an hour ago");
  assert.equal(v.boardRow({ status: "UNLOADED", stops: [], lastAt: "2026-11-17T06:00:00Z", now }).quiet, false, "back at the depot");
});

test("a van's own shops: each once, the most recent first, junk left out, cut to the limit", () => {
  const rows = v.recentCustomers([
    { customerId: "a", at: "2026-11-01T08:00:00Z" },
    { customerId: "b", at: new Date("2026-11-03T08:00:00Z") },
    { customerId: "a", at: "2026-11-05T08:00:00Z" },
    { customerId: { _id: "c" }, at: "2026-11-02T08:00:00Z" },
    { customerId: "", at: "2026-11-06T08:00:00Z" },
    { customerId: "d", at: "not a date" },
    null,
  ]);
  assert.deepEqual(rows.map((r) => r.customerId), ["a", "b", "c"]);
  assert.equal(rows[0].lastAt, "2026-11-05T08:00:00.000Z", "the latest time a shop was served");
  assert.deepEqual(v.recentCustomers([{ customerId: "a", at: "2026-11-01" }, { customerId: "b", at: "2026-11-02" }], { limit: 1 }).map((r) => r.customerId), ["b"]);
  assert.deepEqual(v.recentCustomers(undefined), []);
});

test("a van counted in holds back its damaged, expired and missing units until it is settled; good and extra units free nothing", () => {
  const trip = (status, lines) => ({ status, unload: { lines } });
  const lines = [
    { stockId: "rice", countedGood: 8, countedDamaged: 1, countedExpired: 2, difference: -1 },
    { stockId: "oil", countedGood: 7, countedDamaged: 0, difference: 2 },
    { stockId: "milk", countedGood: 3, countedDamaged: 0, countedExpired: 0, difference: 0 },
  ];
  assert.deepEqual(asObj(v.countedInReserve(trip("UNLOADED", lines))), { rice: 4 });
  assert.equal(v.countedInReserve(trip("SETTLED", lines)).size, 0, "settled: written off, nothing held");
  assert.equal(v.countedInReserve(trip("ON_ROUTE", lines)).size, 0, "out: it is on the van, not counted in");
  assert.equal(v.countedInReserve({ status: "UNLOADED" }).size, 0);
  assert.equal(v.freeDepot({ currentStock: 20, withJobWorker: 2, onVans: 3, countedIn: 4 }), 11);
  assert.equal(v.freeDepot({ currentStock: 5, countedIn: 9 }), 0, "never below zero");
});

test("a count that leaves out an item the van should hold is not a count of nothing", () => {
  const stock = { sellable: M({ rice: 10, oil: 0 }), damaged: M({ milk: 1 }), expired: M({}) };
  assert.deepEqual(v.uncounted(stock, [{ stockId: "rice", good: 9 }]), ["milk"], "oil has none left, so it need not be counted");
  assert.deepEqual(v.uncounted(stock, [{ stockId: "rice", good: 0 }, { stockId: "milk", damaged: 0 }]), []);
  assert.deepEqual(v.uncounted(stock, undefined).sort(), ["milk", "rice"]);
});
