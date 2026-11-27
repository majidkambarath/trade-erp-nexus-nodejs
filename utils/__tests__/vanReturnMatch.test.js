// Which invoices returned goods are credited against (utils/vanReturnMatch.js). Pure.
const test = require("node:test");
const assert = require("node:assert/strict");
const { matchReturnLines } = require("../vanReturnMatch");

const line = (lineId, stockId, remaining, price = 10) => ({ lineId, stockId, remaining, price });
const inv = (id, date, lines, createdAt = `${date}T10:00:00Z`) => ({ id, number: `SO-${id}`, date: `${date}T00:00:00Z`, createdAt, lines });
const flat = (r) => ({ groups: r.groups.map((g) => [g.invoiceId, g.lines.map((l) => [l.lineId, l.qty, l.condition])]), rest: r.rest.map((x) => [x.stockId, x.qty, x.condition]) });

test("the newest invoice that carried the item is credited first, then older ones", () => {
  const r = matchReturnLines([{ stockId: "milk", qty: 8, condition: "expired" }], [
    inv("1", "2026-11-01", [line("a", "milk", 10)]),
    inv("2", "2026-11-20", [line("b", "milk", 5)]),
  ]);
  assert.deepEqual(flat(r), { groups: [["2", [["b", 5, "expired"]]], ["1", [["a", 3, "expired"]]]], rest: [] });
});

test("only what can still come back on a line, and what no invoice covers is left over", () => {
  const r = matchReturnLines([{ stockId: "milk", qty: 9, condition: "good" }, { stockId: "juice", qty: 2, condition: "damaged" }], [
    inv("1", "2026-11-01", [line("a", "milk", 4)]),
    inv("2", "2026-11-02", [line("b", "milk", 0), line("c", "rice", 7)]),
  ]);
  assert.deepEqual(flat(r), { groups: [["1", [["a", 4, "good"]]]], rest: [["milk", 5, "good"], ["juice", 2, "damaged"]] });
});

test("two conditions of one item share a line's remainder, in the order they are given", () => {
  const r = matchReturnLines([{ stockId: "milk", qty: 3, condition: "good" }, { stockId: "milk", qty: 4, condition: "expired" }], [inv("1", "2026-11-01", [line("a", "milk", 5)])]);
  assert.deepEqual(flat(r), { groups: [["1", [["a", 3, "good"], ["a", 2, "expired"]]]], rest: [["milk", 2, "expired"]] });
});

test("an invoice's paid lines come before its free goods, and the same day is ordered by when each was made", () => {
  const r = matchReturnLines([{ stockId: "milk", qty: 6, condition: "good" }], [
    inv("old", "2026-11-05", [line("o", "milk", 9)], "2026-11-05T08:00:00Z"),
    inv("new", "2026-11-05", [line("free", "milk", 1, 0), line("paid", "milk", 4)], "2026-11-05T16:00:00Z"),
  ]);
  assert.deepEqual(flat(r), { groups: [["new", [["paid", 4, "good"], ["free", 1, "good"]]], ["old", [["o", 1, "good"]]]], rest: [] });
});

test("fractions add up exactly, and nothing asked for gives nothing", () => {
  const r = matchReturnLines([{ stockId: "rice", qty: 0.3, condition: "good" }], [inv("1", "2026-11-01", [line("a", "rice", 0.1), line("b", "rice", 0.2)])]);
  assert.deepEqual(flat(r), { groups: [["1", [["a", 0.1, "good"], ["b", 0.2, "good"]]]], rest: [] });
  assert.deepEqual(matchReturnLines([], []), { groups: [], rest: [] });
  assert.deepEqual(flat(matchReturnLines([{ stockId: "x", qty: 1, condition: "good" }], [])), { groups: [], rest: [["x", 1, "good"]] });
});
