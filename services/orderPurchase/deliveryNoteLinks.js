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

module.exports = { onSalesOrderChanged, releaseQuotationsFor, invoiceStateOf };
