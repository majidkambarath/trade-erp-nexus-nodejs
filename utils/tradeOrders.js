// Orders and goods receipts: the rules that need no database.
//
// A TRADE ORDER (sales or purchase) is a commitment, not a posting: nothing reaches the ledger, stock or a
// customer's or vendor's balance until an INVOICE is approved (services/orderPurchase/transactionService.js). The order
// sits in its own collection so nothing that reads Transaction (VAT return, ageing, dashboards, e-invoicing) can ever
// pick it up. What has happened to it (received, invoiced) is not stored on it: it is read from the goods receipts and
// the invoices that point back at it, so it cannot drift.
//
// A GOODS RECEIPT is the vendor-side twin of a delivery note: the paper that says what arrived, signed by whoever took
// it in. It posts nothing and moves no stock either; the purchase INVOICE made from it does both, and can bill no more
// than was received (the "3-way match": order, receipt, invoice).

const ORDER_STATUS = Object.freeze({
  DRAFT: "DRAFT", // being written: the only state that can be edited or deleted
  CONFIRMED: "CONFIRMED", // agreed with the customer / placed with the vendor
  CLOSED: "CLOSED", // finished early: nothing more will be delivered / received or billed on it
  CANCELLED: "CANCELLED",
});

const ORDER_ACTIONS = Object.freeze({
  confirm: { from: ["DRAFT"], to: "CONFIRMED" },
  cancel: { from: ["DRAFT", "CONFIRMED"], to: "CANCELLED" },
  close: { from: ["CONFIRMED"], to: "CLOSED" },
  reopen: { from: ["CLOSED"], to: "CONFIRMED" },
});
const ORDER_EDITABLE = Object.freeze(["DRAFT"]);
// What can still be received / delivered and invoiced against.
const ORDER_OPEN = Object.freeze(["CONFIRMED"]);

const RECEIPT_STATUS = Object.freeze({ DRAFT: "DRAFT", RECEIVED: "RECEIVED", CANCELLED: "CANCELLED" });
const RECEIPT_ACTIONS = Object.freeze({
  receive: { from: ["DRAFT"], to: "RECEIVED" },
  // a receipt can be withdrawn until an invoice is raised from it (the service checks that)
  cancel: { from: ["DRAFT", "RECEIVED"], to: "CANCELLED" },
});
const RECEIPT_EDITABLE = Object.freeze(["DRAFT"]);

const INVOICE_STATE = Object.freeze({ NONE: "NONE", DRAFT: "DRAFT", INVOICED: "INVOICED" });

const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

/**
 * How far each order line has got.
 *   orderLines    [{ _id, qty }]
 *   receiptLines  [{ sourceLineId, status, qty, receivedQty, invoiceStatus }]   (lines of receipts against the order, not cancelled)
 * A line's `ordered` is the order's quantity; `onTheWay` is what sits on draft receipts; `received` is what confirmed receipts
 * took in; `invoiced` is the part of that already on an approved invoice, and `toInvoice` the part still waiting for one.
 */
function orderProgress(orderLines, receiptLines = []) {
  const byLine = new Map();
  for (const l of orderLines || []) {
    byLine.set(String(l._id), { lineId: String(l._id), ordered: r3(l.qty), onTheWay: 0, received: 0, invoiced: 0, draftInvoice: 0 });
  }
  for (const r of receiptLines) {
    const row = byLine.get(String(r.sourceLineId));
    if (!row || r.status === RECEIPT_STATUS.CANCELLED) continue;
    if (r.status === RECEIPT_STATUS.RECEIVED) {
      const got = Number(r.receivedQty ?? r.qty) || 0;
      row.received += got;
      if (r.invoiceStatus === INVOICE_STATE.INVOICED) row.invoiced += got;
      else if (r.invoiceStatus === INVOICE_STATE.DRAFT) row.draftInvoice += got;
    } else {
      row.onTheWay += Number(r.qty) || 0;
    }
  }
  const lines = {};
  let ordered = 0;
  let received = 0;
  let invoiced = 0;
  for (const [id, row] of byLine) {
    const out = {
      ...row,
      received: r3(row.received),
      onTheWay: r3(row.onTheWay),
      invoiced: r3(row.invoiced),
      draftInvoice: r3(row.draftInvoice),
      toReceive: r3(Math.max(0, row.ordered - row.received - row.onTheWay)),
      toInvoice: r3(Math.max(0, row.received - row.invoiced - row.draftInvoice)),
    };
    lines[id] = out;
    ordered += out.ordered;
    received += out.received;
    invoiced += out.invoiced;
  }
  const stateOf = (done) => (done <= 0 ? "NONE" : done + 1e-9 >= ordered ? "ALL" : "PART");
  return {
    lines,
    totals: { ordered: r3(ordered), received: r3(received), invoiced: r3(invoiced) },
    receiving: stateOf(received), // NONE | PART | ALL
    invoicing: stateOf(invoiced),
  };
}

/** The words an order's progress reads in, from orderProgress. */
function progressLabel(progress, kind = "purchase") {
  const got = kind === "sales" ? "delivered" : "received";
  if (progress.invoicing === "ALL") return "Invoiced";
  if (progress.invoicing === "PART") return "Partly invoiced";
  if (progress.receiving === "ALL") return `Fully ${got}`;
  if (progress.receiving === "PART") return `Partly ${got}`;
  return `Not ${got}`;
}

/**
 * The 3-way check: an invoice may bill no more of an item than the receipts it is made from took in. `invoiceLines` are
 * [{ itemId, qty }], `receiptLines` [{ itemId, receivedQty }]; returns the lines that go over: [{ itemId, billed, received }].
 */
function overBilled(invoiceLines, receiptLines) {
  const got = new Map();
  for (const r of receiptLines) got.set(String(r.itemId), (got.get(String(r.itemId)) || 0) + (Number(r.receivedQty) || 0));
  const billed = new Map();
  for (const l of invoiceLines) billed.set(String(l.itemId), (billed.get(String(l.itemId)) || 0) + (Number(l.qty) || 0));
  const over = [];
  for (const [itemId, qty] of billed) {
    const have = got.get(itemId) || 0;
    if (r3(qty) > r3(have) + 1e-9) over.push({ itemId, billed: r3(qty), received: r3(have) });
  }
  return over;
}

module.exports = {
  ORDER_STATUS, ORDER_ACTIONS, ORDER_EDITABLE, ORDER_OPEN, RECEIPT_STATUS, RECEIPT_ACTIONS, RECEIPT_EDITABLE, INVOICE_STATE,
  orderProgress, progressLabel, overBilled,
};
