const test = require("node:test");
const assert = require("node:assert/strict");
const { planCloseShort, trimmedLines, shortLines } = require("../closeShort");
const { buildFlow } = require("../documentFlow");

// ---- fixtures ----
const RICE = "line-rice";
const OIL = "line-oil";
const order = (over = {}) => ({
  _id: "o1", type: "sales_order", transactionNo: "SO-2026-0001", status: "DRAFT", totalAmount: 189, date: "2026-10-02",
  items: [
    { _id: RICE, itemId: "i1", description: "Rice", qty: 10, price: 10, lineTotal: 105 },
    { _id: OIL, itemId: "i2", description: "Oil", qty: 4, price: 20, lineTotal: 84 },
  ],
  ...over,
});
const note = (no, status, lines) => ({ deliveryNoteNo: no, status, items: lines.map(([sourceLineId, qty, deliveredQty]) => ({ sourceLineId, qty, deliveredQty })) });
const code = (r) => r.blocked?.code;

// ===================================== when it is refused =====================================

test("only a live sales order can be closed short", () => {
  assert.equal(code(planCloseShort(null, [])), "ORDER_NOT_FOUND");
  assert.equal(code(planCloseShort(order({ type: "purchase_order" }), [])), "ORDER_NOT_FOUND");
  assert.equal(code(planCloseShort(order({ isOpening: true }), [note("D1", "DELIVERED", [[RICE, 5, 5]])])), "ORDER_NOT_DELIVERABLE");
  for (const status of ["REJECTED", "CANCELLED"]) {
    assert.equal(code(planCloseShort(order({ status }), [note("D1", "DELIVERED", [[RICE, 5, 5]])])), "ORDER_NOT_OPEN");
  }
});

test("it is done once", () => {
  const closed = order({ closedShort: { at: new Date("2026-10-05") } });
  assert.equal(code(planCloseShort(closed, [note("D1", "DELIVERED", [[RICE, 5, 5]])])), "ALREADY_CLOSED_SHORT");
});

test("a note still on the road blocks it: what was delivered is not known yet", () => {
  const r = planCloseShort(order(), [note("DLN-1", "DELIVERED", [[RICE, 5, 5]]), note("DLN-2", "DISPATCHED", [[RICE, 2]]), note("DLN-3", "DRAFT", [[OIL, 1]])]);
  assert.equal(code(r), "OPEN_DELIVERY");
  assert.match(r.blocked.message, /DLN-2, DLN-3 are not signed for yet/);
  assert.match(planCloseShort(order(), [note("DLN-9", "DRAFT", [[RICE, 1]])]).blocked.message, /DLN-9 is not signed for yet/);
});

test("an order nothing was delivered against is rejected or cancelled, not closed short", () => {
  assert.equal(code(planCloseShort(order(), [])), "NOTHING_DELIVERED");
  assert.equal(code(planCloseShort(order(), [note("D1", "CANCELLED", [[RICE, 5]])])), "NOTHING_DELIVERED", "a cancelled note delivered nothing");
  assert.equal(code(planCloseShort(order(), [note("D1", "DELIVERED", [[RICE, 5, 0]])])), "NOTHING_DELIVERED", "signed for, but the customer took none of it");
});

test("an order that was delivered in full has nothing left to close", () => {
  const r = planCloseShort(order(), [note("D1", "DELIVERED", [[RICE, 10, 10], [OIL, 4, 4]])]);
  assert.equal(code(r), "NOTHING_LEFT");
});

// ===================================== what it works out =====================================

test("each line's shortfall and the share of its total that was never delivered", () => {
  const r = planCloseShort(order(), [note("D1", "DELIVERED", [[RICE, 6, 6], [OIL, 4, 4]])]);
  assert.equal(r.blocked, undefined);
  assert.equal(r.trim, true, "a draft is cut down");
  const rice = r.lines.find((l) => l.lineId === RICE);
  assert.deepEqual({ ordered: rice.ordered, delivered: rice.delivered, short: rice.short, valueShort: rice.valueShort }, { ordered: 10, delivered: 6, short: 4, valueShort: 42 });
  assert.equal(r.lines.find((l) => l.lineId === OIL).short, 0);
  assert.equal(r.valueShort, 42, "4 of 10 rice at 105 including VAT");
  assert.deepEqual(shortLines(r).map((l) => l.description), ["Rice"], "only what fell short is listed");
});

test("what the customer signed for counts, not what the note was written for", () => {
  // the note said 6, the customer accepted 5: 5 delivered, 5 short
  const r = planCloseShort(order(), [note("D1", "DELIVERED", [[RICE, 6, 5], [OIL, 4, 4]])]);
  assert.equal(r.lines.find((l) => l.lineId === RICE).delivered, 5);
  assert.equal(r.lines.find((l) => l.lineId === RICE).short, 5);
});

test("several notes add up, and a cancelled one is ignored", () => {
  const r = planCloseShort(order(), [note("D1", "DELIVERED", [[RICE, 3, 3]]), note("D2", "DELIVERED", [[RICE, 2, 2]]), note("D3", "CANCELLED", [[RICE, 9]])]);
  assert.equal(r.lines.find((l) => l.lineId === RICE).delivered, 5);
  assert.equal(r.lines.find((l) => l.lineId === RICE).short, 5);
  assert.equal(r.lines.find((l) => l.lineId === OIL).short, 4, "nothing of the oil went out");
  assert.equal(r.valueShort, 136.5, "5 of 10 rice (52.50) and all 4 oil (84)");
});

test("an approved order is not cut down: it is already invoiced in full", () => {
  const r = planCloseShort(order({ status: "APPROVED" }), [note("D1", "DELIVERED", [[RICE, 6, 6]])]);
  assert.equal(r.blocked, undefined);
  assert.equal(r.trim, false);
});

test("quantities are kept to three places", () => {
  const o = order({ items: [{ _id: RICE, itemId: "i1", description: "Rice", qty: 1, price: 10, lineTotal: 10.5 }] });
  const r = planCloseShort(o, [note("D1", "DELIVERED", [[RICE, 0.3333, 0.3333]])]);
  assert.equal(r.lines[0].short, 0.667);
});

// ===================================== the lines a draft is left with =====================================

test("a draft keeps what was delivered, at the delivered quantity, and loses what was not", () => {
  const o = order({
    items: [
      { _id: RICE, itemId: "i1", description: "Rice", qty: 10, price: 10, lineTotal: 105 },
      { _id: OIL, itemId: "i2", description: "Oil", qty: 4, price: 20, lineTotal: 84 },
      { _id: "line-milk", itemId: "i3", description: "Milk", qty: 8, price: 5, lineTotal: 42 },
    ],
  });
  const plan = planCloseShort(o, [note("D1", "DELIVERED", [[RICE, 6, 6], [OIL, 4, 4]])]);
  const seen = [];
  const lines = trimmedLines(o, plan, (line, qty) => {
    seen.push([line._id, qty]);
    return { _id: line._id, qty };
  });
  assert.deepEqual(lines, [{ _id: RICE, qty: 6 }, { _id: OIL, qty: 4 }], "rice cut to 6, oil whole, milk gone");
  assert.deepEqual(seen, [[RICE, 6], [OIL, 4]]);
});

// ===================================== how the deal reads it =====================================

const flowOf = (docs) => buildFlow(docs, new Date("2026-10-06T08:00:00Z"));
const so = (over = {}) => ({ _id: "o1", transactionNo: "SO-2026-0001", status: "APPROVED", date: "2026-10-02", totalAmount: 189, items: order().items, ...over });
const dn = (n, over = {}) => ({ _id: `d${n}`, deliveryNoteNo: `DLN-2026-000${n}`, status: "DELIVERED", date: "2026-10-03", deliveredAt: "2026-10-04T08:00:00Z", totalAmount: 50, invoiceStatus: "INVOICED", source: { kind: "sales_order", id: "o1" }, invoice: { id: "o1" }, items: [{ sourceLineId: RICE, qty: 6, deliveredQty: 6 }, { sourceLineId: OIL, qty: 4, deliveredQty: 4 }], ...over });
const closed = (over = {}) => ({ at: new Date("2026-10-05T08:00:00Z"), reason: "Customer found another supplier", trimmed: false, valueShort: 42, lines: [{ description: "Rice", ordered: 10, delivered: 6, short: 4, valueShort: 42 }], ...over });

test("without closing, a part-delivered order still has goods to deliver", () => {
  const c = flowOf({ orders: [so()], notes: [dn(1)] }).chains[0];
  assert.equal(c.delivery.complete, false);
  assert.deepEqual(c.delivery.remaining, [{ description: "Rice", qty: 4 }]);
  assert.equal(c.closeShort, null);
});

test("closed short, the delivery is finished and the deal says what fell short", () => {
  const c = flowOf({ orders: [so({ closedShort: closed() })], notes: [dn(1)] }).chains[0];
  assert.equal(c.delivery.complete, true);
  assert.deepEqual(c.delivery.remaining, []);
  assert.deepEqual(c.closeShort.left, [{ description: "Rice", qty: 4 }]);
  assert.equal(c.closeShort.reason, "Customer found another supplier");
  assert.equal(c.closeShort.valueShort, 42);
  assert.equal(c.stage, "invoiced", "an approved order is still the invoice");
});

test("an invoiced order closed short is owed a sales return until an approved one exists", () => {
  const withReturns = (returns) => flowOf({ orders: [so({ closedShort: closed() })], notes: [dn(1)], returns }).chains[0].closeShort;
  assert.equal(withReturns([]).creditDue, true);
  const draft = withReturns([{ _id: "r1", transactionNo: "SR-2026-0001", status: "DRAFT", totalAmount: 42, returnOf: { transactionId: "o1" } }]);
  assert.equal(draft.creditDue, true, "a draft return has not put the books right");
  assert.equal(draft.returns.length, 1);
  const done = withReturns([{ _id: "r1", transactionNo: "SR-2026-0001", status: "APPROVED", totalAmount: 42, returnOf: { transactionId: "o1" } }]);
  assert.equal(done.creditDue, false);
  assert.equal(withReturns([{ _id: "r2", transactionNo: "SR-2026-0002", status: "APPROVED", totalAmount: 9, returnOf: { transactionId: "someone-elses" } }]).returns.length, 0, "another order's return is not this one's");
});

test("a draft that was cut down is not owed anything: it simply bills what went out", () => {
  const trimmedOrder = so({ status: "DRAFT", totalAmount: 147, items: [{ _id: RICE, qty: 6 }, { _id: OIL, qty: 4 }], closedShort: closed({ trimmed: true }) });
  const c = flowOf({ orders: [trimmedOrder], notes: [dn(1, { invoiceStatus: "DRAFT" })] }).chains[0];
  assert.equal(c.closeShort.creditDue, false);
  assert.equal(c.stage, "delivered", "everything agreed is signed for; the invoice is what is left");
});

test("a closed order with a zero value short is not owed a return", () => {
  const c = flowOf({ orders: [so({ closedShort: closed({ valueShort: 0 }) })], notes: [dn(1)] }).chains[0];
  assert.equal(c.closeShort.creditDue, false);
});
