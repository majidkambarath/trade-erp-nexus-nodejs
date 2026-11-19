// Budgets: spreading a total, which lines a budget may hold, and budget against actual (utils/budgets.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const { spreadEvenly, validateLines, compare, shiftMonths } = require("../budgets");

const MONTHS = ["2026-01", "2026-02", "2026-03"];
const ACC = new Map([
  ["inc", { category: "INCOME", accountName: "Sales", accountCode: "4000" }],
  ["exp", { category: "EXPENSE", accountName: "Rent", accountCode: "6000" }],
  ["bank", { category: "ASSET", accountName: "Bank", accountCode: "1100" }],
]);

test("a total is spread over the months to the fils, the last month taking what is left", () => {
  assert.deepEqual(spreadEvenly(100, MONTHS), { "2026-01": 33.33, "2026-02": 33.33, "2026-03": 33.34 });
  assert.deepEqual(spreadEvenly(0, MONTHS), { "2026-01": 0, "2026-02": 0, "2026-03": 0 });
  assert.deepEqual(spreadEvenly(50, []), {});
});

test("a budget holds income and expense accounts once each, months of the year, and no negative or three-decimal amounts", () => {
  const ok = validateLines([{ accountId: "inc", amounts: { "2026-01": 100, "2026-02": "", "2026-03": 0 } }], MONTHS, ACC);
  assert.deepEqual(ok.lines, [{ accountId: "inc", amounts: { "2026-01": 100 } }]);
  const bad = (lines, re) => assert.throws(() => validateLines(lines, MONTHS, ACC), (e) => e.code === "INVALID_BUDGET" && re.test(e.message));
  bad([{ accountId: "bank", amounts: {} }], /not an income or expense/);
  bad([{ accountId: "inc" }, { accountId: "inc" }], /twice/);
  bad([{ accountId: "inc", amounts: { "2025-12": 5 } }], /not a month of this year/);
  bad([{ accountId: "exp", amounts: { "2026-01": -1 } }], /negative/);
  bad([{ accountId: "exp", amounts: { "2026-01": 1.005 } }], /two decimals/);
  bad([{ accountId: "" }], /choose an account/);
});

test("budget against actual: variance, use, which way is good, totals, net and the monthly series", () => {
  const lines = [
    { accountId: "inc", amounts: { "2026-01": 1000, "2026-02": 1000 } },
    { accountId: "exp", amounts: { "2026-01": 400, "2026-02": 400 } },
  ];
  const actual = new Map([
    ["inc", new Map([["2026-01", 900], ["2026-02", 1300]])],
    ["exp", new Map([["2026-01", 500]])],
    ["other", new Map([["2026-01", 1]])],
  ]);
  const accounts = new Map([...ACC, ["other", { category: "EXPENSE", accountName: "Fuel", accountCode: "6100" }]]);
  const r = compare(lines, actual, ["2026-01", "2026-02"], accounts);
  const inc = r.rows.find((x) => x.accountId === "inc");
  assert.deepEqual([inc.budget, inc.actual, inc.variance, inc.used, inc.favourable], [2000, 2200, 200, 110, true]);
  const exp = r.rows.find((x) => x.accountId === "exp");
  assert.deepEqual([exp.budget, exp.actual, exp.variance, exp.favourable], [800, 500, -300, true]);
  const fuel = r.rows.find((x) => x.accountId === "other");
  assert.equal(fuel.budget, 0, "something spent with no budget line is still shown");
  assert.equal(fuel.used, null);
  assert.equal(fuel.favourable, false);
  assert.deepEqual(r.totals.net, { budget: 1200, actual: 1699, variance: 499 });
  assert.deepEqual(r.series, [{ month: "2026-01", budgetNet: 600, actualNet: 399 }, { month: "2026-02", budgetNet: 600, actualNet: 1300 }]);
});

test("last year's months land on this year's in order", () => {
  const map = shiftMonths(["2025-04", "2025-05"], ["2026-04", "2026-05"]);
  assert.equal(map.get("2025-05"), "2026-05");
});
