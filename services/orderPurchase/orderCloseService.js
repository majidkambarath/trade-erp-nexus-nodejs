const AppError = require("../../utils/AppError");
const Transaction = require("../../models/modules/transactionModel");
const DeliveryNote = require("../../models/modules/deliveryNoteModel");
const TransactionService = require("./transactionService");
const S = require("./salesDocumentSupport");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { getTenant } = require("../../utils/tenant");
const { roundTo } = require("../../utils/pricing");
const { planCloseShort, trimmedLines, shortLines } = require("../../utils/closeShort");

// Closing a sales order short: the customer has taken part of it and will never take the rest. The rules
// are in utils/closeShort.js; this applies them.
//
//   draft     the lines are cut down to what was delivered (priced again by the same code that priced
//             them), so approving the order bills exactly the goods that went out. A copy of the order as
//             it was is kept, so reopening puts it back.
//   approved  the invoice, stock and ledger already cover the full order and are left alone. The order is
//             marked closed and the undelivered goods are put right by a sales return (stock back in,
//             customer credited), which the deal screen asks for until it exists.
//
// It posts nothing and moves no stock itself.

const fail = (message, status, code) => new AppError(message, status, code);
const DEAD_RETURN = ["REJECTED", "CANCELLED"];

function cleanReason(value) {
  const reason = String(value ?? "").trim().replace(/\s+/g, " ");
  if (reason.length < 3) throw fail("Say why the rest will not be delivered", 400, "REASON_REQUIRED");
  if (reason.length > 500) throw fail("The reason is too long: keep it under 500 characters", 400, "REASON_TOO_LONG");
  return reason;
}

// The stored line as a pricing input at another quantity; everything else the line carries (batch, brand,
// origin) and its id stay as they were, and the money columns are worked out again.
const repriceLine = (line, qty) => {
  const stored = typeof line.toObject === "function" ? line.toObject() : line;
  return { ...stored, ...S.toPricingInput(stored, qty, stored.qty) };
};

async function loadOrder(id, { session, withOriginal = false } = {}) {
  if (!S.isId(id)) throw fail("Invalid sales order", 400, "ORDER_REQUIRED");
  let q = Transaction.findById(id);
  if (withOriginal) q = q.select("+closedShort.original");
  if (session) q = q.session(session);
  const order = await q;
  if (!order || order.type !== "sales_order") throw fail("Sales order not found", 404, "ORDER_NOT_FOUND");
  return order;
}

// The notes raised against the order's own lines. An order raised FROM delivery notes (goods first) has
// none of those: it already bills what was delivered, so there is nothing to close.
async function notesAgainst(order, { session }) {
  const { companyId } = getTenant();
  const q = DeliveryNote.find({ companyId, "source.kind": "sales_order", "source.id": order._id })
    .select("deliveryNoteNo status items.sourceLineId items.qty items.deliveredQty")
    .lean();
  return session ? q.session(session) : q;
}

async function plan(order, { session }) {
  const notes = await notesAgainst(order, { session });
  const result = planCloseShort(order.toObject(), notes);
  if (!result.blocked) return result;
  if (!notes.length) {
    const { companyId } = getTenant();
    const q = DeliveryNote.exists({ companyId, "invoice.id": order._id, "source.kind": { $ne: "sales_order" } });
    if (await (session ? q.session(session) : q)) {
      throw fail(`${order.transactionNo} was raised from delivery notes, so it already bills what was delivered`, 409, "ORDER_FROM_NOTES");
    }
  }
  throw fail(result.blocked.message, result.blocked.status, result.blocked.code);
}

// What the order becomes if it is cut down, priced but not saved.
async function trimmed(order, result, { session }) {
  const plain = order.toObject();
  const items = trimmedLines(plain, result, repriceLine);
  const built = await TransactionService.buildPricing(
    { items, charges: plain.charges, discount: plain.discount, date: plain.date },
    session
  );
  // `rate` is the line's net value, the way the order form stores it
  const processedItems = built.processedItems.map((i) => ({ ...i, rate: i.taxableAmount }));
  return { ...built, processedItems };
}

class OrderCloseService {
  // Sales returns raised against orders: each is what puts the undelivered goods of an approved order right.
  static async returnsFor(orderIds, { session } = {}) {
    if (!orderIds.length) return [];
    const q = Transaction.find({ type: "sales_return", "returnOf.transactionId": { $in: orderIds }, status: { $nin: DEAD_RETURN } })
      .select("transactionNo status totalAmount returnOf.transactionId date")
      .lean();
    return session ? q.session(session) : q;
  }

  // What closing would do, so the person sees it before confirming. Writes nothing.
  static async preview(orderId) {
    const order = await loadOrder(orderId);
    const result = await plan(order, {});
    let newTotal = null;
    let valueShort = result.valueShort;
    if (result.trim) {
      const built = await trimmed(order, result, {});
      newTotal = built.totalAmount;
      valueShort = roundTo(order.totalAmount - built.totalAmount);
    }
    return {
      order: { _id: order._id, transactionNo: order.transactionNo, status: order.status, date: order.date, totalAmount: order.totalAmount },
      mode: result.trim ? "trim" : "credit",
      lines: shortLines(result),
      valueShort,
      newTotal,
    };
  }

  static closeShort = withTransactionSession(async (orderId, input, by, session) => {
    const reason = cleanReason(input?.reason);
    const order = await loadOrder(orderId, { session });
    const result = await plan(order, { session });

    let valueShort = result.valueShort;
    let original;
    if (result.trim) {
      const built = await trimmed(order, result, { session });
      const before = order.toObject();
      original = { items: before.items, charges: before.charges, pricing: before.pricing, totalAmount: before.totalAmount };
      valueShort = roundTo(order.totalAmount - built.totalAmount);
      order.items = built.processedItems;
      order.charges = built.charges;
      order.pricing = built.pricing;
      order.totalAmount = built.totalAmount;
    }
    order.closedShort = {
      at: new Date(),
      by: String(by),
      reason,
      trimmed: result.trim,
      valueShort,
      lines: shortLines(result).map(({ lineId, description, ordered, delivered, short, valueShort: v }) => ({ lineId, description, ordered, delivered, short, valueShort: v })),
      ...(original ? { original } : {}),
    };
    await order.save({ session });
    return order;
  });

  // Undoes closing, while nothing has been built on it.
  static reopen = withTransactionSession(async (orderId, by, session) => {
    const order = await loadOrder(orderId, { session, withOriginal: true });
    const closed = order.closedShort;
    if (!closed?.at) throw fail(`${order.transactionNo} is not closed short`, 409, "NOT_CLOSED_SHORT");
    if (closed.trimmed) {
      if (order.status !== "DRAFT") {
        throw fail(`${order.transactionNo} was approved after it was closed short, so its lines can no longer be put back`, 409, "REOPEN_NOT_POSSIBLE");
      }
      if (!closed.original?.items) {
        throw fail("The order as it was before is not kept. Edit the order and put the quantities back", 409, "REOPEN_NOT_POSSIBLE");
      }
      order.items = closed.original.items;
      order.charges = closed.original.charges || [];
      order.pricing = closed.original.pricing;
      order.totalAmount = closed.original.totalAmount;
    } else {
      const returns = await OrderCloseService.returnsFor([order._id], { session });
      if (returns.length) {
        throw fail(`${returns[0].transactionNo} was raised for the goods that were not delivered, so ${order.transactionNo} cannot be reopened`, 409, "RETURN_RAISED");
      }
    }
    order.closedShort = undefined;
    await order.save({ session });
    return order;
  });
}

module.exports = OrderCloseService;
