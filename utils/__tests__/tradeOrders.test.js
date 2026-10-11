const test = require("node:test");
const assert = require("node:assert/strict");
const { ORDER_ACTIONS, RECEIPT_ACTIONS, orderProgress, progressLabel, overBilled } = require("../tradeOrders");

const order = [{ _id: "l1", qty: 100 }, { _id: "l2", qty: 10 }];

test("an order with no receipts is not received and not invoiced", () => {
  const p = orderProgress(order, []);
  assert.equal(p.receiving, "NONE");
  assert.equal(p.invoicing, "NONE");
  assert.deepEqual(p.totals, { ordered: 110, received: 0, invoiced: 0 });
  assert.equal(p.lines.l1.toReceive, 100);
  assert.equal(progressLabel(p, "purchase"), "Not received");
  assert.equal(progressLabel(p, "sales"), "Not delivered");
});

test("a draft receipt is on the way: it takes up the order but is not received", () => {
  const p = orderProgress(order, [{ sourceLineId: "l1", status: "DRAFT", qty: 40 }]);
  assert.equal(p.lines.l1.onTheWay, 40);
  assert.equal(p.lines.l1.received, 0);
  assert.equal(p.lines.l1.toReceive, 60);
  assert.equal(p.receiving, "NONE");
});

test("what was received is what the confirmed receipt says, which can be short of what was expected", () => {
  const p = orderProgress(order, [
    { sourceLineId: "l1", status: "RECEIVED", qty: 40, receivedQty: 35, invoiceStatus: "NONE" },
    { sourceLineId: "l1", status: "RECEIVED", qty: 20, receivedQty: 20, invoiceStatus: "NONE" },
  ]);
  assert.equal(p.lines.l1.received, 55);
  assert.equal(p.lines.l1.toReceive, 45);
  assert.equal(p.lines.l1.toInvoice, 55);
  assert.equal(p.receiving, "PART");
  assert.equal(progressLabel(p), "Partly received");
});

test("billed quantity comes only from receipts on an approved invoice; a draft invoice holds its quantity", () => {
  const p = orderProgress(order, [
    { sourceLineId: "l1", status: "RECEIVED", qty: 100, receivedQty: 100, invoiceStatus: "INVOICED" },
    { sourceLineId: "l2", status: "RECEIVED", qty: 10, receivedQty: 10, invoiceStatus: "DRAFT" },
  ]);
  assert.equal(p.lines.l1.invoiced, 100);
  assert.equal(p.lines.l2.invoiced, 0);
  assert.equal(p.lines.l2.draftInvoice, 10);
  assert.equal(p.lines.l2.toInvoice, 0, "already on a draft invoice, so not offered again");
  assert.equal(p.receiving, "ALL");
  assert.equal(p.invoicing, "PART");
  assert.equal(progressLabel(p), "Partly invoiced");
});

test("fully invoiced", () => {
  const p = orderProgress(order, [
    { sourceLineId: "l1", status: "RECEIVED", qty: 100, receivedQty: 100, invoiceStatus: "INVOICED" },
    { sourceLineId: "l2", status: "RECEIVED", qty: 10, receivedQty: 10, invoiceStatus: "INVOICED" },
  ]);
  assert.equal(progressLabel(p), "Invoiced");
});

test("a cancelled receipt counts for nothing, and a line of another order is ignored", () => {
  const p = orderProgress(order, [
    { sourceLineId: "l1", status: "CANCELLED", qty: 100, receivedQty: 100 },
    { sourceLineId: "other", status: "RECEIVED", qty: 5, receivedQty: 5 },
  ]);
  assert.deepEqual(p.totals, { ordered: 110, received: 0, invoiced: 0 });
});

test("an invoice may bill no more of an item than was received", () => {
  const receipts = [{ itemId: "rice", receivedQty: 60 }, { itemId: "rice", receivedQty: 30 }, { itemId: "oil", receivedQty: 5 }];
  assert.deepEqual(overBilled([{ itemId: "rice", qty: 90 }, { itemId: "oil", qty: 5 }], receipts), []);
  assert.deepEqual(overBilled([{ itemId: "rice", qty: 91 }], receipts), [{ itemId: "rice", billed: 91, received: 90 }]);
  assert.deepEqual(overBilled([{ itemId: "sugar", qty: 1 }], receipts), [{ itemId: "sugar", billed: 1, received: 0 }]);
  // the same item on two lines is added up
  assert.equal(overBilled([{ itemId: "oil", qty: 3 }, { itemId: "oil", qty: 3 }], receipts).length, 1);
});

test("the action tables say where each can start", () => {
  assert.deepEqual(ORDER_ACTIONS.confirm.from, ["DRAFT"]);
  assert.ok(ORDER_ACTIONS.cancel.from.includes("CONFIRMED"));
  assert.deepEqual(RECEIPT_ACTIONS.receive.from, ["DRAFT"]);
  assert.ok(RECEIPT_ACTIONS.cancel.from.includes("RECEIVED"));
});
