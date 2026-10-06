const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFlow } = require("../documentFlow");

const NOW = new Date("2026-10-06T08:00:00Z");
const q = (n, over = {}) => ({ _id: `q${n}`, quotationNo: `QT-2026-000${n}`, status: "SENT", date: "2026-10-01", validUntil: new Date("2026-11-01"), totalAmount: 100 * n, ...over });
const o = (n, over = {}) => ({ _id: `o${n}`, transactionNo: `SO-2026-000${n}`, status: "DRAFT", date: "2026-10-02", totalAmount: 200 * n, ...over });
const d = (n, over = {}) => ({ _id: `d${n}`, deliveryNoteNo: `DLN-2026-000${n}`, status: "DELIVERED", date: "2026-10-03", deliveredAt: "2026-10-04T08:00:00Z", totalAmount: 50 * n, invoiceStatus: "NONE", source: { kind: "manual" }, ...over });
const flow = (docs) => buildFlow(docs, NOW);
const only = (r) => { assert.equal(r.chains.length, 1, `expected one deal, got ${r.chains.length}`); return r.chains[0]; };

test("quotation -> order -> notes is one deal, and the approved order is the invoice", () => {
  const r = flow({
    quotations: [q(1, { status: "CONVERTED", convertedTo: { kind: "sales_order", id: "o1" } })],
    orders: [o(1, { status: "APPROVED", quoteRef: "QT-2026-0001" })],
    notes: [d(2, { source: { kind: "sales_order", id: "o1" }, invoice: { id: "o1" }, invoiceStatus: "INVOICED", deliveredAt: "2026-10-05T08:00:00Z" }), d(1, { source: { kind: "sales_order", id: "o1" }, invoice: { id: "o1" }, invoiceStatus: "INVOICED" })],
  });
  const c = only(r);
  assert.equal(c.stage, "invoiced");
  assert.equal(c.mode, "order_first");
  assert.equal(c.quotation.quotationNo, "QT-2026-0001");
  assert.equal(c.order.transactionNo, "SO-2026-0001");
  assert.deepEqual(c.notes.map((n) => n.deliveryNoteNo), ["DLN-2026-0001", "DLN-2026-0002"], "notes in the order they were delivered");
  assert.equal(c.amount, 200, "the deal is worth its order");
  assert.equal(c.invoiceClock, null, "nothing is waiting for an invoice");
});

test("the quotation is found through the order's quoteRef or the quotation's own link", () => {
  const byRef = only(flow({ quotations: [q(1, { status: "CONVERTED" })], orders: [o(1, { quoteRef: "QT-2026-0001" })] }));
  assert.equal(byRef.quotation?.quotationNo, "QT-2026-0001");
  const byLink = only(flow({ quotations: [q(2, { status: "CONVERTED", convertedTo: { kind: "sales_order", id: "o2" } })], orders: [o(2)] }));
  assert.equal(byLink.quotation?.quotationNo, "QT-2026-0002");
});

test("goods first: quotation -> notes -> invoice is one deal, in that order", () => {
  const notes = [d(1, { source: { kind: "quotation", id: "q1" }, invoice: { id: "o1" }, invoiceStatus: "DRAFT" })];
  const quotations = [q(1, { status: "CONVERTED", convertedTo: { kind: "delivery_note", id: "d1" } })];
  const c = only(flow({ quotations, orders: [o(1, { linkedRef: "DLN-2026-0001" })], notes }));
  assert.equal(c.mode, "delivery_first");
  assert.equal(c.quotation.quotationNo, "QT-2026-0001", "found through the note, since the order carries no quoteRef");
  assert.equal(c.order.transactionNo, "SO-2026-0001");
  assert.equal(c.stage, "delivered", "signed for, the invoice is still a draft");
  assert.ok(c.invoiceClock, "and its 14-day clock is running");

  // before the invoice exists the deal is the offer and its notes, with nothing after them
  const early = only(flow({ quotations, notes: [d(1, { source: { kind: "quotation", id: "q1" } })] }));
  assert.equal(early.order, null);
  assert.equal(early.mode, "delivery_first");
  assert.equal(early.stage, "delivered");
});

test("each stage is read from what exists", () => {
  const stage = (docs) => only(flow(docs)).stage;
  assert.equal(stage({ quotations: [q(1)] }), "quoted");
  assert.equal(stage({ quotations: [q(1, { status: "DRAFT" })] }), "quoted");
  assert.equal(stage({ quotations: [q(1, { status: "ACCEPTED" })] }), "quoted");
  assert.equal(stage({ quotations: [q(1, { status: "REJECTED" })] }), "lost");
  assert.equal(stage({ quotations: [q(1, { validUntil: new Date("2026-10-01") })] }), "lapsed", "a sent offer past its date");
  assert.equal(stage({ quotations: [q(1, { status: "ACCEPTED", validUntil: new Date("2026-10-01") })] }), "quoted", "an accepted one cannot lapse");
  assert.equal(stage({ orders: [o(1)] }), "ordered");
  assert.equal(stage({ orders: [o(1)], notes: [d(1, { status: "DISPATCHED", source: { kind: "sales_order", id: "o1" } })] }), "delivering");
  assert.equal(stage({ orders: [o(1)], notes: [d(1, { source: { kind: "sales_order", id: "o1" } }), d(2, { status: "DRAFT", source: { kind: "sales_order", id: "o1" } })] }), "delivering", "one note still to go out");
  assert.equal(stage({ orders: [o(1)], notes: [d(1, { source: { kind: "sales_order", id: "o1" } })] }), "delivered");
  assert.equal(stage({ orders: [o(1, { status: "APPROVED" })] }), "invoiced");
});

test("the 14-day clock shows the worst of the notes still waiting for an invoice", () => {
  const c = only(flow({
    orders: [o(1)],
    notes: [
      d(1, { source: { kind: "sales_order", id: "o1" }, deliveredAt: "2026-10-05T08:00:00Z" }), // 1 day ago: within
      d(2, { source: { kind: "sales_order", id: "o1" }, deliveredAt: "2026-09-15T08:00:00Z" }), // 21 days ago: past 14, summary invoice still in time
    ],
  }));
  assert.equal(c.invoiceClock.clock, "pastStandard");
  assert.equal(c.invoiceClock.standardDue, "2026-09-29");
  const invoiced = only(flow({ orders: [o(1)], notes: [d(1, { source: { kind: "sales_order", id: "o1" }, deliveredAt: "2026-09-01T08:00:00Z", invoiceStatus: "INVOICED" })] }));
  assert.equal(invoiced.invoiceClock, null, "an invoiced note stops the clock however old");
});

test("an offer about to run out is flagged, and only a sent one", () => {
  assert.equal(only(flow({ quotations: [q(1, { validUntil: new Date("2026-10-09") })] })).expiresInDays, 3);
  assert.equal(only(flow({ quotations: [q(1, { validUntil: new Date("2026-12-01") })] })).expiresInDays, null);
  assert.equal(only(flow({ quotations: [q(1, { status: "ACCEPTED", validUntil: new Date("2026-10-09") })] })).expiresInDays, null);
});

test("dead documents are left out: superseded offers, cancelled notes, rejected and cancelled orders", () => {
  const r = flow({
    quotations: [q(1, { status: "SUPERSEDED" }), q(2, { quotationNo: "QT-2026-0001-R1" })],
    orders: [o(1, { status: "REJECTED" }), o(2, { status: "CANCELLED" })],
    notes: [d(1, { status: "CANCELLED" })],
  });
  assert.equal(r.chains.length, 1);
  assert.equal(r.chains[0].quotation.quotationNo, "QT-2026-0001-R1", "the revision stands for the offer it replaced");
});

test("an order that was deleted frees its offer, which is then a deal of its own", () => {
  // the quotation went back to ACCEPTED and the order is gone, so the two are no longer joined
  const r = flow({ quotations: [q(1, { status: "ACCEPTED" })], orders: [] });
  assert.equal(only(r).stage, "quoted");
  assert.equal(only(r).order, null);
});

test("a note on its own is a deal of its own", () => {
  const c = only(flow({ notes: [d(1)] }));
  assert.equal(c.quotation, null);
  assert.equal(c.order, null);
  assert.equal(c.mode, "delivery_first");
  assert.equal(c.amount, 50);
  assert.equal(c.key, "n:d1");
});

test("a document is in exactly one deal, however they are linked", () => {
  const r = flow({
    quotations: [q(1, { status: "CONVERTED", convertedTo: { kind: "delivery_note", id: "d1" } }), q(2)],
    orders: [o(1, { linkedRef: "DLN-2026-0001, DLN-2026-0002" }), o(2, { quoteRef: "QT-2026-0002" })],
    notes: [
      d(1, { source: { kind: "quotation", id: "q1" }, invoice: { id: "o1" } }),
      d(2, { invoice: { id: "o1" } }),
      d(3, { source: { kind: "sales_order", id: "o2" } }),
      d(4),
    ],
  });
  const seen = (pick) => r.chains.flatMap(pick).map(String);
  const unique = (xs) => new Set(xs).size === xs.length;
  assert.ok(unique(seen((c) => c.notes.map((n) => n._id))), "no note twice");
  assert.ok(unique(seen((c) => (c.quotation ? [c.quotation._id] : []))), "no offer twice");
  assert.ok(unique(seen((c) => (c.order ? [c.order._id] : []))), "no order twice");
  assert.equal(seen((c) => c.notes.map((n) => n._id)).length, 4, "every note is somewhere");
  assert.equal(r.chains.length, 3); // goods-first deal (q1, d1, d2, o1), order-first deal (q2, o2, d3), the lone note d4
});

test("the figures above the list agree with the deals", () => {
  const r = flow({
    quotations: [q(1, { totalAmount: 100 }), q(2, { status: "ACCEPTED", totalAmount: 300 }), q(3, { validUntil: new Date("2026-10-01"), totalAmount: 999 })],
    orders: [o(1, { totalAmount: 500 }), o(2, { status: "APPROVED", totalAmount: 700 })],
    notes: [d(1, { totalAmount: 60 }), d(2, { totalAmount: 40, invoiceStatus: "INVOICED" }), d(3, { status: "DISPATCHED", totalAmount: 80 })],
  });
  assert.deepEqual(r.summary.outWithCustomer, { count: 1, value: 100 }, "the lapsed offer is not out any more");
  assert.deepEqual(r.summary.acceptedNotOrdered, { count: 1, value: 300 });
  assert.deepEqual(r.summary.ordersToApprove, { count: 1, value: 500 });
  assert.deepEqual(r.summary.deliveredNotInvoiced, { count: 1, value: 60 }, "an invoiced note and one still on the road are not counted");
});

test("newest deal first, and nothing at all gives nothing", () => {
  const r = flow({ quotations: [q(1, { date: "2026-09-01" })], orders: [o(1, { date: "2026-10-04" })], notes: [d(1, { deliveredAt: "2026-09-20T08:00:00Z", date: "2026-09-20" })] });
  assert.deepEqual(r.chains.map((c) => c.key), ["o:o1", "n:d1", "q:q1"]);
  assert.deepEqual(flow({}).chains, []);
  assert.equal(flow({}).summary.deliveredNotInvoiced.count, 0);
});

// ---- part deliveries: a signed-for note that does not cover the order is not a finished delivery ----

const lined = (over = {}) => o(1, { items: [{ _id: "l1", qty: 10, description: "Rice" }, { _id: "l2", qty: 4, description: "Oil" }], ...over });
const sent = (n, lines, over = {}) => d(n, { source: { kind: "sales_order", id: "o1" }, items: lines, ...over });

test("a part delivery leaves the deal delivering, and says what is left", () => {
  const c = only(flow({ orders: [lined()], notes: [sent(1, [{ sourceLineId: "l1", qty: 6, deliveredQty: 6 }, { sourceLineId: "l2", qty: 4, deliveredQty: 4 }])] }));
  assert.equal(c.stage, "delivering", "every note is signed for, but 4 of the rice is still to come");
  assert.deepEqual(c.delivery, { started: true, complete: false, remaining: [{ description: "Rice", qty: 4 }] });
});

test("a delivery that covers every line is a finished delivery", () => {
  const c = only(flow({ orders: [lined()], notes: [sent(1, [{ sourceLineId: "l1", qty: 10, deliveredQty: 10 }, { sourceLineId: "l2", qty: 4, deliveredQty: 4 }])] }));
  assert.equal(c.stage, "delivered");
  assert.deepEqual(c.delivery, { started: true, complete: true, remaining: [] });
});

test("goods the customer refused at the door are still to deliver", () => {
  const c = only(flow({ orders: [lined()], notes: [sent(1, [{ sourceLineId: "l1", qty: 10, deliveredQty: 8 }, { sourceLineId: "l2", qty: 4, deliveredQty: 4 }])] }));
  assert.deepEqual(c.delivery.remaining, [{ description: "Rice", qty: 2 }]);
  assert.equal(c.stage, "delivering");
});

test("goods on a note still on the road are not left to deliver, but are not delivered either", () => {
  const c = only(flow({ orders: [lined()], notes: [sent(1, [{ sourceLineId: "l1", qty: 10 }, { sourceLineId: "l2", qty: 4 }], { status: "DISPATCHED", deliveredAt: null })] }));
  assert.equal(c.delivery.complete, true, "nothing is left to put on another note");
  assert.equal(c.stage, "delivering", "but it has not been signed for");
});

test("an order nothing has been delivered on has all of it left", () => {
  const c = only(flow({ orders: [lined()] }));
  assert.equal(c.stage, "ordered");
  assert.deepEqual(c.delivery, { started: false, complete: false, remaining: [{ description: "Rice", qty: 10 }, { description: "Oil", qty: 4 }] });
});

test("an approved order that is only part delivered stays invoiced, with the rest still to deliver", () => {
  const c = only(flow({ orders: [lined({ status: "APPROVED" })], notes: [sent(1, [{ sourceLineId: "l1", qty: 5, deliveredQty: 5 }], { invoiceStatus: "INVOICED" })] }));
  assert.equal(c.stage, "invoiced");
  assert.equal(c.delivery.complete, false);
});

test("goods first has nothing to measure against, and the order lines are not sent on", () => {
  const c = only(flow({ orders: [lined({ linkedRef: "DLN-2026-0001" })], notes: [d(1, { invoice: { id: "o1" }, items: [{ qty: 4, deliveredQty: 4 }] })] }));
  assert.equal(c.mode, "delivery_first");
  assert.equal(c.delivery, null);
  assert.equal(c.order.items, undefined, "only the figures go to the screen");
  assert.equal(c.notes[0].items, undefined);
});
