// One customer's quotations, sales orders and delivery notes, joined into the DEALS they belong to.
// Pure: it is handed the documents and links them, so the rules are tested without a database.
//
// A deal is one chain, and a document is in exactly one:
//   quotation -> sales order -> delivery notes      (the order is the invoice once it is approved)
//   quotation -> delivery notes -> sales order      (goods first: the order is raised from the notes)
// A document with nothing to join (an offer nobody answered, a note on its own) is a deal of its own.
//
// The links are the ones the documents already carry: an order's `quoteRef`, a quotation's `convertedTo`,
// a note's `source` (what it was made from) and `invoice` (the order that invoices it).

const { invoiceClock, quotationExpiry, fulfilment } = require("./salesDocuments");
const { isService } = require("./itemKinds");

const STAGE = Object.freeze({
  QUOTED: "quoted", // an offer is out, or waiting for an answer
  ORDERED: "ordered", // a sales order exists and nothing has been delivered
  DELIVERING: "delivering", // goods are on their way or part of them are
  DELIVERED: "delivered", // everything is signed for; the invoice is what is left
  INVOICED: "invoiced", // the sales order is approved: stock and ledger have moved
  LOST: "lost", // the customer said no
  LAPSED: "lapsed", // the offer ran out
});

const DEAD_ORDER = ["REJECTED", "CANCELLED"];
const id = (v) => (v === undefined || v === null ? "" : String(v));
const time = (v) => (v ? new Date(v).getTime() || 0 : 0);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const withoutLines = ({ items, ...rest }) => rest;
const CLOCK_RANK = { within: 1, dueSoon: 2, pastStandard: 3, overdue: 4 };

function stageOf({ quotation, order, notes, delivery }, expired) {
  if (order?.status === "APPROVED") return STAGE.INVOICED;
  if (notes.length && notes.every((n) => n.status === "DELIVERED") && (!delivery || delivery.complete)) return STAGE.DELIVERED;
  if (notes.length) return STAGE.DELIVERING;
  if (order) return STAGE.ORDERED;
  if (quotation?.status === "REJECTED") return STAGE.LOST;
  if (expired) return STAGE.LAPSED;
  return STAGE.QUOTED;
}

// An order the customer will not take the rest of (utils/closeShort.js): what fell short and why, and - for an
// approved order, which was invoiced in full - the sales returns that put the undelivered goods right.
function closeShortOf(order, returns) {
  const c = order?.closedShort;
  if (!c || !c.at) return null;
  const mine = (returns || [])
    .filter((r) => id(r.returnOf?.transactionId) === id(order._id))
    .map((r) => ({ _id: r._id, transactionNo: r.transactionNo, status: r.status, totalAmount: r.totalAmount }));
  const owed = !c.trimmed && round2(c.valueShort) > 0;
  return {
    at: c.at, reason: c.reason || "", trimmed: Boolean(c.trimmed), valueShort: round2(c.valueShort),
    left: (c.lines || []).map((l) => ({ description: l.description, qty: l.short })),
    returns: mine,
    // an invoiced order billed goods that never left: a sales return is what corrects it
    creditDue: owed && !mine.some((r) => r.status === "APPROVED"),
  };
}

// What is left to deliver on an order: the same sums the delivery notes use to stop over-delivery, so the
// deal and the note can never disagree. Only for goods delivered against the order itself; when the order
// was raised FROM the notes (goods first) there is no order line to measure against.
function deliveryOf(order, notes) {
  if (!order || !Array.isArray(order.items) || !order.items.length) return null;
  const lines = notes.flatMap((n) => (n.items || []).map((l) => ({ sourceLineId: l.sourceLineId, status: n.status, qty: l.qty, deliveredQty: l.deliveredQty })));
  const names = new Map(order.items.map((l) => [id(l._id), l.description || ""]));
  const services = new Set(order.items.filter(isService).map((l) => id(l._id))); // rendered, not delivered: never "left to deliver"
  const remaining = Object.entries(fulfilment(order.items, lines))
    .filter(([lineId, r]) => r.remaining > 0 && !services.has(lineId))
    .map(([lineId, r]) => ({ description: names.get(lineId), qty: r.remaining }));
  // closed short: whatever is left will never be delivered, so the delivery is finished
  if (order.closedShort?.at) return { started: notes.length > 0, complete: true, remaining: [] };
  return { started: notes.length > 0, complete: remaining.length === 0, remaining };
}

// The worst 14-day invoice clock among the delivered notes that are not invoiced yet.
function worstClock(notes, now) {
  let worst = null;
  for (const n of notes) {
    if (n.status !== "DELIVERED" || n.invoiceStatus === "INVOICED") continue;
    const c = invoiceClock(n.deliveredAt, now);
    if (c && (!worst || CLOCK_RANK[c.clock] > CLOCK_RANK[worst.clock])) worst = { clock: c.clock, standardDue: c.standardDue, summaryDue: c.summaryDue, daysToStandard: c.daysToStandard };
  }
  return worst;
}

function buildFlow({ quotations = [], orders = [], notes = [], returns = [] }, now = new Date()) {
  const liveQuotes = quotations.filter((q) => q.status !== "SUPERSEDED"); // its revision stands for it
  const liveOrders = orders.filter((o) => !DEAD_ORDER.includes(o.status));
  const liveNotes = notes.filter((n) => n.status !== "CANCELLED");

  const quoteById = new Map(liveQuotes.map((q) => [id(q._id), q]));
  const quoteByNo = new Map(liveQuotes.map((q) => [q.quotationNo, q]));
  const usedQuotes = new Set();
  const usedNotes = new Set();

  // 1. a deal for every live sales order
  const byOrder = new Map(liveOrders.map((o) => [id(o._id), { quotation: null, order: o, notes: [] }]));
  for (const n of liveNotes) {
    const orderId = n.source?.kind === "sales_order" ? id(n.source.id) : id(n.invoice?.id);
    const deal = byOrder.get(orderId);
    if (deal) { deal.notes.push(n); usedNotes.add(id(n._id)); }
  }
  for (const deal of byOrder.values()) {
    const { order } = deal;
    let quote = order.quoteRef ? quoteByNo.get(order.quoteRef) : null;
    quote ||= liveQuotes.find((q) => q.convertedTo?.kind === "sales_order" && id(q.convertedTo.id) === id(order._id));
    // goods first: the offer became a delivery note, and that note was invoiced by this order
    if (!quote) {
      const viaNote = deal.notes.find((n) => n.source?.kind === "quotation" && quoteById.has(id(n.source.id)));
      if (viaNote) quote = quoteById.get(id(viaNote.source.id));
    }
    if (quote && !usedQuotes.has(id(quote._id))) { deal.quotation = quote; usedQuotes.add(id(quote._id)); }
  }

  // 2. a deal for every offer that has not become an order
  const deals = [...byOrder.values()];
  for (const q of liveQuotes) {
    if (usedQuotes.has(id(q._id))) continue;
    const mine = liveNotes.filter((n) => !usedNotes.has(id(n._id)) && n.source?.kind === "quotation" && id(n.source.id) === id(q._id));
    mine.forEach((n) => usedNotes.add(id(n._id)));
    deals.push({ quotation: q, order: null, notes: mine });
  }

  // 3. a deal for every note that belongs to nothing else
  for (const n of liveNotes) if (!usedNotes.has(id(n._id))) deals.push({ quotation: null, order: null, notes: [n] });

  const chains = deals.map((d) => {
    const notesSorted = [...d.notes].sort((a, b) => time(a.deliveredAt || a.date) - time(b.deliveredAt || b.date));
    const expiry = d.quotation ? quotationExpiry(d.quotation, now) : { expired: false, daysLeft: null };
    const mode = notesSorted.length ? (notesSorted.some((n) => n.source?.kind === "sales_order") ? "order_first" : "delivery_first") : null;
    const delivery = d.order && (mode === "order_first" || !notesSorted.length) ? deliveryOf(d.order, notesSorted) : null;
    const stage = stageOf({ ...d, notes: notesSorted, delivery }, expiry.expired);
    const latest = Math.max(time(d.quotation?.date), time(d.order?.date), ...notesSorted.map((n) => time(n.deliveredAt || n.date)));
    return {
      key: d.order ? `o:${id(d.order._id)}` : d.quotation ? `q:${id(d.quotation._id)}` : `n:${id(notesSorted[0]._id)}`,
      stage,
      mode,
      quotation: d.quotation ? { ...d.quotation, expired: expiry.expired, daysLeft: expiry.daysLeft } : null,
      order: d.order ? withoutLines(d.order) : null,
      notes: notesSorted.map(withoutLines),
      delivery,
      closeShort: closeShortOf(d.order, returns),
      amount: round2(d.order?.totalAmount ?? d.quotation?.totalAmount ?? notesSorted.reduce((t, n) => t + (n.totalAmount || 0), 0)),
      date: latest ? new Date(latest) : null,
      // what to chase: the invoice a delivery is waiting for, and an offer about to run out
      invoiceClock: worstClock(notesSorted, now),
      expiresInDays: d.quotation?.status === "SENT" && !expiry.expired && expiry.daysLeft !== null && expiry.daysLeft <= 7 ? expiry.daysLeft : null,
    };
  });
  chains.sort((a, b) => time(b.date) - time(a.date));

  // the figures above the list, from the same chains so they cannot disagree with it
  const sum = (rows, pick) => ({ count: rows.length, value: round2(rows.reduce((t, r) => t + (pick(r) || 0), 0)) });
  const quotes = chains.map((c) => c.quotation).filter(Boolean);
  const summary = {
    outWithCustomer: sum(quotes.filter((q) => q.status === "SENT" && !q.expired), (q) => q.totalAmount),
    acceptedNotOrdered: sum(quotes.filter((q) => q.status === "ACCEPTED"), (q) => q.totalAmount),
    ordersToApprove: sum(liveOrders.filter((o) => o.status === "DRAFT"), (o) => o.totalAmount),
    deliveredNotInvoiced: sum(liveNotes.filter((n) => n.status === "DELIVERED" && n.invoiceStatus !== "INVOICED"), (n) => n.totalAmount),
    pastInvoiceWindow: chains.filter((c) => ["pastStandard", "overdue"].includes(c.invoiceClock?.clock)).length,
  };
  return { chains, summary };
}

module.exports = { buildFlow, STAGE, stageOf, worstClock };
