// The sums behind the van analysis reports (utils/vanAnalysis.js), without a database.
const test = require("node:test");
const assert = require("node:assert/strict");
const a = require("../vanAnalysis");

const V1 = { vanId: "v1", vanCode: "VAN-1", vanName: "North" };
const V2 = { vanId: "v2", vanCode: "VAN-2", vanName: "South" };
const settled = (van, date, over = {}) => ({
  ...van, date, settled: true, km: 100, invoices: 2, sales: 1000, returns: 100, cost: 600, returnsCost: 60,
  damagedValue: 20, expiredValue: 30, differenceValue: -10, cashVariance: -5, road: [{ kind: "fuel", net: 80 }, { kind: "toll", net: 20 }], ...over,
});

test("the query is read strictly: no dates is two years, ids are checked, a period over two years refused", () => {
  const q = a.readQuery({}, "2026-11-28");
  assert.deepEqual([q.from, q.to, q.months, q.vanId], ["2024-11-29", "2026-11-28", 12, ""]);
  assert.equal(a.readQuery({ from: "2026-11-01" }, "2026-11-28").to, "2026-11-28");
  for (const [bad, code] of [
    [{ from: "2026-02-30" }, "INVALID_DATE"], [{ from: "2026-11-02", to: "2026-11-01" }, "INVALID_RANGE"],
    [{ from: "2024-01-01", to: "2026-01-01" }, "RANGE_TOO_LONG"], [{ vanId: "abc" }, "INVALID_FILTER"],
    [{ routeId: { $ne: "x" } }, "INVALID_FILTER"], [{ salesmanId: ["a"] }, "INVALID_FILTER"], [{ months: "7" }, "INVALID_FILTER"],
  ]) assert.throws(() => a.readQuery(bad, "2026-11-28"), (e) => e.code === code, JSON.stringify(bad));
});

test("the period before is the same length just before; months and the trend's first day", () => {
  assert.deepEqual(a.previousPeriod({ from: "2026-11-01", to: "2026-11-28" }), { from: "2026-10-04", to: "2026-10-31" });
  assert.deepEqual(a.monthsIn("2025-11-15", "2026-02-01"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.equal(a.trendStart("2026-02-10", 6), "2025-09-01");
});

test("the scorecard: margin, losses, expenses and contribution per van, the fleet, the average and the period before", () => {
  const r = a.scorecard({
    trips: [settled(V1, "2026-11-02"), settled(V1, "2026-11-02", { km: 50, road: [] }), settled(V2, "2026-11-03", { sales: 500, returns: 0, cost: 300, returnsCost: 0, damagedValue: 0, expiredValue: 0, differenceValue: 0, cashVariance: 0 }), { ...V2, date: "2026-11-04", settled: false, sales: 9999 }],
    office: [{ ...V2, kind: "mechanical", net: 400 }, { vanId: "v3", vanCode: "VAN-3", kind: "other", net: 25 }],
    previousTrips: [settled(V1, "2026-10-02")],
  });
  assert.equal(r.unsettled, 1);
  const v1 = r.rows.find((x) => x.key === "v1");
  assert.deepEqual([v1.allTrips, v1.trips, v1.days, v1.km], [2, 2, 1, 150]);
  assert.deepEqual([v1.netSales, v1.grossMargin, v1.expenses, v1.byKind.fuel, v1.byKind.toll], [1800, 720, 100, 80, 20]);
  // 720 margin - 40 damaged - 60 expired - 20 shortage - 100 expenses - 10 cash short
  assert.equal(v1.contribution, 490);
  assert.deepEqual([v1.returnsPct, v1.marginPct, v1.costPerKm, v1.salesPerKm], [10, 40, 0.67, 12]);
  assert.equal(v1.previous.netSales, 900);
  const v2 = r.rows.find((x) => x.key === "v2");
  assert.deepEqual([v2.trips, v2.allTrips, v2.netSales, v2.office, v2.road, v2.expenses, v2.byKind.mechanical], [1, 2, 500, 400, 100, 500, 400]);
  assert.deepEqual([v2.contribution, v2.expensePct], [-300, 100]);
  const v3 = r.rows.find((x) => x.key === "v3");
  assert.deepEqual([v3.trips, v3.office, v3.salesPerKm, v3.marginPct], [0, 25, null, null], "a van with only an office bill is still listed");
  assert.equal(r.total.netSales, 2300);
  assert.equal(r.total.expenses, 625);
  assert.equal(r.average.netSales, 766.67);
  assert.equal(r.total.previous.netSales, 900);
});

test("expenses: by type with shares and per km, by van and month; pending apart; today's names win", () => {
  const row = (van, date, kind, net, over = {}) => ({ ...van, date, voucherNo: `EV-${date}-${kind}`, source: "road", kind, label: kind, net, vat: 0, total: net, status: "approved", ...over });
  const r = a.expenseReport({
    register: [row(V1, "2026-10-05", "fuel", 300), row(V1, "2026-11-06", "mechanical", 100, { source: "office", vat: 5, total: 105 }), row(V2, "2026-11-07", "fuel", 100), row(V2, "2026-11-08", "toll", 40, { status: "pending" })],
    km: new Map([["v1", 200], ["v2", 100]]), labels: new Map([["mechanical", "Repairs"]]), from: "2026-10-01", to: "2026-11-30",
  });
  assert.deepEqual(r.kinds.map((k) => [k.label, k.net, k.share, k.perKm]), [["fuel", 400, 80, 1.33], ["Repairs", 100, 20, 0.33]]);
  assert.deepEqual(r.vans.map((v) => [v.vanCode, v.net, v.road, v.office, v.perKm, v.perKmByKind.fuel]), [["VAN-1", 400, 300, 100, 2, 1.5], ["VAN-2", 100, 100, 0, 1, 1]]);
  assert.deepEqual(r.months.map((m) => [m.month, m.net]), [["2026-10", 300], ["2026-11", 200]]);
  assert.deepEqual([r.total.net, r.total.vat, r.total.total, r.pending.count, r.pending.total], [500, 5, 505, 1, 40]);
  assert.equal(r.rows.length, 4);
  assert.equal(r.rows[0].date, "2026-11-08", "newest first");
});

test("returns: by customer, item and reason with the share of sales, losses at cost, and what spoiled on the van", () => {
  const line = (over) => ({ docId: "n1", ...V1, routeId: "r1", routeName: "North", customerId: "c1", customerName: "Al Noor", stockId: "milk", itemName: "Milk", reason: "Expired", condition: "good", qty: 1, credit: 15, cost: 10, ...over });
  const r = a.returnReport({
    lines: [line({ condition: "expired", qty: 3, credit: 45, cost: 30 }), line({ condition: "damaged" }), line({ docId: "n2", customerId: "c2", customerName: "Corner", reason: "Not selling", qty: 2, credit: 30, cost: 20 })],
    sales: { total: 900, van: new Map([["v1", 900]]), customer: new Map([["c1", 600], ["c2", 300]]), item: new Map([["milk", 450]]), route: new Map() },
    counted: [{ ...V1, stockId: "milk", itemName: "Milk", damaged: 2, expired: 3, returnedDamaged: 1, returnedExpired: 3, unitCost: 10 }, { ...V1, stockId: "rice", itemName: "Rice", damaged: 0, expired: 0, returnedDamaged: 0, returnedExpired: 0, unitCost: 5 }],
  });
  const c1 = r.groups.customer.find((x) => x.key === "c1");
  assert.deepEqual([c1.count, c1.qty, c1.credit, c1.pct, c1.expiredQty, c1.damagedQty, c1.expiredValue, c1.damagedValue, c1.lossValue], [1, 4, 60, 10, 3, 1, 30, 10, 40]);
  assert.deepEqual(r.groups.reason.map((x) => [x.name, x.credit, x.pct]), [["Expired", 60, 6.7], ["Not selling", 30, 3.3]]);
  assert.deepEqual(r.groups.item.map((x) => [x.name, x.qty, x.goodQty, x.pct]), [["Milk", 6, 2, 20]]);
  assert.equal(r.groups.route[0].pct, null, "no sales to divide by is no percentage");
  assert.deepEqual(r.total, { ...r.total, count: 2, qty: 6, credit: 90, pct: 10, lossValue: 40 });
  assert.deepEqual(r.onVan, [{ key: "v1|milk", vanId: "v1", vanCode: "VAN-1", stockId: "milk", itemName: "Milk", damagedQty: 1, expiredQty: 0, lossValue: 10 }]);
});

test("the trend adds each month per van and for the fleet; office bills in their own month", () => {
  const r = a.trendReport({ trips: [settled(V1, "2026-10-02"), settled(V1, "2026-11-02"), settled(V2, "2025-01-01")], office: [{ ...V1, date: "2026-11-20", net: 50 }], months: ["2026-10", "2026-11"] });
  assert.deepEqual(r.vans.map((v) => v.vanCode), ["VAN-1"], "a trip outside the months is not counted");
  assert.deepEqual(r.vans[0].rows.map((x) => [x.month, x.netSales, x.grossMargin, x.lossValue, x.expenses, x.contribution]), [["2026-10", 900, 360, 60, 100, 195], ["2026-11", 900, 360, 60, 150, 145]]);
  assert.equal(r.fleet.total.contribution, 340);
});

test("items: sales less returns by item, with a column per month and each one's share", () => {
  const l = (over) => ({ month: "2026-11", kind: "sale", qty: 2, net: 20, stockId: "milk", itemName: "Milk", customerId: "c1", customerName: "Al Noor", ...over });
  const r = a.itemReport({ lines: [l({}), l({ month: "2026-10", qty: 3, net: 30 }), l({ kind: "return", qty: 1, net: 10 }), l({ stockId: "rice", itemName: "Rice", net: 60, qty: 1 })], by: "item", months: ["2026-10", "2026-11"] });
  assert.deepEqual(r.rows.map((x) => [x.name, x.qty, x.sales, x.returns, x.netSales, x.months["2026-10"], x.months["2026-11"], x.share]), [["Rice", 1, 60, 0, 60, 0, 60, 60], ["Milk", 4, 50, 10, 40, 30, 10, 40]]);
  assert.deepEqual([r.total.netSales, r.total.months["2026-11"]], [100, 70]);
  assert.equal(a.itemReport({ lines: [l({})], by: "customer", months: [] }).rows[0].name, "Al Noor");
  assert.equal(a.itemReport({ lines: [], by: "toString" }).by, "item");
});

test("loads: sold against loaded, what came back, differences and how full the requests were; uncounted trips apart", () => {
  const t = (over) => ({ ...V1, salesmanId: "s1", salesmanName: "Ali", counted: true, loaded: 100, sold: 70, good: 20, damaged: 5, expired: 3, differenceUnits: -2, differenceValue: -20, backValue: 200, requested: 110, accepted: 100, ...over });
  const r = a.loadReport({ trips: [t({}), t({ sold: 90, good: 10, damaged: 0, expired: 0, differenceUnits: 0, differenceValue: 0, backValue: 100 }), t({ counted: false })], by: "salesman" });
  assert.deepEqual(r.rows.map((x) => [x.name, x.trips, x.uncounted, x.sold, x.sellThrough, x.differenceValue, x.fillRate]), [["Ali", 2, 1, 160, 80, -20, 90.9]]);
  assert.equal(r.total.backValue, 300);
});

test("collections: at the door, left on credit, old debts, the ways paid and cash short or over by day", () => {
  const t = (date, over) => ({ date, ...V1, salesmanId: "s1", invoiced: 1000, atDoor: 600, oldCollected: 200, onAccount: 0, cash: 700, cheque: 100, card: 0, transfer: 0, transferWaiting: 50, openNow: 400, cashVariance: null, ...over });
  const r = a.collectionReport({ trips: [t("2026-11-01", { cashVariance: -10 }), t("2026-11-01", { cashVariance: 4 }), t("2026-11-02", {})] });
  const v = r.rows[0];
  assert.deepEqual([v.trips, v.invoiced, v.atDoor, v.onCredit, v.oldCollected, v.collected, v.collectionPct, v.atDoorPct, v.cashShort, v.cashOver, v.transferWaiting, v.openNow], [3, 3000, 1800, 1200, 600, 2400, 80, 60, 10, 4, 150, 1200]);
  assert.deepEqual(r.days, [{ day: "2026-11-01", short: 10, over: 4 }]);
});

test("coverage: stops called and bought, targets, hours, sales per hour, start and finish, reasons", () => {
  const t = (over) => ({ ...V1, salesmanId: "s1", salesmanName: "Ali", tripNo: "VTR-1", date: "2026-11-01", planned: 10, calledOnRoute: 8, called: 9, bought: 6, callsTarget: 9, hours: 5, netSales: 1000, firstSale: 480, lastSale: 900, farSales: 1, ...over });
  const r = a.coverageReport({ trips: [t({}), t({ tripNo: "VTR-2", date: "2026-11-02", called: 5, bought: 2, calledOnRoute: 4, callsTarget: 9, hours: null, netSales: 500, firstSale: 540, lastSale: null, farSales: 0 })], visits: [{ reason: "closed" }, { reason: "closed" }, { reason: "no_money" }], notCalled: [{ customerId: "c9", name: "Far Shop" }] });
  const v = r.rows[0];
  assert.deepEqual([v.trips, v.planned, v.called, v.bought, v.coveragePct, v.strikeRate, v.withTarget, v.targetMet, v.hours, v.salesPerHour, v.firstSale, v.lastSale, v.farSales], [2, 20, 14, 8, 60, 57.1, 2, 1, 5, 200, "08:30", "15:00", 1]);
  assert.deepEqual(r.reasons, [{ reason: "closed", count: 2 }, { reason: "no_money", count: 1 }]);
  assert.equal(r.trips[0].tripNo, "VTR-2");
  assert.equal(a.clock(null), "");
});

test("without cost, no figure made from cost remains, at any depth", () => {
  const r = a.withoutCost(a.scorecard({ trips: [settled(V1, "2026-11-02")] }));
  const text = JSON.stringify(r);
  for (const f of a.COST_FIELDS) assert.equal(text.includes(`"${f}"`), false, f);
  assert.equal(r.rows[0].netSales, 900, "sales, returns and expenses stay");
  assert.equal(r.rows[0].expenses, 100);
});
