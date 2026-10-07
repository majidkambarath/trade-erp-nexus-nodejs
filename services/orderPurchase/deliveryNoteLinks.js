const AppError = require("../../utils/AppError");
const Quotation = require("../../models/modules/quotationModel");
const DeliveryNote = require("../../models/modules/deliveryNoteModel");
const { getTenant } = require("../../utils/tenant");
const { INVOICE_STATE } = require("../../utils/salesDocuments");

// A quotation or delivery note points at the sales order that invoices it, but the order is a
// separate record with a life of its own: it is approved, rejected, cancelled or deleted. This
// module is the one place that keeps the pointer honest. Transaction service calls it after any
// of those happen; it requires only models, so there is no import cycle with that service.
//
//   approved                    -> the goods are invoiced (stock and ledger have moved)
//   still a draft               -> an invoice is on its way
//   rejected / cancelled / gone -> the invoice does not exist. Notes against it become ordinary
//                                  notes again, so they can be invoiced another way, and a quotation
//                                  that became that order is open for conversion again.

const DEAD_ORDER = ["REJECTED", "CANCELLED"];

function invoiceStateOf(transaction, deleted) {
  if (deleted || DEAD_ORDER.includes(transaction.status)) return INVOICE_STATE.NONE;
  return transaction.status === "APPROVED" ? INVOICE_STATE.INVOICED : INVOICE_STATE.DRAFT;
}

// A quotation that was converted into something that no longer exists goes back to ACCEPTED: the
// customer did say yes, and nothing has been delivered or invoiced.
async function releaseQuotationsFor(id, { session } = {}) {
  const { companyId } = getTenant();
  await Quotation.updateMany(
    { companyId, "convertedTo.id": id, status: "CONVERTED" },
    { $set: { status: "ACCEPTED" }, $unset: { convertedTo: 1, convertedAt: 1 } },
    { session }
  );
}

async function onSalesOrderChanged(transaction, { session, deleted = false } = {}) {
  if (!transaction || transaction.type !== "sales_order") return;
  const { companyId } = getTenant();
  const id = transaction._id;
  const state = invoiceStateOf(transaction, deleted);

  if (state === INVOICE_STATE.NONE) {
    // Cut the notes loose from an order that will never be invoiced.
    await DeliveryNote.updateMany(
      { companyId, "invoice.id": id },
      { $set: { invoiceStatus: INVOICE_STATE.NONE }, $unset: { invoice: 1 } },
      { session }
    );
    await DeliveryNote.updateMany(
      { companyId, "source.kind": "sales_order", "source.id": id },
      { $set: { "source.kind": "manual" }, $unset: { "source.id": 1 } },
      { session }
    );
    await releaseQuotationsFor(id, { session });
    return;
  }

  await DeliveryNote.updateMany({ companyId, "invoice.id": id }, { $set: { invoiceStatus: state } }, { session });
}

// What a draft order's lines have already promised to delivery notes: for each line, the quantity on notes
// that are not cancelled (what the customer took on signed notes, what is on the way on the rest).
async function committedByLine(orderId, { session } = {}) {
  const { companyId } = getTenant();
  const q = DeliveryNote.find({ companyId, "source.kind": "sales_order", "source.id": orderId, status: { $ne: "CANCELLED" } })
    .select("deliveryNoteNo status items.sourceLineId items.qty items.deliveredQty")
    .lean();
  const notes = await (session ? q.session(session) : q);
  const out = new Map();
  for (const n of notes) {
    for (const l of n.items || []) {
      const qty = Number(n.status === "DELIVERED" ? l.deliveredQty ?? l.qty : l.qty) || 0;
      if (qty <= 0) continue; // a line the customer took none of promises nothing
      const key = String(l.sourceLineId);
      const row = out.get(key) || { qty: 0, notes: [] };
      row.qty += qty;
      if (!row.notes.includes(n.deliveryNoteNo)) row.notes.push(n.deliveryNoteNo);
      out.set(key, row);
    }
  }
  return out;
}

// Editing a draft order rebuilds its lines from the form, and a line the form did not carry an id for gets a
// new one - which would cut it loose from every delivery note raised against it. So a line that arrives
// without an id takes the id of the stored line for the same item that nothing else has claimed.
function relinkLines(order, items) {
  const stored = (order.items || []).map((i) => (typeof i.toObject === "function" ? i.toObject() : i));
  const claimed = new Set(items.filter((i) => i && i._id).map((i) => String(i._id)));
  return items.map((item) => {
    if (!item || item._id) return item;
    const match = stored.find((s) => !claimed.has(String(s._id)) && String(s.itemId) === String(item.itemId));
    if (!match) return item;
    claimed.add(String(match._id));
    return { ...item, _id: match._id };
  });
}

// An edit may not take away what delivery notes already rely on: a line they carry goods for must stay, at
// no less than the quantity they cover.
async function assertDeliveriesKept(order, items, { session } = {}) {
  if (order.type !== "sales_order") return;
  const committed = await committedByLine(order._id, { session });
  if (!committed.size) return;
  const byId = new Map(items.filter((i) => i._id).map((i) => [String(i._id), i]));
  for (const [lineId, row] of committed) {
    const line = byId.get(lineId);
    const was = (order.items || []).find((i) => String(i._id) === lineId);
    const name = was?.description || "A line";
    if (!line || (was && String(line.itemId) !== String(was.itemId))) {
      throw new AppError(`${name} is on ${row.notes.join(", ")} and cannot be taken off or changed on the order`, 409, "ORDER_LINE_HAS_DELIVERIES");
    }
    if (Number(line.qty) + 1e-9 < row.qty) {
      throw new AppError(`${name}: ${row.qty} is already on ${row.notes.join(", ")}, so the order cannot go below that`, 409, "ORDER_QTY_BELOW_DELIVERED");
    }
  }
}

// True when the edit changes what is ordered (a line added, removed or at another quantity) - the only kind
// of edit that lifts a "closed short" mark.
function linesChanged(order, items) {
  const stored = new Map((order.items || []).map((i) => [String(i._id), Number(i.qty)]));
  if (stored.size !== items.length) return true;
  return items.some((i) => !i._id || stored.get(String(i._id)) !== Number(i.qty));
}

module.exports = { onSalesOrderChanged, releaseQuotationsFor, invoiceStateOf, relinkLines, assertDeliveriesKept, linesChanged };
