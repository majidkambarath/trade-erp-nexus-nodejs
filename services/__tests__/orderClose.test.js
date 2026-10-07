// Closing a sales order short, and the protection an order's edit gives its delivery notes, against a
// throwaway database (random name, dropped afterwards).
//
// What these prove, beyond the rules in utils/__tests__/closeShort.test.js:
//   - a draft is cut down to what was delivered and priced exactly as if it had been entered that way
//   - an approved order is left alone (no stock, ledger or total changes) and is owed a sales return
//   - reopening puts a draft back exactly, and is refused once something was built on the closing
//   - an edit cannot orphan, shrink or swap the lines delivery notes were raised against
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let svc;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  const fin = require("../../models/modules/financial/financialModels");
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Tx: require("../orderPurchase/transactionService"),
    D: require("../orderPurchase/deliveryNoteService"),
    Close: require("../orderPurchase/orderCloseService"),
    Flow: require("../orderPurchase/documentFlowService"),
    DeliveryNote: require("../../models/modules/deliveryNoteModel"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    Movement: require("../../models/modules/inventoryMovementModel"),
    LedgerEntry: fin.LedgerEntry,
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
let vendor, customer, rice, oil;
const L = (item, qty, price, extra = {}) => ({ itemId: item._id, description: item.itemName, qty, price, rate: price, vatPercent: 5, ...extra });
const buy = async (items) => {
  const t = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items }, "tester");
  await svc.Tx.processTransaction(t._id, "approve", "tester");
};
const order = (items, extra = {}) =>
  svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items, ...extra }, "tester");
const reload = (t) => svc.Transaction.findById(t._id);
const onHand = async (item) => (await svc.Stock.findById(item._id)).currentStock;
const footprint = async () => ({ tx: await svc.Transaction.countDocuments(), ledger: await svc.LedgerEntry.countDocuments(), moves: await svc.Movement.countDocuments() });
const lineOf = (so, item) => so.items.find((i) => String(i.itemId) === String(item._id));

// a note against the order for these lines ([item, qty]), signed for in full unless `took` says otherwise
const deliver = async (so, lines, { took = {}, reasons = {} } = {}) => {
  const d = await svc.D.create({ sourceTransactionId: so._id, items: lines.map(([item, qty]) => ({ sourceLineId: lineOf(so, item)._id, qty })) }, "t");
  await svc.D.dispatch(d._id, { vehicleNo: "DXB 1" }, "t");
  const settle = d.items.map((l) => {
    const item = [rice, oil].find((x) => String(x._id) === String(l.itemId));
    return took[item.itemName] === undefined ? null : { lineId: l._id, deliveredQty: took[item.itemName], shortReason: reasons[item.itemName] || "Customer refused" };
  }).filter(Boolean);
  return svc.D.deliver(d._id, { receivedBy: "Store keeper", ...(settle.length ? { lines: settle } : {}) }, "t");
};

test("setup", { skip }, async () => {
  vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Vend", contactPerson: "x", address: "y", paymentTerms: "Net 30" });
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Cust", contactPerson: "Ali", phone: "0501234567", shippingAddress: "Warehouse 4", paymentTerms: "Net 30" });
  const category = new mongoose.Types.ObjectId();
  rice = await svc.Stock.create({ itemId: "ITM1", sku: "SKU1", itemName: "Rice", category });
  oil = await svc.Stock.create({ itemId: "ITM2", sku: "SKU2", itemName: "Oil", category });
  await buy([L(rice, 500, 10)]);
  await buy([L(oil, 200, 20)]);
});

// ===================================== a draft order =====================================

let draft;
test("a draft is cut down to what was delivered, priced exactly as if it had been entered that way", { skip }, async () => {
  draft = await order([L(rice, 10, 20, { discountPercent: 10 }), L(oil, 4, 50)], { charges: [{ description: "Freight", amount: 25, vatPercent: 5 }] });
  await deliver(draft, [[rice, 6], [oil, 4]]);
  const before = await footprint();
  const lineIds = draft.items.map((i) => String(i._id));

  const preview = await svc.Close.preview(draft._id);
  assert.equal(preview.mode, "trim");
  assert.deepEqual(preview.lines.map((l) => [l.description, l.ordered, l.delivered, l.short]), [["Rice", 10, 6, 4]]);
  assert.ok(preview.newTotal < preview.order.totalAmount);
  assert.equal(preview.valueShort, Math.round((preview.order.totalAmount - preview.newTotal) * 100) / 100);
  assert.equal((await reload(draft)).closedShort, undefined, "a preview writes nothing");

  const closed = await svc.Close.closeShort(draft._id, { reason: "  Customer bought   elsewhere " }, "tester");
  assert.equal(closed.closedShort.reason, "Customer bought elsewhere", "tidied");
  assert.equal(closed.closedShort.trimmed, true);
  assert.equal(closed.closedShort.by, "tester");
  assert.deepEqual(closed.items.map((i) => String(i._id)), lineIds, "every line keeps its id, so the notes still point at it");
  assert.deepEqual(closed.items.map((i) => i.qty), [6, 4]);

  // the same lines entered fresh give the same money
  const fresh = await order([L(rice, 6, 20, { discountPercent: 10 }), L(oil, 4, 50)], { charges: [{ description: "Freight", amount: 25, vatPercent: 5 }] });
  assert.equal(closed.totalAmount, fresh.totalAmount);
  assert.deepEqual(closed.pricing.toObject(), fresh.pricing.toObject());
  assert.equal(closed.items[0].taxableAmount, fresh.items[0].taxableAmount);
  assert.equal(closed.items[0].rate, closed.items[0].taxableAmount, "rate is the line's net value, as the form stores it");
  assert.equal(closed.closedShort.valueShort, preview.valueShort);
  await svc.Tx.deleteTransaction(fresh._id, "tester");

  assert.deepEqual(await footprint(), before, "closing posts nothing and moves no stock");
  const stored = await reload(draft);
  assert.equal(stored.closedShort.original, undefined, "the copy kept for reopening is left out of ordinary reads");
  assert.equal(stored.items.length, 2);
});

test("the cut-down order is what gets approved: stock and the invoice follow what was delivered", { skip }, async () => {
  const riceBefore = await onHand(rice);
  const oilBefore = await onHand(oil);
  const approved = await svc.Tx.processTransaction(draft._id, "approve", "tester");
  assert.equal(approved.status, "APPROVED");
  assert.equal(await onHand(rice), riceBefore - 6);
  assert.equal(await onHand(oil), oilBefore - 4);
  const notes = await svc.DeliveryNote.find({ "source.id": draft._id });
  assert.ok(notes.every((n) => n.invoiceStatus === "INVOICED"));
  assert.equal(approved.closedShort.trimmed, true, "the record of why stays on the invoice");
});

test("once approved after closing, it cannot be reopened: the invoice was built on the cut-down lines", { skip }, async () => {
  await assert.rejects(() => svc.Close.reopen(draft._id, "tester"), { code: "REOPEN_NOT_POSSIBLE" });
});

test("nothing more can be delivered against an order that was closed short", { skip }, async () => {
  await assert.rejects(() => svc.D.create({ sourceTransactionId: draft._id, items: [{ sourceLineId: draft.items[0]._id, qty: 1 }] }, "t"), { code: "ORDER_CLOSED_SHORT" });
  await assert.rejects(() => svc.D.prefillFromOrder(draft._id), { code: "ORDER_CLOSED_SHORT" });
});

test("reopening a draft puts the order back exactly, and the delivery is unfinished again", { skip }, async () => {
  const so = await order([L(rice, 10, 20, { discountPercent: 10 }), L(oil, 4, 50), L(rice, 3, 18)], { charges: [{ description: "Freight", amount: 25, vatPercent: 5 }] });
  await deliver(so, [[rice, 6]]); // the first rice line only; oil and the second rice line went nowhere
  const original = await svc.Transaction.findById(so._id).lean();

  await svc.Close.closeShort(so._id, { reason: "Customer cancelled the rest" }, "tester");
  const cut = await reload(so);
  assert.equal(cut.items.length, 1, "lines nothing was delivered of are gone");
  assert.equal(cut.items[0].qty, 6);

  const back = await svc.Close.reopen(so._id, "tester");
  assert.equal(back.closedShort, undefined);
  assert.equal(back.totalAmount, original.totalAmount);
  assert.deepEqual(back.items.map((i) => [String(i._id), i.qty, i.lineTotal]), original.items.map((i) => [String(i._id), i.qty, i.lineTotal]));
  assert.deepEqual(back.pricing.toObject(), original.pricing);
  const fill = await svc.D.prefillFromOrder(so._id);
  assert.deepEqual(fill.lines.map((l) => [l.description, l.remaining]), [["Rice", 4], ["Oil", 4], ["Rice", 3]], "what is left to deliver is back");
  await assert.rejects(() => svc.Close.reopen(so._id, "tester"), { code: "NOT_CLOSED_SHORT" });
  await svc.Tx.deleteTransaction(so._id, "tester");
});

// ===================================== an approved order =====================================

let invoiced;
test("an approved order is left exactly as it is: no stock, ledger or total changes", { skip }, async () => {
  invoiced = await order([L(rice, 10, 20), L(oil, 4, 50)]);
  await deliver(invoiced, [[rice, 6], [oil, 4]]);
  invoiced = await svc.Tx.processTransaction(invoiced._id, "approve", "tester");
  const before = await footprint();
  const riceBefore = await onHand(rice);
  const totalBefore = invoiced.totalAmount;

  const preview = await svc.Close.preview(invoiced._id);
  assert.equal(preview.mode, "credit");
  assert.equal(preview.newTotal, null);
  assert.equal(preview.valueShort, 84, "4 of 10 rice: the line is 200 + 10 VAT = 210, and 4/10 of it is 84");

  const closed = await svc.Close.closeShort(invoiced._id, { reason: "Customer will not take the rest" }, "tester");
  assert.equal(closed.closedShort.trimmed, false);
  assert.equal(closed.closedShort.valueShort, 84);
  assert.equal(closed.totalAmount, totalBefore);
  assert.equal(closed.items.length, 2);
  assert.equal(closed.items[0].qty, 10, "the invoice is not edited");
  assert.deepEqual(await footprint(), before);
  assert.equal(await onHand(rice), riceBefore);
  assert.equal(closed.closedShort.original, undefined, "nothing to restore: the order was not changed");
});

test("the deal shows the delivery finished, and a sales return is owed until an approved one exists", { skip }, async () => {
  let chain = (await svc.Flow.forCustomer(customer._id)).chains.find((c) => c.order?._id && String(c.order._id) === String(invoiced._id));
  assert.equal(chain.delivery.complete, true);
  assert.deepEqual(chain.delivery.remaining, []);
  assert.deepEqual(chain.closeShort.left, [{ description: "Rice", qty: 4 }]);
  assert.equal(chain.closeShort.reason, "Customer will not take the rest");
  assert.equal(chain.closeShort.creditDue, true);

  // the sales return for the goods that never went out
  const ret = await svc.Tx.createTransaction({
    type: "sales_return", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer",
    items: [L(rice, 4, 20, { returnOfLineId: lineOf(invoiced, rice)._id })], returnOf: { transactionId: invoiced._id },
  }, "tester");
  chain = (await svc.Flow.forCustomer(customer._id)).chains.find((c) => String(c.order?._id) === String(invoiced._id));
  assert.equal(chain.closeShort.creditDue, true, "a draft return has not put the books right");
  assert.deepEqual(chain.closeShort.returns.map((r) => [r.transactionNo, r.status]), [[ret.transactionNo, "DRAFT"]]);

  await assert.rejects(() => svc.Close.reopen(invoiced._id, "tester"), { code: "RETURN_RAISED" });

  const riceBefore = await onHand(rice);
  await svc.Tx.processTransaction(ret._id, "approve", "tester");
  assert.equal(await onHand(rice), riceBefore + 4, "the undelivered goods are back in stock");
  chain = (await svc.Flow.forCustomer(customer._id)).chains.find((c) => String(c.order?._id) === String(invoiced._id));
  assert.equal(chain.closeShort.creditDue, false);
});

test("an approved order closed by mistake can be reopened while nothing was raised for it", { skip }, async () => {
  const so = await order([L(rice, 5, 20), L(oil, 2, 50)]);
  await deliver(so, [[rice, 2]]);
  await svc.Tx.processTransaction(so._id, "approve", "tester");
  await svc.Close.closeShort(so._id, { reason: "Wrong order" }, "tester");
  const back = await svc.Close.reopen(so._id, "tester");
  assert.equal(back.closedShort, undefined);
  const fill = await svc.D.prefillFromOrder(so._id);
  assert.deepEqual(fill.lines.map((l) => l.remaining), [3, 2]);
});

// ===================================== when it is refused =====================================

test("it is refused with a reason the screen can show", { skip }, async () => {
  const so = await order([L(rice, 5, 20), L(oil, 2, 50)]);
  await assert.rejects(() => svc.Close.closeShort(so._id, { reason: "x" }, "t"), { code: "REASON_REQUIRED" });
  await assert.rejects(() => svc.Close.closeShort(so._id, { reason: "x".repeat(501) }, "t"), { code: "REASON_TOO_LONG" });
  await assert.rejects(() => svc.Close.closeShort(so._id, { reason: "No stock" }, "t"), { code: "NOTHING_DELIVERED" });
  await assert.rejects(() => svc.Close.closeShort("nope", { reason: "No stock" }, "t"), { code: "ORDER_REQUIRED" });
  await assert.rejects(() => svc.Close.closeShort(new mongoose.Types.ObjectId(), { reason: "No stock" }, "t"), { code: "ORDER_NOT_FOUND" });

  // a note still on the road
  const d = await svc.D.create({ sourceTransactionId: so._id, items: [{ sourceLineId: lineOf(so, rice)._id, qty: 2 }] }, "t");
  await svc.D.dispatch(d._id, {}, "t");
  await assert.rejects(() => svc.Close.closeShort(so._id, { reason: "Customer left" }, "t"), { code: "OPEN_DELIVERY" });
  await svc.D.deliver(d._id, { receivedBy: "Store" }, "t");

  // delivered in full
  const full = await order([L(rice, 3, 20)]);
  await deliver(full, [[rice, 3]]);
  await assert.rejects(() => svc.Close.closeShort(full._id, { reason: "Customer left" }, "t"), { code: "NOTHING_LEFT" });

  // closed twice
  await svc.Close.closeShort(so._id, { reason: "Customer left" }, "t");
  await assert.rejects(() => svc.Close.closeShort(so._id, { reason: "Customer left again" }, "t"), { code: "ALREADY_CLOSED_SHORT" });

  // a rejected order is not open
  const dead = await order([L(rice, 3, 20)]);
  await svc.Tx.processTransaction(dead._id, "reject", "t");
  await assert.rejects(() => svc.Close.closeShort(dead._id, { reason: "Customer left" }, "t"), { code: "ORDER_NOT_OPEN" });
});

test("an order raised from delivery notes already bills what was delivered", { skip }, async () => {
  const note = await svc.D.create({ partyId: customer._id, items: [L(rice, 2, 20)] }, "t");
  await svc.D.dispatch(note._id, {}, "t");
  await svc.D.deliver(note._id, { receivedBy: "Store" }, "t");
  const made = await svc.D.createInvoice({ deliveryNoteIds: [note._id] }, "t");
  const invoice = made.salesOrder;
  await assert.rejects(() => svc.Close.closeShort(invoice._id, { reason: "Customer left" }, "t"), { code: "ORDER_FROM_NOTES" });
});

// ===================================== editing a draft with notes against it =====================================

test("an edit that sends no line ids keeps every delivery note linked", { skip }, async () => {
  const so = await order([L(rice, 10, 20), L(oil, 4, 50)]);
  await deliver(so, [[rice, 6]]);
  const ids = so.items.map((i) => String(i._id));
  // what the order form sends today: the lines again, with no ids
  const edited = await svc.Tx.updateTransaction(so._id, { items: [L(rice, 10, 22), L(oil, 4, 50)], notes: "price corrected" }, "tester");
  assert.deepEqual(edited.items.map((i) => String(i._id)), ids, "the same lines, the same ids");
  assert.equal(edited.items[0].price, 22);
  const fill = await svc.D.prefillFromOrder(so._id);
  assert.deepEqual(fill.lines.map((l) => [l.delivered, l.remaining]), [[6, 4], [0, 4]], "the delivery is still counted");
});

test("an edit may not take away, shrink or swap what a delivery note covers", { skip }, async () => {
  const so = await order([L(rice, 10, 20), L(oil, 4, 50)]);
  await deliver(so, [[rice, 6]]);
  const ids = so.items.map((i) => String(i._id));
  const withIds = (items) => items.map((l, i) => ({ ...l, _id: ids[i] }));

  await assert.rejects(() => svc.Tx.updateTransaction(so._id, { items: [{ ...L(oil, 4, 50), _id: ids[1] }] }, "t"), { code: "ORDER_LINE_HAS_DELIVERIES" });
  await assert.rejects(() => svc.Tx.updateTransaction(so._id, { items: withIds([L(rice, 5, 20), L(oil, 4, 50)]) }, "t"), { code: "ORDER_QTY_BELOW_DELIVERED" });
  await assert.rejects(() => svc.Tx.updateTransaction(so._id, { items: withIds([L(oil, 10, 20), L(oil, 4, 50)]) }, "t"), { code: "ORDER_LINE_HAS_DELIVERIES" }, "a different product on that line");
  const ok = await svc.Tx.updateTransaction(so._id, { items: withIds([L(rice, 6, 20), L(oil, 1, 50)]) }, "t");
  assert.deepEqual(ok.items.map((i) => i.qty), [6, 1], "down to exactly what was delivered is fine, and lines with no delivery are free");
  const more = await svc.Tx.updateTransaction(so._id, { items: withIds([L(rice, 20, 20), L(oil, 1, 50)]) }, "t");
  assert.equal(more.items[0].qty, 20);
  // a line with no delivery can be dropped
  const lean = await svc.Tx.updateTransaction(so._id, { items: withIds([L(rice, 20, 20)]) }, "t");
  assert.equal(lean.items.length, 1);
});

test("editing the lines of a closed order lifts the closing; editing anything else does not", { skip }, async () => {
  const so = await order([L(rice, 10, 20), L(oil, 4, 50)]);
  await deliver(so, [[rice, 6], [oil, 4]]);
  await svc.Close.closeShort(so._id, { reason: "Customer left" }, "t");

  const same = await svc.Tx.updateTransaction(so._id, { items: [L(rice, 6, 20), L(oil, 4, 50)], notes: "only a note changed" }, "t");
  assert.ok(same.closedShort?.at, "the same lines: still closed");

  const forged = await svc.Tx.updateTransaction(so._id, { notes: "x", closedShort: { at: new Date(), reason: "forged", trimmed: false } }, "t");
  assert.equal(forged.closedShort.reason, "Customer left", "closing is its own action, not a field of an edit");

  const more = await svc.Tx.updateTransaction(so._id, { items: [L(rice, 8, 20), L(oil, 4, 50)] }, "t");
  assert.equal(more.closedShort, undefined, "the quantities changed: the order is open again");
  const fill = await svc.D.prefillFromOrder(so._id);
  assert.deepEqual(fill.lines.map((l) => l.remaining), [2, 0], "and the delivery reads from the lines again");
});

test("a line id sent with a new document is ignored: every line gets its own", { skip }, async () => {
  const other = await order([L(rice, 1, 20)]);
  const stolen = other.items[0]._id;
  const so = await svc.Tx.createTransaction({
    type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [{ ...L(rice, 2, 20), _id: stolen }],
  }, "tester");
  assert.notEqual(String(so.items[0]._id), String(stolen));
});
