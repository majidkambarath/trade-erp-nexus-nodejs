// Closing a sales order short: the customer has taken part of it and will never take the rest.
// Pure - it is handed the order and the delivery notes raised against it and decides whether that is
// allowed and what is left, so the rules are tested without a database.
//
// What closing means depends on whether the order has been approved (invoiced) yet:
//   DRAFT     no stock or ledger has moved. The order's lines are cut down to what was delivered, so the
//             invoice it becomes charges for exactly the goods that went out.
//   APPROVED  the invoice, the stock and the ledger already cover the FULL order. Nothing is changed;
//             the order is marked closed and the undelivered goods are put right with a sales return
//             (goods back into stock, customer credited).

const { fulfilment } = require("./salesDocuments");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const EPS = 1e-9;

const block = (status, code, message) => ({ blocked: { status, code, message } });

// notes: the live delivery notes raised against this order from its own lines (`source` = this order)
function planCloseShort(order, notes = []) {
  if (!order || order.type !== "sales_order") return block(404, "ORDER_NOT_FOUND", "Sales order not found");
  const no = order.transactionNo;
  if (order.isOpening) return block(409, "ORDER_NOT_DELIVERABLE", `${no} is an opening balance invoice and has no goods to deliver`);
  if (!["DRAFT", "APPROVED"].includes(order.status)) {
    return block(409, "ORDER_NOT_OPEN", `${no} is ${String(order.status).toLowerCase()}; there is nothing to close`);
  }
  if (order.closedShort?.at) return block(409, "ALREADY_CLOSED_SHORT", `${no} has already been closed short`);

  const live = notes.filter((n) => n.status !== "CANCELLED");
  const open = live.filter((n) => n.status !== "DELIVERED");
  if (open.length) {
    return block(409, "OPEN_DELIVERY", `${open.map((n) => n.deliveryNoteNo).join(", ")} ${open.length === 1 ? "is" : "are"} not signed for yet. Confirm or cancel ${open.length === 1 ? "it" : "them"} first, so what was delivered is known`);
  }

  const delivery = live.flatMap((n) => (n.items || []).map((l) => ({ sourceLineId: l.sourceLineId, status: n.status, qty: l.qty, deliveredQty: l.deliveredQty })));
  const f = fulfilment(order.items, delivery);

  const rows = (order.items || []).map((l) => {
    const r = f[String(l._id)];
    const ordered = r.ordered;
    const delivered = round3(r.delivered);
    const short = round3(Math.max(0, ordered - delivered));
    // the share of the line's own total (discount and VAT included) that was never delivered
    const valueShort = ordered > 0 && short > 0 ? round2(((Number(l.lineTotal) || 0) * short) / ordered) : 0;
    return { lineId: l._id, itemId: l.itemId, description: l.description || "", ordered, delivered, short, valueShort };
  });

  if (!rows.some((r) => r.delivered > EPS)) {
    return block(409, "NOTHING_DELIVERED", `Nothing has been delivered against ${no}. Reject or cancel the order instead of closing it short`);
  }
  if (!rows.some((r) => r.short > EPS)) {
    return block(409, "NOTHING_LEFT", `Everything ordered on ${no} was delivered, so there is nothing left to close`);
  }
  return {
    lines: rows,
    valueShort: round2(rows.reduce((t, r) => t + r.valueShort, 0)),
    // a draft has not been invoiced: its lines are cut down. An approved order cannot be edited.
    trim: order.status === "DRAFT",
  };
}

// The lines a closed order is left with: what was delivered, at the order's own prices. A line nothing
// was delivered of goes; a part-delivered line takes the delivered quantity. Keeps each line's id, so
// the delivery notes still point at it. `reprice(line, qty)` is supplied by the caller (the stored line
// as a pricing input at that quantity), which keeps this file free of the pricing code.
function trimmedLines(order, plan, reprice) {
  const byId = new Map(plan.lines.map((r) => [String(r.lineId), r]));
  return (order.items || [])
    .map((l) => {
      const r = byId.get(String(l._id));
      if (!r || r.delivered <= EPS) return null;
      return r.short > EPS ? reprice(l, r.delivered) : reprice(l, l.qty);
    })
    .filter(Boolean);
}

// What the person is shown and what is stored: only the lines that fell short.
const shortLines = (plan) => plan.lines.filter((r) => r.short > EPS);

module.exports = { planCloseShort, trimmedLines, shortLines };
