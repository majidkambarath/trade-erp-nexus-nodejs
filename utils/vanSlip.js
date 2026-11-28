// The slip a salesman prints for a sale made from the van: everything the printed receipt says, gathered in ONE place
// so the first print, a reprint and every kind of printer (the print dialog, a Bluetooth thermal printer) print the
// same thing. Pure: the service reads the records, this decides what of them is printed.
//
// Like the customer's shared copy (utils/shareSnapshot.js) it is built from an explicit list of fields, never by
// spreading a record: an invoice line carries its cost and batches, a customer their credit limit and bank details,
// and none of that belongs on a paper handed over at a shop's door. The only id is the invoice's own (a reprint names it).

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const MODES = ["cash", "card", "cheque", "transfer"];

/** The customer's address on one line: the street and the place, each once. */
function addressOf(c = {}) {
  const parts = [c.billingAddress, c.city, c.emirate].map(str).filter(Boolean);
  const seen = new Set();
  return parts.filter((p) => (seen.has(p.toLowerCase()) ? false : seen.add(p.toLowerCase()))).join(", ");
}

/** The VAT by rate, so a slip of one rate says "VAT 5%" and a mixed one shows a line per rate. */
function vatByRate(lines) {
  const by = new Map();
  for (const l of lines) {
    if (!(l.vatAmount > 0) && !(l.vatPercent > 0)) continue;
    const k = l.vatPercent;
    by.set(k, round2((by.get(k) || 0) + l.vatAmount));
  }
  return [...by].sort((a, b) => b[0] - a[0]).map(([rate, amount]) => ({ rate, amount }));
}

/**
 * The money taken for this invoice. A receipt is counted when it names the invoice; an approved one is money received,
 * a transfer still waiting for the bank is shown apart (it is not money until the office sees it), a rejected or
 * cancelled one is ignored. A sale paid with nothing is a credit sale.
 */
function paymentOf(receipts, invoiceId) {
  const rows = [];
  for (const r of receipts || []) {
    const status = str(r.status).toLowerCase();
    // approved is money received; pending (or a draft) is still waiting; rejected and cancelled (a deleted voucher) are not money at all
    if (!["approved", "pending", "draft"].includes(status)) continue;
    const links = r.linkedInvoices || [];
    const mine = links.filter((l) => String(l.invoiceId) === String(invoiceId));
    if (!mine.length) continue;
    // a receipt for this invoice alone counts whole (what it took beyond the invoice - a container deposit - was paid with
    // it); one that settled several invoices counts only what it set against this one
    // a stored receipt keeps what it set against an invoice as allocatedAmount
    const amount = links.length === mine.length ? num(r.totalAmount) : mine.reduce((t, l) => t + num(l.allocatedAmount ?? l.amount), 0);
    const mode = MODES.includes(str(r.paymentMode)) ? str(r.paymentMode) : str(r.paymentMode) === "online" ? "transfer" : "cash";
    rows.push({ number: str(r.voucherNo), mode, amount: round2(amount), waiting: status !== "approved" });
  }
  const received = round2(rows.filter((r) => !r.waiting).reduce((t, r) => t + r.amount, 0));
  const waiting = round2(rows.filter((r) => r.waiting).reduce((t, r) => t + r.amount, 0));
  const modes = [...new Set(rows.map((r) => r.mode))];
  return { mode: modes.length === 0 ? "credit" : modes.length === 1 ? modes[0] : "mixed", modes, received, waiting, receipts: rows };
}

/** Containers that changed hands with this invoice, by type, and the deposit they are worth. */
function containersOf(moves, typeNames) {
  const by = new Map();
  let deposit = 0;
  for (const m of moves || []) {
    const k = String(m.typeId);
    const row = by.get(k) || { name: typeNames.get(k) || "", given: 0, collected: 0 };
    row.given += num(m.given);
    row.collected += num(m.collected);
    by.set(k, row);
    deposit += (num(m.given) - num(m.collected)) * num(m.deposit);
  }
  return { containers: [...by.values()].filter((r) => r.given || r.collected), deposit: round2(deposit) };
}

/**
 * @param {object} p
 * @param {object} p.invoice     the stored sales invoice (a Transaction)
 * @param {object} p.customer    the customer record
 * @param {object} p.trip        the van trip
 * @param {Map}    p.items       itemId -> { barcode, unit } from the item master, as it is now
 * @param {object[]} p.receipts  receipt vouchers tagged with the trip
 * @param {object[]} p.moves     container moves made with this invoice
 * @param {Map}    p.typeNames   container type id -> name
 */
function slipModel({ invoice = {}, customer = {}, trip = {}, items = new Map(), receipts = [], moves = [], typeNames = new Map() }) {
  const lines = (invoice.items || []).map((l, i) => {
    const master = items.get(String(l.itemId)) || {};
    return {
      n: i + 1,
      code: str(master.barcode) || str(l.itemCode),
      description: str(l.description),
      qty: num(l.qty),
      unit: str(master.unit),
      price: round2(num(l.price)),
      discount: round2(num(l.discountAmount)),
      vatPercent: num(l.vatPercent),
      vatAmount: round2(num(l.vatAmount)),
      total: round2(num(l.lineTotal)),
    };
  });
  const p = invoice.pricing || {};
  const lineSum = round2(lines.reduce((t, l) => t + l.qty * l.price, 0));
  const discount = round2(num(p.lineDiscount) + num(p.headerDiscount));
  const vat = round2(num(p.lineVat) + num(p.chargesVat) || lines.reduce((t, l) => t + l.vatAmount, 0));
  const total = round2(num(invoice.totalAmount));
  const payment = paymentOf(receipts, invoice._id);
  const { containers, deposit } = containersOf(moves, typeNames);
  const owed = round2(total + deposit - payment.received);
  return {
    invoice: {
      id: String(invoice._id || ""),
      number: str(invoice.transactionNo),
      date: invoice.date || null,
      reference: str(invoice.lpono),
      status: str(invoice.status),
      vatRegistered: invoice.vatRegistered !== false, // absent = registered, as on every document from before the flag
    },
    trip: { tripNo: str(trip.tripNo), vanCode: str(trip.vanCode), vanName: str(trip.vanName), salesmanName: str(trip.salesmanName) },
    customer: {
      name: str(customer.customerName),
      code: str(customer.customerId),
      address: addressOf(customer),
      phone: str(customer.phone),
      trn: str(customer.vat?.trn || customer.trnNumber || customer.trnNO),
    },
    lines,
    totals: {
      quantity: round2(lines.reduce((t, l) => t + l.qty, 0)),
      // what the goods came to before any discount and the tax: the price list's figure, so a discount shows on its own line
      subTotal: round2(num(p.gross) || lineSum),
      discount,
      charges: round2(num(p.chargesNet)),
      vat,
      vatByRate: vatByRate(lines),
      roundOff: round2(num(p.roundOff)),
      total,
    },
    payment: { ...payment, balanceDue: Math.max(0, owed) },
    containers,
    deposit,
  };
}

module.exports = { slipModel, paymentOf, containersOf, addressOf, vatByRate };
