const JobCard = require("../../models/modules/garage/jobCardModel");
const { getTenant } = require("../../utils/tenant");

// A job card points at the sales invoices it raised (card.invoices[]), but each invoice is a separate record
// with a life of its own: it is approved, rejected, cancelled or deleted. This module is the one place that
// keeps that pointer honest, following services/orderPurchase/deliveryNoteLinks.js exactly: TransactionService
// calls it from the bottom of processTransaction (after the two-approval early return, beside DocumentLinks and
// CrmHooks) and from the delete path. It requires only the JobCard model, so there is no import cycle.
//
//   approved                    -> that invoice is INVOICED (stock and ledger have moved for its lines)
//   still a draft               -> an invoice is on its way
//   rejected / cancelled / gone -> the invoice never happened; cut loose, so the card can be invoiced again
//
// `invoiceStatus` is the worst (least settled) of every invoice the card still points at - a split job (one
// invoice to the insurer, one to the customer) is only "INVOICED" once both sides are approved. A card already
// handed over (DELIVERED) becomes CLOSED the moment its invoicing is complete, and a CLOSED card reopens to
// DELIVERED if one of its invoices is later reversed.

const DEAD = ["REJECTED", "CANCELLED"];

function invoiceStateOf(transaction, deleted) {
  if (deleted || DEAD.includes(transaction.status)) return "NONE";
  return transaction.status === "APPROVED" ? "INVOICED" : "DRAFT";
}

async function onJobCardInvoiceChanged(transaction, { session, deleted = false } = {}) {
  if (!transaction || transaction.type !== "sales_order") return;
  const { companyId } = getTenant();
  const id = transaction._id;
  const q = JobCard.find({ companyId, "invoices.transactionId": id });
  const cards = await (session ? q.session(session) : q);
  if (!cards.length) return;

  const state = invoiceStateOf(transaction, deleted);
  for (const card of cards) {
    if (state === "NONE") {
      card.invoices = card.invoices.filter((i) => String(i.transactionId) !== String(id));
    } else {
      const link = card.invoices.find((i) => String(i.transactionId) === String(id));
      if (link) {
        link.status = transaction.status;
        link.amount = transaction.totalAmount;
      }
    }
    card.invoiceStatus = card.invoices.length === 0 ? "NONE" : card.invoices.every((i) => i.status === "APPROVED") ? "INVOICED" : "DRAFT";
    if (card.status === "DELIVERED" && card.invoiceStatus === "INVOICED") card.status = "CLOSED";
    else if (card.status === "CLOSED" && card.invoiceStatus !== "INVOICED") card.status = "DELIVERED";
    await card.save({ session });
  }
}

module.exports = { onJobCardInvoiceChanged, invoiceStateOf };
