// Quotations and delivery notes against a throwaway database (random name, dropped afterwards).
//
// What these prove, beyond the rules in utils/__tests__/salesDocuments.test.js:
//   - neither document posts, moves stock or lands in the collections VAT / ageing / the dashboard read
//   - a quotation is priced by the same code as the invoice it turns into
//   - converting is atomic, and a deleted / rejected / cancelled order releases what pointed at it
//   - stock and ledger move exactly once, when the sales order is approved
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
  const { todayInOrg, addDays } = require("../../utils/documentExpiry");
  ymd = (n = 0) => addDays(todayInOrg(), n);
  const fin = require("../../models/modules/financial/financialModels");
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Tx: require("../orderPurchase/transactionService"),
    Q: require("../orderPurchase/quotationService"),
    D: require("../orderPurchase/deliveryNoteService"),
    Quotation: require("../../models/modules/quotationModel"),
    DeliveryNote: require("../../models/modules/deliveryNoteModel"),
    Transaction: require("../../models/modules/transactionModel"),
    NumberSeries: require("../../models/modules/financial/numberSeriesModel"),
    Stock: require("../../models/modules/stockModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
    LedgerEntry: fin.LedgerEntry,
    Voucher: fin.Voucher,
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

// ---- fixtures ----
let vendor, customer, other, fussy, rice, oil, milk;
// `rate` is only here because a purchase order's log requires it (the same as every other suite); the
// quotation and delivery-note code reads `price`, the unit price, and ignores it.
const L = (item, qty, price, extra = {}) => ({ itemId: item._id, description: item.itemName, qty, price, rate: price, vatPercent: 5, ...extra });
const buy = async (items) => {
  const t = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items }, "tester");
  await svc.Tx.processTransaction(t._id, "approve", "tester");
  return t;
};
const order = (party, items, extra = {}) =>
  svc.Tx.createTransaction({ type: "sales_order", partyId: party._id, partyType: "Customer", partyTypeRef: "Customer", items, ...extra }, "tester");
const approve = (t) => svc.Tx.processTransaction(t._id, "approve", "tester");
const onHand = async (item) => (await svc.Stock.findById(item._id)).currentStock;
const footprint = async () => ({
  tx: await svc.Transaction.countDocuments(),
  ledger: await svc.LedgerEntry.countDocuments(),
  vouchers: await svc.Voucher.countDocuments(),
  moves: await svc.Movement.countDocuments(),
});

test("setup", { skip }, async () => {
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Vend", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Cust", contactPerson: "Ali", phone: "0501234567", shippingAddress: "Warehouse 4, Al Quoz", paymentTerms: "Net 30" });
  other = await svc.Customer.create({ customerId: "C2", customerName: "Other", contactPerson: "x" });
  fussy = await svc.Customer.create({ customerId: "C3", customerName: "Fussy", contactPerson: "x", minShelfLifeDays: 45 });
  const category = new mongoose.Types.ObjectId();
  rice = await svc.Stock.create({ itemId: "ITM1", sku: "SKU1", itemName: "Rice", category });
  oil = await svc.Stock.create({ itemId: "ITM2", sku: "SKU2", itemName: "Oil", category });
  milk = await svc.Stock.create({ itemId: "ITM3", sku: "SKU3", itemName: "Milk", category });
  await buy([L(rice, 200, 10)]);
  await buy([L(oil, 100, 20)]);
  await buy([L(milk, 40, 5, { batchNumber: "M-OLD", expiryDate: ymd(20) })]);
  await buy([L(milk, 40, 5, { batchNumber: "M-NEW", expiryDate: ymd(120) })]);
});

// ===================================== quotations =====================================

test("quotation: own number series, priced exactly like the invoice it becomes, and posts nothing", { skip }, async () => {
  const items = () => [L(rice, 10, 20, { discountPercent: 10 }), L(oil, 3, 50)];
  const charges = [{ description: "Freight", amount: 25, vatPercent: 5 }];
  const before = await footprint();
  const q = await svc.Q.create({ partyId: customer._id, validUntil: ymd(30), reference: "RFQ-77", terms: "Prices valid 30 days", items: items(), charges, discount: 5 }, "tester");
  assert.deepEqual(await footprint(), before, "an offer writes nothing a report can read");

  assert.match(q.quotationNo, /^QT-\d{4}-0001$/);
  assert.equal(q.status, "DRAFT");
  // rice 200 - 10% = 180 + 9 VAT; oil 150 + 7.50; freight 25 + 1.25; less 5 off the total
  assert.equal(q.totalAmount, 367.75);

  const so = await order(customer, items(), { charges, discount: 5 });
  assert.equal(q.totalAmount, so.totalAmount, "same lines, same engine, same total");
  assert.equal(q.pricing.net, so.pricing.net);
  assert.equal(q.pricing.lineVat, so.pricing.lineVat);
  assert.equal(q.items[0].discountAmount, 20);
  assert.equal(q.items[0].vatAmount, 9);
  await svc.Tx.deleteTransaction(so._id, "tester");

  // QT numbers are separate from every other series, in particular DN (debit note) is untouched
  assert.equal(await svc.NumberSeries.countDocuments({ series: "DN" }), 0);
});

test("quotation: bad input is refused with a code the client can act on", { skip }, async () => {
  const ok = [L(rice, 1, 1)];
  const bad = (data, code) => assert.rejects(() => svc.Q.create({ partyId: customer._id, items: ok, ...data }, "t"), { code });
  await bad({ items: [] }, "ITEMS_REQUIRED");
  await bad({ items: [L(rice, 0, 1)] }, "INVALID_QUANTITY");
  await bad({ items: [{ ...L(rice, 1, 1), itemId: new mongoose.Types.ObjectId() }] }, "ITEM_NOT_FOUND");
  await bad({ items: [L(rice, 1, -3)] }, "INVALID_PRICE");
  await bad({ items: [L(rice, 1, 1, { discountPercent: 150 })] }, "INVALID_DISCOUNT");
  await bad({ date: ymd(0), validUntil: ymd(-1) }, "INVALID_VALIDITY");
  await assert.rejects(() => svc.Q.create({ partyId: new mongoose.Types.ObjectId(), items: ok }, "t"), { code: "CUSTOMER_NOT_FOUND" });
  await assert.rejects(() => svc.Q.create({ items: ok }, "t"), { code: "CUSTOMER_REQUIRED" });
});

test("quotation: a draft is editable, a sent one is not, and each answer needs the right state", { skip }, async () => {
  const q = await svc.Q.create({ partyId: customer._id, items: [L(rice, 10, 20)], reference: "keep me" }, "t");
  assert.equal(q.validUntil.toISOString().slice(0, 10), ymd(30), "valid for 30 days unless told otherwise");

  const edited = await svc.Q.update(q._id, { items: [L(rice, 20, 20)] }, "t");
  assert.equal(edited.totalAmount, 420);
  assert.equal(edited.reference, "keep me", "a field not sent is left alone");

  await assert.rejects(() => svc.Q.transition(q._id, "accept", {}, "t"), { code: "QUOTATION_STATE" }); // not sent yet
  const sent = await svc.Q.transition(q._id, "send", {}, "t");
  assert.equal(sent.status, "SENT");
  assert.ok(sent.sentAt);
  await assert.rejects(() => svc.Q.update(q._id, { notes: "x" }, "t"), { code: "QUOTATION_NOT_EDITABLE" });
  await assert.rejects(() => svc.Q.remove(q._id, "t"), { code: "QUOTATION_NOT_DELETABLE" });
  await assert.rejects(() => svc.Q.transition(q._id, "send", {}, "t"), { code: "QUOTATION_STATE" });

  const accepted = await svc.Q.transition(q._id, "accept", { acceptedBy: "Mr Ali, LPO 991" }, "t");
  assert.equal(accepted.status, "ACCEPTED");
  assert.equal(accepted.acceptedBy, "Mr Ali, LPO 991");
  const lost = await svc.Q.transition(q._id, "reject", { reason: "went with a cheaper supplier" }, "t");
  assert.equal(lost.status, "REJECTED", "a customer can withdraw after accepting");
  assert.equal(lost.rejectionReason, "went with a cheaper supplier");

  const view = await svc.Q.getById(q._id);
  assert.equal(view.actions.revise, true);
  assert.equal(view.actions.convert, false);
  assert.equal(view.items[0].stockDetails.itemName, "Rice", "lines carry what a printed copy needs");
  assert.equal(view.party.customerName, "Cust");
});

test("quotation: a sent offer lapses by its date, is reported EXPIRED, and cannot be accepted or converted", { skip }, async () => {
  // an offer already past its validity cannot go out
  const stale = await svc.Q.create({ partyId: customer._id, date: ymd(-10), validUntil: ymd(-5), items: [L(rice, 1, 1)] }, "t");
  await assert.rejects(() => svc.Q.transition(stale._id, "send", {}, "t"), { code: "QUOTATION_EXPIRED" });

  const q = await svc.Q.create({ partyId: customer._id, validUntil: ymd(10), items: [L(rice, 2, 20)] }, "t");
  await svc.Q.transition(q._id, "send", {}, "t");
  assert.equal((await svc.Q.getById(q._id)).displayStatus, "SENT");

  await svc.Quotation.updateOne({ _id: q._id }, { validUntil: new Date(ymd(-1)) }); // time passes
  const view = await svc.Q.getById(q._id);
  assert.equal(view.displayStatus, "EXPIRED");
  assert.equal(view.expired, true);
  assert.equal(view.status, "SENT", "stored state is untouched; expiry is read from the date");
  assert.equal(view.actions.accept, false);
  assert.equal(view.actions.convert, false);
  assert.equal(view.actions.revise, true);
  await assert.rejects(() => svc.Q.transition(q._id, "accept", {}, "t"), { code: "QUOTATION_EXPIRED" });
  await assert.rejects(() => svc.Q.convertToSalesOrder(q._id, {}, "t"), { code: "QUOTATION_EXPIRED" });
  await assert.rejects(() => svc.D.createFromQuotation(q._id, {}, "t"), { code: "QUOTATION_EXPIRED" });

  const ids = (r) => r.rows.map((x) => String(x._id));
  assert.ok(ids(await svc.Q.list({ status: "EXPIRED" })).includes(String(q._id)));
  assert.ok(!ids(await svc.Q.list({ status: "SENT" })).includes(String(q._id)), "SENT means still open");
  const sum = await svc.Q.summary();
  assert.ok(sum.byStatus.EXPIRED.count >= 1);
  assert.equal(typeof sum.expiringSoon.count, "number");
  assert.equal(sum.byStatus.SENT?.count ?? 0, 0, "the lapsed one is counted once, as EXPIRED");

  // revising is how it goes out again
  const { revision, superseded } = await svc.Q.revise(q._id, "t");
  assert.equal(revision.quotationNo, `${q.quotationNo}-R1`);
  assert.equal(revision.revision, 1);
  assert.equal(revision.status, "DRAFT");
  assert.equal(revision.validUntil.toISOString().slice(0, 10), ymd(30));
  assert.equal(superseded.status, "SUPERSEDED");
  assert.equal(String(superseded.supersededBy.id), String(revision._id));
  assert.equal(revision.totalAmount, q.totalAmount);
});

test("quotation: revisions chain from one base number, and discarding one puts the original back", { skip }, async () => {
  const q = await svc.Q.create({ partyId: customer._id, items: [L(rice, 1, 10)] }, "t");
  await assert.rejects(() => svc.Q.revise(q._id, "t"), { code: "QUOTATION_STATE" }); // a draft is simply edited
  await svc.Q.transition(q._id, "send", {}, "t");

  const r1 = (await svc.Q.revise(q._id, "t")).revision;
  await svc.Q.transition(r1._id, "send", {}, "t");
  const r2 = (await svc.Q.revise(r1._id, "t")).revision;
  assert.equal(r2.quotationNo, `${q.quotationNo}-R2`, "the suffix never stacks");
  assert.equal(String(r2.revisionOf.id), String(r1._id));

  await assert.rejects(() => svc.Q.revise(q._id, "t"), { code: "QUOTATION_STATE" }); // already superseded
  await svc.Q.remove(r2._id, "t"); // discard the draft revision
  assert.equal((await svc.Quotation.findById(r1._id)).status, "SENT", "the offer it replaced is live again");
  assert.equal((await svc.Quotation.findById(r1._id)).supersededBy, undefined);
});

test("quotation: converting makes one draft sales order, atomically, and releases it if the order goes away", { skip }, async () => {
  const q = await svc.Q.create({ partyId: customer._id, reference: "RFQ-9", validUntil: ymd(30), items: [L(rice, 5, 20), L(oil, 2, 50, { discountPercent: 10 })], terms: "Net 30" }, "t");
  await assert.rejects(() => svc.Q.convertToSalesOrder(q._id, {}, "t"), { code: "QUOTATION_STATE" }); // a draft was never offered
  await svc.Q.transition(q._id, "send", {}, "t");

  // a failure inside the order (no fiscal year covers 2015) rolls the whole thing back
  const before = await footprint();
  await assert.rejects(() => svc.Q.convertToSalesOrder(q._id, { date: "2015-01-05" }, "t"), { code: "NO_FISCAL_YEAR" });
  assert.equal((await svc.Quotation.findById(q._id)).status, "SENT", "the offer is untouched");
  assert.equal((await footprint()).tx, before.tx, "and no half-made order is left behind");

  const stock0 = await onHand(rice);
  const { quotation, salesOrder } = await svc.Q.convertToSalesOrder(q._id, {}, "t");
  assert.equal(salesOrder.status, "DRAFT");
  assert.equal(salesOrder.quoteRef, q.quotationNo);
  assert.equal(salesOrder.lpono, "RFQ-9");
  assert.equal(salesOrder.totalAmount, q.totalAmount);
  assert.deepEqual(salesOrder.items.map((i) => [i.qty, i.price, i.discountAmount, i.lineTotal]), q.items.map((i) => [i.qty, i.price, i.discountAmount, i.lineTotal]));
  assert.equal(quotation.status, "CONVERTED");
  assert.equal(quotation.convertedTo.no, salesOrder.transactionNo);
  assert.ok(quotation.acceptedAt, "ordering is accepting");
  assert.equal(await onHand(rice), stock0, "a draft order moves no stock");

  await assert.rejects(() => svc.Q.convertToSalesOrder(q._id, {}, "t"), { code: "QUOTATION_STATE" });
  await assert.rejects(() => svc.Q.revise(q._id, "t"), { code: "QUOTATION_STATE" });

  // the order is deleted: the offer is open again, and can be converted again
  await svc.Tx.deleteTransaction(salesOrder._id, "t");
  const released = await svc.Quotation.findById(q._id);
  assert.equal(released.status, "ACCEPTED");
  assert.equal(released.convertedTo, undefined);
  const again = await svc.Q.convertToSalesOrder(q._id, {}, "t");
  assert.notEqual(again.salesOrder.transactionNo, salesOrder.transactionNo);

  // rejecting the order releases it just the same
  await svc.Tx.processTransaction(again.salesOrder._id, "reject", "t");
  assert.equal((await svc.Quotation.findById(q._id)).status, "ACCEPTED");

  // and one that was invoiced stays converted
  const third = await svc.Q.convertToSalesOrder(q._id, {}, "t");
  await approve(third.salesOrder);
  assert.equal((await svc.Quotation.findById(q._id)).status, "CONVERTED");
  assert.equal(await onHand(rice), stock0 - 5, "stock leaves once, when the order is approved");
});

// ================================ delivery notes, against an order ================================

test("delivery note against an order: part by part, never more than ordered, and it moves nothing", { skip }, async () => {
  const so = await order(customer, [L(rice, 10, 20), L(oil, 4, 50)], { lpono: "LPO-1" });
  const [riceLine, oilLine] = so.items.map((i) => i._id);

  const pre = await svc.D.prefillFromOrder(so._id);
  assert.equal(pre.lines[0].remaining, 10);
  assert.equal(pre.deliveryAddress, "Warehouse 4, Al Quoz");
  assert.equal(pre.order.reference, "LPO-1");

  const before = await footprint();
  const stock0 = await onHand(rice);
  const d1 = await svc.D.create({ sourceTransactionId: so._id, items: [{ sourceLineId: riceLine, qty: 6 }] }, "t");
  assert.deepEqual(await footprint(), before, "no stock movement, ledger entry, voucher or transaction");
  assert.equal(await onHand(rice), stock0);

  assert.match(d1.deliveryNoteNo, /^DLN-\d{4}-\d{4}$/);
  assert.equal(d1.source.kind, "sales_order");
  assert.equal(d1.invoice.no, so.transactionNo);
  assert.equal(d1.invoiceStatus, "DRAFT");
  assert.equal(d1.reference, "LPO-1");
  assert.equal(d1.contactPerson, "Ali");
  assert.equal(d1.items[0].price, 20, "the price is the order's, not the client's");
  assert.equal(d1.totalAmount, 126); // 6 x 20 + 5%

  await assert.rejects(() => svc.D.create({ sourceTransactionId: so._id, items: [{ sourceLineId: riceLine, qty: 5 }] }, "t"), { code: "OVER_DELIVERY" }); // 6 + 5 > 10
  await assert.rejects(() => svc.D.create({ sourceTransactionId: so._id, items: [{ sourceLineId: new mongoose.Types.ObjectId(), qty: 1 }] }, "t"), { code: "LINE_NOT_ON_ORDER" });
  const d2 = await svc.D.create({ sourceTransactionId: so._id, items: [{ sourceLineId: riceLine, qty: 4 }, { sourceLineId: oilLine, qty: 4 }] }, "t");

  const f = (await svc.D.getById(d1._id)).fulfilment;
  assert.deepEqual(f[String(riceLine)], { ordered: 10, pending: 10, delivered: 0, remaining: 0, over: false });
  assert.equal((await svc.D.prefillFromOrder(so._id)).lines[0].remaining, 0);

  // ---- lifecycle ----
  const sent = await svc.D.dispatch(d1._id, { vehicleNo: "DXB A 12345", driverName: "Raju" }, "t");
  assert.equal(sent.status, "DISPATCHED");
  assert.ok(sent.dispatchedAt);
  await assert.rejects(() => svc.D.update(d1._id, { notes: "x" }, "t"), { code: "DELIVERY_NOTE_NOT_EDITABLE" });
  await assert.rejects(() => svc.D.remove(d1._id, "t"), { code: "DELIVERY_NOTE_NOT_DELETABLE" });
  await assert.rejects(() => svc.D.dispatch(d1._id, {}, "t"), { code: "DELIVERY_NOTE_STATE" });

  await assert.rejects(() => svc.D.deliver(d1._id, {}, "t"), { code: "RECEIVED_BY_REQUIRED" });
  await assert.rejects(() => svc.D.deliver(d1._id, { receivedBy: "Store", lines: [{ lineId: d1.items[0]._id, deliveredQty: 5 }] }, "t"), { code: "INVALID_DELIVERY" }); // short, no reason
  await assert.rejects(() => svc.D.deliver(d1._id, { receivedBy: "Store", lines: [{ lineId: d1.items[0]._id, deliveredQty: 9 }] }, "t"), { code: "INVALID_DELIVERY" }); // more than sent
  await assert.rejects(() => svc.D.deliver(d1._id, { receivedBy: "Store", deliveredAt: ymd(1) }, "t"), { code: "INVALID_DATE" });

  const done = await svc.D.deliver(d1._id, { receivedBy: "Store keeper", proofNote: "signed, stamped", lines: [{ lineId: d1.items[0]._id, deliveredQty: 5, shortReason: "1 carton damaged" }] }, "t");
  assert.equal(done.status, "DELIVERED");
  assert.equal(done.items[0].deliveredQty, 5);
  assert.equal(done.items[0].shortReason, "1 carton damaged");
  assert.equal(done.totalAmount, 105, "worth what was accepted, not what was loaded"); // 5 x 20 + 5%
  assert.equal(done.items[0].lineTotal, 105);
  assert.equal(done.receivedBy, "Store keeper");
  await assert.rejects(() => svc.D.cancel(d1._id, {}, "t"), { code: "DELIVERY_NOTE_STATE" }); // a signed delivery is undone by a return

  // the carton that did not arrive is back on the order: 10 - 5 delivered - 4 on d2
  assert.equal((await svc.D.prefillFromOrder(so._id)).lines[0].remaining, 1);
  await svc.D.create({ sourceTransactionId: so._id, items: [{ sourceLineId: riceLine, qty: 1 }] }, "t");
  await assert.rejects(() => svc.D.create({ sourceTransactionId: so._id, items: [{ sourceLineId: riceLine, qty: 1 }] }, "t"), { code: "OVER_DELIVERY" });

  // cancelling a note that has not been delivered frees its quantity
  const cancelled = await svc.D.cancel(d2._id, { reason: "customer postponed" }, "t");
  assert.equal(cancelled.status, "CANCELLED");
  assert.equal((await svc.D.prefillFromOrder(so._id)).lines[1].remaining, 4);

  // ---- the invoice is what moves stock, exactly once ----
  await approve(so);
  assert.equal(await onHand(rice), stock0 - 10, "ordered quantity leaves on approval, not the delivered or noted quantity");
  assert.equal((await svc.DeliveryNote.findById(d1._id)).invoiceStatus, "INVOICED");
  assert.equal((await svc.D.getById(d1._id)).clock, null, "the clock stops once invoiced");
  assert.ok(!(await svc.D.uninvoiced()).rows.some((r) => String(r._id) === String(d1._id)));

  // the approved order is reversed (deleting an approved document is how that is done): the goods are
  // delivered and not invoiced again, and the note stands alone
  await svc.Tx.deleteTransaction(so._id, "t");
  assert.equal(await onHand(rice), stock0);
  const back = await svc.D.getById(d1._id);
  assert.equal(back.invoiceStatus, "NONE");
  assert.equal(back.source.kind, "manual");
  assert.equal(back.invoice, undefined);
  assert.equal(back.actions.invoice, true, "it can be invoiced on its own now");
  assert.equal(back.clock.clock, "within");
  const rescue = await svc.D.createInvoice({ deliveryNoteIds: [d1._id] }, "t");
  assert.equal(rescue.salesOrder.totalAmount, 105);
  assert.equal(rescue.salesOrder.linkedRef, d1.deliveryNoteNo);

  // an order that is gone, or that was cancelled before it was invoiced, takes no deliveries
  await assert.rejects(() => svc.D.create({ sourceTransactionId: so._id, items: [{ sourceLineId: riceLine, qty: 1 }] }, "t"), { code: "ORDER_NOT_FOUND" });
  const dead = await order(customer, [L(rice, 3, 20)]);
  const deadLine = dead.items[0]._id;
  const onIt = await svc.D.create({ sourceTransactionId: dead._id, items: [{ sourceLineId: deadLine, qty: 3 }] }, "t");
  await svc.Tx.processTransaction(dead._id, "cancel", "t"); // a draft can be cancelled
  await assert.rejects(() => svc.D.prefillFromOrder(dead._id), { code: "ORDER_NOT_DELIVERABLE" });
  await assert.rejects(() => svc.D.create({ sourceTransactionId: dead._id, items: [{ sourceLineId: deadLine, qty: 1 }] }, "t"), { code: "ORDER_NOT_DELIVERABLE" });
  const orphan = await svc.DeliveryNote.findById(onIt._id);
  assert.equal(orphan.source.kind, "manual", "the note it had is released, not stranded");
  assert.equal(orphan.invoiceStatus, "NONE");
});

// =============================== delivery notes first, invoice after ===============================

test("delivery first, invoice after: one or several notes on one invoice, at the quantity accepted", { skip }, async () => {
  const base = (await svc.D.availability([rice._id]))[0];
  const n1 = await svc.D.create({ partyId: customer._id, date: ymd(-3), reference: "LPO-9", items: [L(rice, 10, 20), L(oil, 2, 50)] }, "t");
  await svc.D.deliver(n1._id, { receivedBy: "Ali", deliveredAt: ymd(-3), lines: [{ lineId: n1.items[0]._id, deliveredQty: 8, shortReason: "2 refused" }] }, "t");
  const n2 = await svc.D.create({ partyId: customer._id, items: [L(rice, 5, 20)] }, "t");
  await svc.D.dispatch(n2._id, {}, "t");
  await svc.D.deliver(n2._id, { receivedBy: "Ali" }, "t");

  // until invoiced the goods are still on hand in the books, so they are counted as promised
  const held = (await svc.D.availability([rice._id]))[0];
  assert.equal(held.committed - base.committed, 13);
  assert.equal(held.available, held.onHand - held.committed);
  const own = (await svc.D.availability([rice._id], { excludeId: n2._id }))[0];
  assert.equal(held.committed - own.committed, 5, "a note being edited is not counted against itself");

  // the VAT clock
  const report = await svc.D.uninvoiced();
  const row = report.rows.find((r) => String(r._id) === String(n1._id));
  assert.equal(row.clock.daysSince, 3);
  assert.equal(row.clock.standardDue, ymd(11));
  assert.equal(row.clock.clock, "within");
  const order1 = report.rows.map((r) => String(r._id));
  assert.ok(order1.indexOf(String(n1._id)) < order1.indexOf(String(n2._id)), "oldest delivery first");
  assert.ok(report.summary.count >= 2);

  // what cannot be invoiced
  const n3 = await svc.D.create({ partyId: other._id, items: [L(rice, 1, 20)] }, "t");
  await svc.D.deliver(n3._id, { receivedBy: "x" }, "t");
  await assert.rejects(() => svc.D.createInvoice({ deliveryNoteIds: [n1._id, n3._id] }, "t"), { code: "MIXED_CUSTOMERS" });
  const draft = await svc.D.create({ partyId: customer._id, items: [L(rice, 1, 20)] }, "t");
  await assert.rejects(() => svc.D.createInvoice({ deliveryNoteIds: [draft._id] }, "t"), { code: "DELIVERY_NOTE_STATE" });
  const so = await order(customer, [L(rice, 2, 20)]);
  const against = await svc.D.create({ sourceTransactionId: so._id, items: [{ sourceLineId: so.items[0]._id, qty: 2 }] }, "t");
  await svc.D.deliver(against._id, { receivedBy: "x" }, "t");
  await assert.rejects(() => svc.D.createInvoice({ deliveryNoteIds: [against._id] }, "t"), { code: "DELIVERY_NOTE_HAS_ORDER" });
  await assert.rejects(() => svc.D.createInvoice({ deliveryNoteIds: [] }, "t"), { code: "NOTES_REQUIRED" });

  // one invoice for both notes
  const promised = (await svc.D.availability([rice._id]))[0].committed; // includes the other notes made above
  const stock0 = { rice: await onHand(rice), oil: await onHand(oil) };
  const { salesOrder, deliveryNotes } = await svc.D.createInvoice({ deliveryNoteIds: [n2._id, n1._id] }, "t");
  assert.equal(salesOrder.status, "DRAFT");
  assert.equal(salesOrder.totalAmount, 378); // (8 + 5) x 20 + 2 x 50 = 360, + 5%
  assert.equal(salesOrder.linkedRef, `${n1.deliveryNoteNo}, ${n2.deliveryNoteNo}`, "in delivery order");
  assert.equal(salesOrder.lpono, "LPO-9");
  assert.equal(salesOrder.items.length, 3);
  assert.deepEqual(deliveryNotes.map((n) => n.invoiceStatus), ["DRAFT", "DRAFT"]);
  assert.equal(await onHand(rice), stock0.rice, "an invoice in draft moves nothing");
  await assert.rejects(() => svc.D.createInvoice({ deliveryNoteIds: [n1._id] }, "t"), { code: "ALREADY_INVOICED" });
  assert.equal((await svc.D.availability([rice._id]))[0].committed, promised, "still promised while the invoice is a draft");

  await approve(salesOrder);
  assert.equal(await onHand(rice), stock0.rice - 13, "stock leaves once, at the quantity accepted");
  assert.equal(await onHand(oil), stock0.oil - 2);
  assert.equal((await svc.DeliveryNote.findById(n1._id)).invoiceStatus, "INVOICED");
  assert.equal((await svc.D.availability([rice._id]))[0].committed, promised - 13, "no longer promised: the books have it");
  assert.equal((await svc.D.getById(n1._id)).actions.invoice, false);

  // a draft invoice that is deleted frees its notes to be invoiced again
  const n4 = await svc.D.create({ partyId: customer._id, items: [L(oil, 1, 50)] }, "t");
  await svc.D.deliver(n4._id, { receivedBy: "x" }, "t");
  const first = await svc.D.createInvoice({ deliveryNoteIds: [n4._id] }, "t");
  await svc.Tx.deleteTransaction(first.salesOrder._id, "t");
  const freed = await svc.DeliveryNote.findById(n4._id);
  assert.equal(freed.invoiceStatus, "NONE");
  assert.equal(freed.invoice, undefined);
  await svc.D.createInvoice({ deliveryNoteIds: [n4._id] }, "t");
});

test("a delivery note from a quotation spends the offer, and releases it if the note goes", { skip }, async () => {
  const q = await svc.Q.create({ partyId: customer._id, reference: "RFQ-5", items: [L(rice, 3, 20)], charges: [{ description: "Freight", amount: 10, vatPercent: 5 }], discount: 2 }, "t");
  await assert.rejects(() => svc.D.createFromQuotation(q._id, {}, "t"), { code: "QUOTATION_STATE" }); // a draft was never offered
  await svc.Q.transition(q._id, "send", {}, "t");

  const { quotation, deliveryNote } = await svc.D.createFromQuotation(q._id, {}, "t");
  assert.equal(quotation.status, "CONVERTED");
  assert.equal(quotation.convertedTo.kind, "delivery_note");
  assert.equal(quotation.convertedTo.no, deliveryNote.deliveryNoteNo);
  assert.equal(deliveryNote.source.kind, "quotation");
  assert.equal(deliveryNote.source.no, q.quotationNo);
  assert.equal(deliveryNote.totalAmount, q.totalAmount, "the discount and freight travel with the goods");
  assert.equal(deliveryNote.reference, "RFQ-5");
  await assert.rejects(() => svc.D.createFromQuotation(q._id, {}, "t"), { code: "QUOTATION_STATE" });
  await assert.rejects(() => svc.Q.convertToSalesOrder(q._id, {}, "t"), { code: "QUOTATION_STATE" });

  await svc.D.cancel(deliveryNote._id, { reason: "not wanted" }, "t");
  assert.equal((await svc.Quotation.findById(q._id)).status, "ACCEPTED");
  const again = await svc.D.createFromQuotation(q._id, {}, "t");
  await svc.D.remove(again.deliveryNote._id, "t");
  assert.equal((await svc.Quotation.findById(q._id)).status, "ACCEPTED");
});

// ==================================== pick list and lists ====================================

test("pick list: first-expiry-first-out, the customer's shelf-life floor, or the batches an approved order took", { skip }, async () => {
  const plan = async (party, qty) => {
    const d = await svc.D.create({ partyId: party._id, items: [L(milk, qty, 5)] }, "t");
    return (await svc.D.pickList(d._id)).lines[0];
  };
  const normal = await plan(customer, 50);
  assert.deepEqual(normal.batches.map((b) => [b.batchNumber, b.qty]), [["M-OLD", 40], ["M-NEW", 10]]);
  assert.equal(normal.unallocated, 0);
  assert.equal(normal.basis, "suggested");

  // 20 days of shelf life is less than the 45 this customer insists on
  const picky = await plan(fussy, 30);
  assert.deepEqual(picky.batches.map((b) => b.batchNumber), ["M-NEW"]);
  const short = await plan(fussy, 60);
  assert.equal(short.unallocated, 20);

  // an approved order already took its batches; notes against it show those, in turn
  const so = await order(customer, [L(milk, 30, 5)]);
  await approve(so);
  const a = await svc.D.create({ sourceTransactionId: so._id, items: [{ sourceLineId: so.items[0]._id, qty: 20 }] }, "t");
  const b = await svc.D.create({ sourceTransactionId: so._id, items: [{ sourceLineId: so.items[0]._id, qty: 10 }] }, "t");
  const first = (await svc.D.pickList(a._id)).lines[0];
  assert.equal(first.basis, "allocated");
  assert.deepEqual(first.batches.map((x) => [x.batchNumber, x.qty]), [["M-OLD", 20]]);
  const second = (await svc.D.pickList(b._id)).lines[0];
  assert.deepEqual(second.batches.map((x) => [x.batchNumber, x.qty]), [["M-OLD", 10]], "the second note continues where the first stopped");
});

test("lists: filter by state, party and text; every document is in its own collection", { skip }, async () => {
  const quotes = await svc.Q.list({ partyId: String(customer._id), limit: 100 });
  assert.ok(quotes.rows.length > 3);
  assert.ok(quotes.rows.every((r) => String(r.partyId) === String(customer._id) && r.party.customerName === "Cust"));
  assert.ok((await svc.Q.list({ search: "RFQ-77" })).rows.some((r) => r.reference === "RFQ-77"));
  assert.ok((await svc.Q.list({ search: "(unclosed" })).rows.length === 0, "search text is never a pattern");
  assert.ok((await svc.Q.list({ status: "CONVERTED" })).rows.every((r) => r.status === "CONVERTED"));

  const notes = await svc.D.list({ status: "UNINVOICED", limit: 100 });
  assert.ok(notes.rows.every((r) => r.status === "DELIVERED" && r.invoiceStatus !== "INVOICED"));
  assert.ok((await svc.D.list({ search: "Cust" })).rows.length > 0, "found by customer name");
  assert.ok((await svc.D.list({ invoiceStatus: "INVOICED" })).rows.every((r) => r.invoiceStatus === "INVOICED"));
  const summary = await svc.D.summary();
  assert.ok(summary.uninvoiced.count >= 1);
  assert.equal(summary.clock.count > 0, true);

  // an offer and a note are never a Transaction: nothing that reads orders can see them
  const types = await svc.Transaction.distinct("type");
  assert.deepEqual(types.sort(), ["purchase_order", "sales_order"]);
  assert.equal(await svc.NumberSeries.countDocuments({ series: "DN" }), 0, "the debit-note series was never touched");
  assert.ok(await svc.NumberSeries.exists({ series: "QT" }));
  assert.ok(await svc.NumberSeries.exists({ series: "DLN" }));
});
