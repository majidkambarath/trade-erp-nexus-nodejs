// A customer's documents joined into deals, from real quotations, orders and delivery notes in a
// throwaway database (random name, dropped afterwards).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let svc;
let ymd;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  const { todayInDubai, addDays } = require("../../utils/documentExpiry");
  ymd = (n = 0) => addDays(todayInDubai(), n);
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Tx: require("../orderPurchase/transactionService"),
    Q: require("../orderPurchase/quotationService"),
    D: require("../orderPurchase/deliveryNoteService"),
    Flow: require("../orderPurchase/documentFlowService"),
    Stock: require("../../models/modules/stockModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

let vendor, ann, bob, rice;
const L = (qty, price) => ({ itemId: rice._id, description: "Rice", qty, price, rate: price, vatPercent: 5 });
const dealOf = (flow, pick) => {
  const found = flow.chains.filter(pick);
  assert.equal(found.length, 1, `expected one matching deal, found ${found.length}`);
  return found[0];
};

test("setup", { skip }, async () => {
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Vend", contactPerson: "x", address: "y" });
  ann = await svc.Customer.create({ customerId: "C1", customerName: "Ann Trading", contactPerson: "Ann" });
  bob = await svc.Customer.create({ customerId: "C2", customerName: "Bob Stores", contactPerson: "Bob" });
  rice = await svc.Stock.create({ itemId: "ITM1", sku: "SKU1", itemName: "Rice", category: new mongoose.Types.ObjectId() });
  const buy = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [{ itemId: rice._id, description: "Rice", qty: 500, price: 10, rate: 10, vatPercent: 5 }] }, "t");
  await svc.Tx.processTransaction(buy._id, "approve", "t");
});

test("every kind of deal for one customer, each as one chain, and nobody else's documents", { skip }, async () => {
  // 1. order first: offer -> order -> a delivery against it -> approved (the invoice)
  const q1 = await svc.Q.create({ partyId: ann._id, validUntil: ymd(30), items: [L(10, 20)] }, "t");
  await svc.Q.transition(q1._id, "send", {}, "t");
  const { salesOrder: so1 } = await svc.Q.convertToSalesOrder(q1._id, {}, "t");
  const dn1 = await svc.D.create({ sourceTransactionId: so1._id, items: [{ sourceLineId: so1.items[0]._id, qty: 10 }] }, "t");
  await svc.D.deliver(dn1._id, { receivedBy: "Ann" }, "t");
  await svc.Tx.processTransaction(so1._id, "approve", "t");

  // 2. goods first: offer -> a delivery note -> signed for -> a draft invoice raised from it
  const q2 = await svc.Q.create({ partyId: ann._id, validUntil: ymd(30), items: [L(4, 20)] }, "t");
  await svc.Q.transition(q2._id, "send", {}, "t");
  const { deliveryNote: dn2 } = await svc.D.createFromQuotation(q2._id, {}, "t");
  await svc.D.deliver(dn2._id, { receivedBy: "Ann" }, "t");
  const { salesOrder: so2 } = await svc.D.createInvoice({ deliveryNoteIds: [dn2._id] }, "t");

  // 3. an offer still out; 4. a note on its own, signed for and not invoiced
  const q3 = await svc.Q.create({ partyId: ann._id, validUntil: ymd(30), items: [L(2, 20)] }, "t");
  await svc.Q.transition(q3._id, "send", {}, "t");
  const dn4 = await svc.D.create({ partyId: ann._id, items: [L(3, 20)] }, "t");
  await svc.D.deliver(dn4._id, { receivedBy: "Ann" }, "t");

  // someone else's offer and note
  const qb = await svc.Q.create({ partyId: bob._id, validUntil: ymd(30), items: [L(1, 20)] }, "t");
  await svc.D.create({ partyId: bob._id, items: [L(1, 20)] }, "t");

  const flow = await svc.Flow.forCustomer(ann._id);
  assert.equal(flow.customer.customerName, "Ann Trading");
  assert.equal(flow.chains.length, 4, "four deals");
  assert.equal(flow.truncated, false);
  const all = JSON.stringify(flow.chains);
  assert.ok(!all.includes(qb.quotationNo), "Bob's offer is not here");

  // 1. order first, invoiced
  const d1 = dealOf(flow, (c) => c.order?._id.equals(so1._id));
  assert.equal(d1.stage, "invoiced");
  assert.equal(d1.mode, "order_first");
  assert.equal(d1.quotation.quotationNo, q1.quotationNo);
  assert.equal(d1.quotation.status, "CONVERTED");
  assert.deepEqual(d1.notes.map((n) => n.deliveryNoteNo), [dn1.deliveryNoteNo]);
  assert.equal(d1.notes[0].invoiceStatus, "INVOICED");
  assert.equal(d1.invoiceClock, null);
  assert.equal(d1.order.outstandingAmount, d1.order.totalAmount, "nothing paid yet, so it is all outstanding");

  // 2. goods first, the invoice is a draft
  const d2 = dealOf(flow, (c) => c.order?._id.equals(so2._id));
  assert.equal(d2.stage, "delivered");
  assert.equal(d2.mode, "delivery_first");
  assert.equal(d2.quotation.quotationNo, q2.quotationNo, "the offer is found through the note it became");
  assert.equal(d2.order.status, "DRAFT");
  assert.equal(d2.invoiceClock.clock, "within");

  // 3. an offer, nothing else
  const d3 = dealOf(flow, (c) => c.quotation?.quotationNo === q3.quotationNo);
  assert.equal(d3.stage, "quoted");
  assert.equal(d3.order, null);
  assert.deepEqual(d3.notes, []);

  // 4. a note on its own
  const d4 = dealOf(flow, (c) => c.notes[0]?.deliveryNoteNo === dn4.deliveryNoteNo);
  assert.equal(d4.quotation, null);
  assert.equal(d4.order, null);
  assert.equal(d4.stage, "delivered");
  assert.equal(d4.invoiceClock.clock, "within");

  // the figures above the list
  assert.deepEqual(flow.summary.outWithCustomer, { count: 1, value: q3.totalAmount });
  assert.equal(flow.summary.ordersToApprove.count, 1, "the draft invoice raised from the note");
  assert.equal(flow.summary.deliveredNotInvoiced.count, 2, "the note on its own and the one on the draft invoice");
  assert.equal(flow.summary.pastInvoiceWindow, 0);

  // Bob sees his own and none of Ann's
  const bobs = await svc.Flow.forCustomer(bob._id);
  assert.equal(bobs.chains.length, 2);
  assert.ok(!JSON.stringify(bobs.chains).includes(q3.quotationNo));
});

test("what the order becomes follows the deal: deleting the draft order puts the offer back, and deals re-form", { skip }, async () => {
  const q = await svc.Q.create({ partyId: bob._id, validUntil: ymd(30), items: [L(5, 20)] }, "t");
  await svc.Q.transition(q._id, "send", {}, "t");
  const { salesOrder } = await svc.Q.convertToSalesOrder(q._id, {}, "t");
  let flow = await svc.Flow.forCustomer(bob._id);
  const joined = flow.chains.find((c) => c.quotation?.quotationNo === q.quotationNo);
  assert.equal(joined.stage, "ordered");
  assert.equal(joined.order.transactionNo, salesOrder.transactionNo);

  await svc.Tx.deleteTransaction(salesOrder._id, "t");
  flow = await svc.Flow.forCustomer(bob._id);
  const back = flow.chains.find((c) => c.quotation?.quotationNo === q.quotationNo);
  assert.equal(back.stage, "quoted");
  assert.equal(back.order, null);
  assert.equal(back.quotation.status, "ACCEPTED");
});

test("a real part delivery: the note is signed for, and the deal still says what is left", { skip }, async () => {
  const so = await svc.Tx.createTransaction({ type: "sales_order", partyId: bob._id, partyType: "Customer", partyTypeRef: "Customer", items: [L(10, 20)] }, "t");
  const dn = await svc.D.create({ sourceTransactionId: so._id, items: [{ sourceLineId: so.items[0]._id, qty: 6 }] }, "t");
  await svc.D.deliver(dn._id, { receivedBy: "Bob", lines: [{ lineId: dn.items[0]._id, deliveredQty: 5, shortReason: "1 torn" }] }, "t");

  const flow = await svc.Flow.forCustomer(bob._id);
  const deal = dealOf(flow, (c) => c.order?._id.equals(so._id));
  assert.equal(deal.stage, "delivering", "signed for, but 5 of the 10 has gone out");
  assert.deepEqual(deal.delivery, { started: true, complete: false, remaining: [{ description: "Rice", qty: 5 }] });
  assert.equal(deal.order.items, undefined, "the lines are not sent on");

  const rest = await svc.D.create({ sourceTransactionId: so._id, items: [{ sourceLineId: so.items[0]._id, qty: 5 }] }, "t");
  await svc.D.deliver(rest._id, { receivedBy: "Bob" }, "t");
  const done = dealOf(await svc.Flow.forCustomer(bob._id), (c) => c.order?._id.equals(so._id));
  assert.equal(done.stage, "delivered");
  assert.equal(done.delivery.complete, true);
});

test("bad input is refused with a code", { skip }, async () => {
  await assert.rejects(() => svc.Flow.forCustomer("nonsense"), { code: "CUSTOMER_REQUIRED" });
  await assert.rejects(() => svc.Flow.forCustomer(new mongoose.Types.ObjectId()), { code: "CUSTOMER_NOT_FOUND" });
});
