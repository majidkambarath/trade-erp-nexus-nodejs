const AppError = require("../../utils/AppError");
const GoodsReceipt = require("../../models/modules/goodsReceiptModel");
const { getTenant } = require("../../utils/tenant");
const { INVOICE_STATE, overBilled } = require("../../utils/tradeOrders");

// A goods receipt points at the purchase invoice made from it, but the invoice is a separate record with a life of its
// own: it is approved, rejected, cancelled or deleted. This module is the one place that keeps the pointer honest, and
// the one place the 3-way match is applied. The transaction service calls it; it requires only models, so there is no
// import cycle with that service. (The sales side's twin is deliveryNoteLinks.js.)
//
//   approved                    -> the goods are invoiced (stock and ledger have moved)
//   still a draft               -> an invoice is on its way
//   rejected / cancelled / gone -> the invoice does not exist: the receipts can be invoiced another way

const DEAD = ["REJECTED", "CANCELLED"];

const stateOf = (transaction, deleted) => {
  if (deleted || DEAD.includes(transaction.status)) return INVOICE_STATE.NONE;
  return transaction.status === "APPROVED" ? INVOICE_STATE.INVOICED : INVOICE_STATE.DRAFT;
};

async function onPurchaseInvoiceChanged(transaction, { session, deleted = false } = {}) {
  if (!transaction || transaction.type !== "purchase_order") return;
  const { companyId } = getTenant();
  const state = stateOf(transaction, deleted);
  if (state === INVOICE_STATE.NONE) {
    await GoodsReceipt.updateMany({ companyId, "invoice.id": transaction._id }, { $set: { invoiceStatus: INVOICE_STATE.NONE }, $unset: { invoice: 1 } }, { session });
    return;
  }
  await GoodsReceipt.updateMany({ companyId, "invoice.id": transaction._id }, { $set: { invoiceStatus: state } }, { session });
}

// The 3-way match: a purchase invoice made from goods receipts may bill no more of an item than they took in. A draft
// invoice can be edited, so this is applied when it is saved and again when it is approved. An invoice with no receipts
// behind it (a direct purchase) is not judged.
async function assertWithinReceipts(transaction, items, { session } = {}) {
  if (!transaction || transaction.type !== "purchase_order") return;
  const { companyId } = getTenant();
  const q = GoodsReceipt.find({ companyId, "invoice.id": transaction._id, status: "RECEIVED" }).select("receiptNo items.itemId items.qty items.receivedQty").lean();
  const receipts = await (session ? q.session(session) : q);
  if (!receipts.length) return;
  const have = receipts.flatMap((r) => r.items.map((l) => ({ itemId: l.itemId, receivedQty: l.receivedQty ?? l.qty })));
  const lines = (items || []).map((l) => ({ itemId: l.itemId, qty: l.qty }));
  const over = overBilled(lines, have);
  if (!over.length) return;
  const first = over[0];
  throw new AppError(
    `The invoice bills ${first.billed} of an item but ${receipts.map((r) => r.receiptNo).join(", ")} received ${first.received}. An invoice made from goods received cannot bill more than was received.`,
    409,
    "BILLED_MORE_THAN_RECEIVED",
    { items: over }
  );
}

module.exports = { onPurchaseInvoiceChanged, assertWithinReceipts, stateOf };
