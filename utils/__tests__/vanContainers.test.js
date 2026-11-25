// Returnable containers on the vans (utils/vanContainers.js), tested without a database.
const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("../vanContainers");

const WATER = "a".repeat(24);
const MILK = "b".repeat(24);
const BREAD = "c".repeat(24);
const BOTTLE = "1".repeat(24);
const CRATE = "2".repeat(24);
const types = [
  { _id: BOTTLE, code: "B19", name: "19L bottle", deposit: 10, items: [{ stockId: WATER, perUnit: 1 }] },
  { _id: CRATE, code: "CR12", name: "Milk crate", deposit: 0, items: [{ stockId: MILK, perUnit: 1 / 12 }] },
];

test("a type: a short code, a name, a deposit of zero or more, items each once with what one unit takes", () => {
  assert.deepEqual(c.validateType({ code: " b19 ", name: " 19L bottle ", deposit: "10", items: [{ stockId: WATER, perUnit: "1" }] }), { code: "B19", name: "19L bottle", deposit: 10, active: true, items: [{ stockId: WATER, perUnit: 1 }] });
  assert.equal(c.validateType({ code: "CR", name: "Crate" }).deposit, 0, "no deposit is none");
  for (const [bad, code] of [
    [{ code: "", name: "x" }, "CONTAINER_CODE_INVALID"],
    [{ code: "TOO-LONG-CODE1", name: "x" }, "CONTAINER_CODE_INVALID"],
    [{ code: "A", name: "" }, "CONTAINER_NAME_INVALID"],
    [{ code: "A", name: "x", deposit: -1 }, "CONTAINER_DEPOSIT_INVALID"],
    [{ code: "A", name: "x", deposit: [5] }, "CONTAINER_DEPOSIT_INVALID"],
    [{ code: "A", name: "x", items: [{ stockId: WATER, perUnit: 0 }] }, "CONTAINER_ITEMS_INVALID"],
    [{ code: "A", name: "x", items: [{ stockId: WATER, perUnit: 1 }, { stockId: WATER, perUnit: 2 }] }, "CONTAINER_ITEMS_INVALID"],
    [{ code: "A", name: "x", items: [{ stockId: { $ne: 1 }, perUnit: 1 }] }, "CONTAINER_ITEMS_INVALID"],
    [{ code: "A", name: "x", items: "water" }, "CONTAINER_ITEMS_INVALID"],
  ]) assert.throws(() => c.validateType(bad), { code }, JSON.stringify(bad));
});

test("what a sale hands out: the containers its goods take, a part crate is a crate, goods with none take none", () => {
  const lines = [{ itemId: WATER, qty: 3 }, { itemId: MILK, qty: 13 }, { itemId: BREAD, qty: 5 }];
  assert.deepEqual([...c.givenFor(lines, types)], [[BOTTLE, 3], [CRATE, 2]], "13 milk is one crate and one more begun");
  assert.deepEqual([...c.givenFor([{ itemId: MILK, qty: 12 }], types)], [[CRATE, 1]], "a full crate is not two");
  assert.deepEqual([...c.givenFor([{ itemId: WATER, qty: 2 }], [{ ...types[0], active: false }])], [], "a type switched off hands nothing out");
});

test("the containers a person counts: whole numbers, one row per type, empty rows dropped", () => {
  assert.deepEqual(c.cleanMoves([{ typeId: BOTTLE, given: "2", collected: 1 }, { typeId: BOTTLE, given: 1 }, { typeId: CRATE, given: 0, collected: 0 }]), [{ typeId: BOTTLE, given: 3, collected: 1 }]);
  assert.deepEqual(c.cleanMoves(undefined), []);
  for (const bad of [[{ typeId: BOTTLE, given: 1.5 }], [{ typeId: BOTTLE, given: -1 }], [{ typeId: BOTTLE, collected: [2] }], [{ typeId: "x", given: 1 }], "two"]) {
    assert.throws(() => c.cleanMoves(bad), { code: "CONTAINERS_INVALID" }, JSON.stringify(bad));
  }
});

test("the deposit: given less collected at each type's deposit; positive the customer owes it, negative a refund", () => {
  const dep = new Map([[BOTTLE, 10], [CRATE, 0]]);
  assert.equal(c.depositOf([{ typeId: BOTTLE, given: 3, collected: 1 }, { typeId: CRATE, given: 5, collected: 0 }], dep), 20, "a crate with no deposit is worth nothing");
  assert.equal(c.depositOf([{ typeId: BOTTLE, given: 0, collected: 4 }], dep), -40);
  assert.equal(c.depositOf([{ typeId: BOTTLE, given: 1, collected: 1 }], { [BOTTLE]: 10 }), 0);
  assert.deepEqual([...c.holdings([{ typeId: BOTTLE, given: 5 }, { typeId: BOTTLE, collected: 2 }, { typeId: CRATE, given: 1 }])], [[BOTTLE, 3], [CRATE, 1]]);
});

test("what the van should bring back: the containers the loaded goods left in, less given, plus collected", () => {
  const loaded = new Map([[WATER, 40], [MILK, 30], [BREAD, 10]]);
  const moves = [{ typeId: BOTTLE, given: 12, collected: 9 }, { typeId: CRATE, given: 2, collected: 1 }];
  const expected = c.expectedOnVan({ loaded, moves }, types);
  assert.equal(expected.get(BOTTLE), 40 - 12 + 9);
  assert.equal(expected.get(CRATE), 3 - 2 + 1, "30 milk left in three crates (two full, one begun)");

  const rows = c.countRows(expected, new Map([[BOTTLE, 34], [CRATE, 2]]), types);
  assert.deepEqual(rows.map((r) => [r.name, r.expected, r.counted, r.difference, r.value]), [["19L bottle", 37, 34, -3, 30], ["Milk crate", 2, 2, 0, 0]], "three bottles short at 10 each; a crate with no deposit is worth nothing");
  assert.equal(c.countRows(expected, new Map(), types)[0].difference, 0, "a type not counted is taken as found");
  assert.equal(c.countRows(expected, new Map([[BOTTLE, 40]]), types)[0].value, 0, "more than expected is never charged");
});
