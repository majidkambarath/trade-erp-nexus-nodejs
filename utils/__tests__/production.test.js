// Pure rules of a production (utils/production.js): validation, totals, the ledger lines and the cost report.
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../production");

const A = "a".repeat(24), B = "b".repeat(24), C = "c".repeat(24), X = "e".repeat(24), Y = "f".repeat(24);
const codes = (input) => P.validate(input).map((e) => e.code);

test("validate: a finished item, a quantity, and at least one material or cost", () => {
  assert.deepEqual(codes({ finished: { stockId: A, qty: 1 }, materials: [{ stockId: B, qty: 1 }] }), []);
  assert.deepEqual(codes({ finished: { stockId: A, qty: 2 }, costs: [{ accountId: X, amount: 50 }] }), [], "costs alone are a production too");
  assert.deepEqual(codes({}), ["FINISHED_ITEM_REQUIRED", "INVALID_QTY", "NOTHING_TO_PRODUCE"]);
  assert.deepEqual(codes({ finished: { stockId: A, qty: 0 }, materials: [{ stockId: B, qty: 1 }] }), ["INVALID_QTY"]);
  assert.deepEqual(codes({ finished: { stockId: A, qty: "x" }, materials: [{ stockId: B, qty: 1 }] }), ["INVALID_QTY"]);
});

test("validate: lines", () => {
  const f = { stockId: A, qty: 1 };
  assert.deepEqual(codes({ finished: f, materials: [{ stockId: A, qty: 1 }] }), ["MATERIAL_IS_FINISHED_ITEM"], "an item cannot make itself");
  assert.deepEqual(codes({ finished: f, materials: [{ qty: 1 }] }), ["MATERIAL_ITEM_REQUIRED"]);
  assert.deepEqual(codes({ finished: f, materials: [{ stockId: B, qty: -1 }] }), ["INVALID_QTY"]);
  assert.deepEqual(codes({ finished: f, costs: [{ amount: 5 }] }), ["COST_ACCOUNT_REQUIRED"]);
  assert.deepEqual(codes({ finished: f, costs: [{ accountId: X, amount: 0 }] }), ["INVALID_AMOUNT"]);
  assert.deepEqual(codes({ finished: f, costs: [{ accountId: X, amount: 1.005 }] }), ["INVALID_AMOUNT"], "at most two decimals");
  assert.deepEqual(codes({ finished: f, costs: [{ accountId: X, amount: "" }] }), ["INVALID_AMOUNT"]);
  const errors = P.validate({ finished: f, materials: [{ stockId: B, qty: 1 }, { stockId: C, qty: 0 }] });
  assert.equal(errors[0].field, "materials.1.qty", "the message names the line");
});

test("mergeMaterials: the same item twice is one line", () => {
  assert.deepEqual(P.mergeMaterials([{ stockId: B, qty: 1.5 }, { stockId: C, qty: 2 }, { stockId: B, qty: 0.25 }]).map((m) => [m.stockId, m.qty]), [[B, 1.75], [C, 2]]);
  assert.deepEqual(P.mergeMaterials([{ stockId: { _id: B }, qty: 1 }]).map((m) => m.stockId), [B], "a populated id is read as its id");
});

test("totals: materials + costs, spread over the quantity made", () => {
  // the Brivox case: raw item 50 + travelling 50 + coating powder 50 + packing 20 = 170 for one unit
  const costs = [{ amount: 50 }, { amount: 50 }, { amount: 20 }];
  assert.deepEqual(P.totals({ materialCosts: [50], costs, qty: 1 }), { materials: 50, costs: 120, total: 170, unitCost: 170 });
  assert.deepEqual(P.totals({ materialCosts: [50], costs, qty: 3 }).unitCost, 56.66667, "the rate keeps the costing engine's places");
  assert.deepEqual(P.totals({ materialCosts: [], costs: [], qty: 0 }), { materials: 0, costs: 0, total: 0, unitCost: 0 });
  assert.equal(P.totals({ materialCosts: [0.1, 0.2], costs: [], qty: 1 }).materials, 0.3, "rounded to the fils");
});

test("ledgerLines: Dr Inventory the whole cost, Cr Inventory the materials, Cr costs-moved-to-stock each cost", () => {
  const lines = P.ledgerLines({
    inventoryAccountId: "INV", absorbedAccountId: "ABS", materialsCost: 50, productionNo: "PRD-2026-0001", itemName: "Coated part", qty: 1,
    costs: [{ accountName: "Travelling", amount: 50 }, { accountName: "Coating powder", amount: 50, narration: "2 kg" }, { accountName: "Packing", amount: 20 }],
  });
  assert.deepEqual(lines.map((l) => [l.accountId, l.debit, l.credit]), [["INV", 170, 0], ["INV", 0, 50], ["ABS", 0, 50], ["ABS", 0, 50], ["ABS", 0, 20]]);
  assert.match(lines[3].narration, /^Coating powder moved to stock: production PRD-2026-0001: Coated part x 1 - 2 kg$/);
  const dr = lines.reduce((s, l) => s + l.debit, 0), cr = lines.reduce((s, l) => s + l.credit, 0);
  assert.equal(dr, cr);
});

test("ledgerLines: materials only post no costs line, nothing at all posts nothing", () => {
  const lines = P.ledgerLines({ inventoryAccountId: "INV", absorbedAccountId: null, materialsCost: 30, costs: [], productionNo: "PRD-1", itemName: "x", qty: 1 });
  assert.deepEqual(lines.map((l) => [l.debit, l.credit]), [[30, 0], [0, 30]], "Inventory in and out: net nothing, but the movement is on record");
  assert.deepEqual(P.ledgerLines({ inventoryAccountId: "INV", materialsCost: 0, costs: [], productionNo: "PRD-1", itemName: "x", qty: 1 }), []);
});

test("costReport: posted productions by the item they made, with materials and costs by account", () => {
  const prod = (no, status, qty, materials, costs) => ({
    _id: no, productionNo: no, status, date: new Date("2026-10-17"),
    finished: { stockId: A, itemId: "FIN", itemName: "Coated part", qty },
    materials, costs,
    totals: P.totals({ materialCosts: materials.map((m) => m.cost), costs, qty }),
  });
  const report = P.costReport([
    prod("PRD-1", "POSTED", 1, [{ stockId: B, itemName: "Raw part", qty: 1, cost: 50 }], [{ accountId: X, accountName: "Travelling", amount: 50 }, { accountId: Y, accountName: "Packing", amount: 20 }]),
    prod("PRD-2", "POSTED", 2, [{ stockId: B, itemName: "Raw part", qty: 2, cost: 100 }], [{ accountId: X, accountName: "Travelling", amount: 30 }]),
    prod("PRD-3", "REVERSED", 5, [{ stockId: B, itemName: "Raw part", qty: 5, cost: 250 }], []),
    prod("PRD-4", "DRAFT", 5, [{ stockId: B, itemName: "Raw part", qty: 5, cost: 250 }], []),
  ]);
  assert.equal(report.items.length, 1);
  const r = report.items[0];
  assert.deepEqual([r.count, r.qty, r.materials, r.costs, r.total, r.unitCost], [2, 3, 150, 100, 250, 83.33333]);
  assert.deepEqual(r.materialLines.map((m) => [m.itemName, m.qty, m.cost]), [["Raw part", 3, 150]]);
  assert.deepEqual(r.costLines.map((c) => [c.accountName, c.amount]), [["Travelling", 80], ["Packing", 20]], "largest first");
  assert.deepEqual(r.productions.map((p) => p.productionNo), ["PRD-1", "PRD-2"]);
  assert.deepEqual(report.totals, { materials: 150, costs: 100, total: 250 });
});
