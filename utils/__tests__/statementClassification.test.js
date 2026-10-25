// The rules both balance sheets classify and order by. No database: these are the decisions, and a
// change to any of them moves a figure on a statement somebody files.
//
//   node --require ./utils/testSetup.js --test utils/__tests__/statementClassification.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const sc = require("../statementClassification");

// ---------------------------------------------------------------- current / non-current
test("non-current is decided by the group path, not by the account's own name", () => {
  assert.equal(sc.isNonCurrent(["Assets", "Fixed Assets"]), true);
  assert.equal(sc.isNonCurrent(["Assets", "Non-Current Assets", "Motor vehicles"]), true);
  assert.equal(sc.isNonCurrent(["Assets", "Property, Plant and Equipment"]), true);
  assert.equal(sc.isNonCurrent(["Assets", "Intangible Assets"]), true);
  assert.equal(sc.isNonCurrent(["Liabilities", "Long-term Liabilities"]), true);

  assert.equal(sc.isNonCurrent(["Assets", "Current Assets", "Cash"]), false);
  assert.equal(sc.isNonCurrent(["Assets", "Accounts Receivable"]), false);
  assert.equal(sc.isNonCurrent([]), false, "an account under no group at all is current");
});

test("a group ANYWHERE above the account makes it non-current", () => {
  // the account's own group says nothing; its parent does. Judging the leaf alone would file a
  // vehicle bought this year under current assets.
  assert.equal(sc.isNonCurrent(["Assets", "Fixed Assets", "Vehicles"]), true);
  assert.equal(sc.isNonCurrent(["Assets", "Fixed Assets", "Accumulated Depreciation"]), true);
});

// ---------------------------------------------------------------- the group path
test("the path reads from the top of the tree down to the group itself", () => {
  const groups = [
    { _id: "1", name: "Assets", parentGroup: null },
    { _id: "2", name: "Fixed Assets", parentGroup: "1" },
    { _id: "3", name: "Vehicles", parentGroup: "2" },
  ];
  const pathOf = sc.pathBuilder(groups);
  assert.deepEqual(pathOf("3"), ["Assets", "Fixed Assets", "Vehicles"]);
  assert.deepEqual(pathOf("1"), ["Assets"]);
  assert.deepEqual(pathOf(null), [], "an account with no group has no path");
  assert.deepEqual(pathOf("nope"), [], "a group id nothing matches is not an error");
});

test("a cycle in the group tree ends instead of hanging", () => {
  // Nothing should ever write one, but a statement that never returns is worse than one that is wrong.
  const pathOf = sc.pathBuilder([
    { _id: "a", name: "A", parentGroup: "b" },
    { _id: "b", name: "B", parentGroup: "a" },
  ]);
  assert.deepEqual(pathOf("a"), ["B", "A"]);
});

test("the path is worked out once per group", () => {
  let reads = 0;
  const groups = [{ _id: "1", name: "Assets", parentGroup: null }];
  const pathOf = sc.pathBuilder(new Proxy(groups, {
    get(t, k) { if (k === Symbol.iterator) reads += 1; return Reflect.get(t, k); },
  }));
  pathOf("1"); pathOf("1"); pathOf("1");
  assert.equal(reads, 0, "the tree is walked from the map built up front, not re-read per account");
});

// ---------------------------------------------------------------- reading order (IAS 1)
const rank = (category, accountName, path = [], isCash = false) =>
  sc.presentationRank({ category, accountName, path, isCash });

test("within assets: stock, then receivables, then the rest, cash LAST", () => {
  const stock = rank("ASSET", "Inventory Stock", ["Assets", "Inventory"]);
  const debtors = rank("ASSET", "Customer - Al Noor", ["Assets", "Accounts Receivable"]);
  const other = rank("ASSET", "Prepaid Expenses", ["Assets", "Current Assets"]);
  const cash = rank("ASSET", "Cash in Hand", ["Assets", "Cash"], true);
  assert.ok(stock < debtors, "stock before receivables");
  assert.ok(debtors < other, "receivables before the rest");
  assert.ok(other < cash, "cash is last, which is the order IAS 1 reads in");
});

test("cash is known by the posting map, not by being called cash", () => {
  // An account the configuration says IS cash sorts last even when nothing in its name says so.
  assert.equal(rank("ASSET", "Till float", ["Assets", "Current Assets"], true), 9);
});

test("within liabilities, payables come first", () => {
  assert.ok(rank("LIABILITY", "Vendor - Gulf Mills", ["Liabilities", "Accounts Payable"])
    < rank("LIABILITY", "Accrued Expenses", ["Liabilities", "Current Liabilities"]));
});

test("within equity: capital, then retained earnings, then the rest, with drawings under them", () => {
  const capital = rank("EQUITY", "Owner's Capital", ["Equity"]);
  const retained = rank("EQUITY", "Retained Earnings", ["Equity"]);
  const reserve = rank("EQUITY", "General Reserve", ["Equity"]);
  const drawings = rank("EQUITY", "Owner's Drawings", ["Equity"]);
  assert.ok(capital < retained && retained < reserve, "capital, retained earnings, then other equity");
  assert.ok(drawings > reserve, "money taken out reads after the capital it reduces");
});

// ---------------------------------------------------------------- drawings
test("drawings are recognised however they are worded", () => {
  assert.equal(sc.isDrawings({ accountName: "Owner's Drawings" }), true);
  assert.equal(sc.isDrawings({ accountName: "Drawings - Ziyad" }), true);
  assert.equal(sc.isDrawings({ accountName: "Partner withdrawals" }), true);
  assert.equal(sc.isDrawings({ accountName: "Amount withdrawn - Razal" }), true);

  assert.equal(sc.isDrawings({ accountName: "Owner's Capital" }), false);
  assert.equal(sc.isDrawings({ accountName: "Retained Earnings" }), false);
  assert.equal(sc.isDrawings({}), false);
  assert.equal(sc.isDrawings(null), false, "a missing row is not a drawings account");
});
