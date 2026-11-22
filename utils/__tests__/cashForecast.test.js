const test = require("node:test");
const assert = require("node:assert/strict");
const f = require("../cashForecast");

const item = (day, amount, source = "receivables", over = {}) => ({ day, amount, source, label: `${source} ${day}`, ...over });

test("week 1 is today to the coming Sunday, every later week Monday to Sunday", () => {
  const w = f.weeks("2026-11-25", 4); // a Wednesday
  assert.deepEqual(w.map((x) => [x.key, x.from, x.to]), [["W1", "2026-11-25", "2026-11-29"], ["W2", "2026-11-30", "2026-12-06"], ["W3", "2026-12-07", "2026-12-13"], ["W4", "2026-12-14", "2026-12-20"]]);
});

test("today being a Sunday makes a one-day first week, and a Monday a full one", () => {
  assert.deepEqual(f.weeks("2026-11-29", 2).map((x) => [x.from, x.to]), [["2026-11-29", "2026-11-29"], ["2026-11-30", "2026-12-06"]]);
  assert.deepEqual(f.weeks("2026-11-30", 1).map((x) => [x.from, x.to]), [["2026-11-30", "2026-12-06"]]);
});

test("thirteen weeks by default, capped, and nothing for a bad day", () => {
  assert.equal(f.weeks("2026-11-25").length, 13);
  assert.equal(f.weeks("2026-11-25", 500).length, f.MAX_WEEKS);
  assert.equal(f.weeks("2026-11-25", 0).length, 13);
  assert.deepEqual(f.weeks("soon"), []);
});

test("weeks are contiguous across a month and a year end, with no day twice and none missing", () => {
  const w = f.weeks("2026-12-24", 3);
  for (let i = 1; i < w.length; i += 1) assert.equal(w[i].from, f.addDays(w[i - 1].to, 1));
  assert.deepEqual(w.map((x) => x.from), ["2026-12-24", "2026-12-28", "2027-01-04"]);
});

test("items are filed into the week their day falls in, in and out apart, with the running balance", () => {
  const r = f.buildForecast({ today: "2026-11-25", opening: 1000, count: 3, items: [
    item("2026-11-26", -1500, "payables"), item("2026-12-01", 2000), item("2026-12-01", 300, "chequesIn"), item("2026-12-13", -100, "payroll"),
  ] });
  assert.deepEqual(r.weeks.map((w) => [w.in, w.out, w.net, w.closing]), [[0, 1500, -1500, -500], [2300, 0, 2300, 1800], [0, 100, -100, 1700]]);
  assert.deepEqual(r.weeks[1].bySource, { receivables: 2000, chequesIn: 300 });
  assert.equal(r.totals.in, 2300);
  assert.equal(r.totals.out, 1600);
  assert.equal(r.totals.closing, 1700);
});

test("the edge days belong to the right week: Sunday to the week it ends, Monday to the next", () => {
  const r = f.buildForecast({ today: "2026-11-25", count: 2, items: [item("2026-11-29", 10), item("2026-11-30", 20), item("2026-12-06", 30), item("2026-11-25", 40)] });
  assert.deepEqual(r.weeks.map((w) => w.in), [50, 50]);
});

test("an overdue item is shown apart and is NOT in the balance", () => {
  const r = f.buildForecast({ today: "2026-11-25", opening: 500, count: 2, items: [item("2026-11-20", 900), item("2026-10-01", -200, "payables"), item("2026-11-26", 100)] });
  assert.deepEqual([r.overdue.in, r.overdue.out, r.overdue.count], [900, 200, 2]);
  assert.equal(r.weeks[0].closing, 600);
  assert.equal(r.totals.closing, 600);
});

test("an item after the last week is later, shown apart", () => {
  const r = f.buildForecast({ today: "2026-11-25", opening: 0, count: 2, items: [item("2026-12-07", 700), item("2026-12-06", 50)] });
  assert.deepEqual([r.later.in, r.later.count], [700, 1]);
  assert.equal(r.totals.in, 50);
});

test("a held cheque is counted but kept out of the balance", () => {
  const r = f.buildForecast({ today: "2026-11-25", opening: 100, count: 1, items: [item("2026-11-26", 400, "chequesIn", { onHold: true }), item("2026-11-27", 60, "chequesIn")] });
  assert.equal(r.weeks[0].closing, 160);
  assert.deepEqual([r.onHold.in, r.onHold.count], [400, 1]);
  assert.equal(r.weeks[0].items.length, 1);
});

test("nothing is dropped: weeks + overdue + later + on hold account for every valid item", () => {
  const all = [item("2026-11-01", 5), item("2026-11-26", 7), item("2026-12-02", -3), item("2027-03-01", 11), item("2026-11-27", 13, "chequesIn", { onHold: true })];
  const r = f.buildForecast({ today: "2026-11-25", count: 2, items: all });
  const money = (x) => x.in + x.out;
  const counted = r.weeks.reduce((t, w) => t + w.in + w.out + w.onHold.in + w.onHold.out, 0) + money(r.overdue) + money(r.later);
  assert.equal(counted, all.reduce((t, i) => t + Math.abs(i.amount), 0));
});

test("junk items are skipped and counted, never thrown on or summed", () => {
  const r = f.buildForecast({ today: "2026-11-25", count: 1, items: [null, { day: "x", amount: 5 }, item("2026-11-26", NaN), item("2026-11-26", 0), item("2026-11-26", 9)] });
  assert.equal(r.skipped, 4);
  assert.equal(r.totals.in, 9);
  assert.equal(f.buildForecast({ today: "2026-11-25", items: "nope" }).weeks.length, 13);
});

test("the lowest balance and the first week that goes below zero", () => {
  const dips = f.buildForecast({ today: "2026-11-25", opening: 1000, count: 4, items: [item("2026-11-26", -1500), item("2026-12-01", 2000), item("2026-12-08", -2500)] });
  assert.deepEqual(dips.lowest, { closing: -1000, weekKey: "W3" }, "week 3 goes lower than week 1");
  assert.equal(dips.firstShortfall, "W1");
  const never = f.buildForecast({ today: "2026-11-25", opening: 1000, count: 2, items: [item("2026-12-01", 50)] });
  assert.equal(never.firstShortfall, null);
  assert.deepEqual(never.lowest, { closing: 1000, weekKey: null }, "today's cash is the lowest point when no week goes below it");
  const later = f.buildForecast({ today: "2026-11-25", opening: 100, count: 3, items: [item("2026-12-08", -300)] });
  assert.deepEqual([later.lowest.weekKey, later.firstShortfall], ["W3", "W3"]);
});

test("a week lists its biggest items first and counts the rest", () => {
  const items = Array.from({ length: f.SHOWN_PER_WEEK + 5 }, (_, i) => item("2026-11-26", i + 1));
  const w = f.buildForecast({ today: "2026-11-25", count: 1, items }).weeks[0];
  assert.equal(w.items.length, f.SHOWN_PER_WEEK);
  assert.equal(w.moreItems, 5);
  assert.equal(w.items[0].amount, f.SHOWN_PER_WEEK + 5);
  assert.equal(w.in, items.reduce((t, i) => t + i.amount, 0), "the figure still counts every item");
});

test("amounts add up to the fils with no drift", () => {
  const items = Array.from({ length: 10 }, () => item("2026-11-26", 0.1));
  assert.equal(f.buildForecast({ today: "2026-11-25", count: 1, items }).weeks[0].in, 1);
});

test("an expense with tax is the gross; run days are cut to the window", () => {
  assert.equal(f.grossOf(1000, 5), 1050);
  assert.equal(f.grossOf(1000, 0), 1000);
  assert.equal(f.grossOf(1000), 1000);
  assert.deepEqual(f.runsBetween(["2026-11-01", "2026-12-01", "2027-01-01", "x"], "2026-11-25", "2026-12-31"), ["2026-12-01"]);
});
