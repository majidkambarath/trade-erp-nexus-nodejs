const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const Customer = require("../../models/modules/customerModel");
const Quotation = require("../../models/modules/quotationModel");
const DeliveryNote = require("../../models/modules/deliveryNoteModel");
const Transaction = require("../../models/modules/transactionModel");
const OrderCloseService = require("./orderCloseService");
const { buildFlow } = require("../../utils/documentFlow");
const { getTenant } = require("../../utils/tenant");

// A customer's quotations, sales orders and delivery notes as the deals they belong to (utils/documentFlow.js).
// Read only: it writes nothing and posts nothing. Each kind is capped, newest first, and says so when it was
// cut, because a customer's whole history is not what the profile needs and would only slow it down.
const LIMIT = 300;
const newest = { date: -1, _id: -1 };

class DocumentFlowService {
  static async forCustomer(customerId, now = new Date()) {
    if (!mongoose.isValidObjectId(customerId)) throw new AppError("Invalid customer", 400, "CUSTOMER_REQUIRED");
    const customer = await Customer.findById(customerId).select("customerId customerName").lean();
    if (!customer) throw new AppError("Customer not found", 404, "CUSTOMER_NOT_FOUND");
    const { companyId } = getTenant();
    const partyId = customer._id;

    // one extra row of each tells whether the list was cut
    const [quotations, notes, orders] = await Promise.all([
      Quotation.find({ companyId, partyId })
        .select("quotationNo status date validUntil totalAmount reference revision convertedTo revisionOf supersededBy")
        .sort(newest).limit(LIMIT + 1).lean(),
      DeliveryNote.find({ companyId, partyId })
        .select("deliveryNoteNo status date deliveredAt totalAmount invoiceStatus source invoice reference receivedBy items.sourceLineId items.qty items.deliveredQty")
        .sort(newest).limit(LIMIT + 1).lean(),
      Transaction.find({ partyId, type: "sales_order", isOpening: { $ne: true } })
        .select("transactionNo status date totalAmount quoteRef linkedRef lpono paidAmount outstandingAmount items._id items.qty items.description items.itemType closedShort.at closedShort.reason closedShort.trimmed closedShort.valueShort closedShort.lines lastSend")
        .sort(newest).limit(LIMIT + 1).lean(),
    ]);
    const truncated = [quotations, notes, orders].some((rows) => rows.length > LIMIT);
    // an approved order closed short was invoiced in full: its sales returns say whether that has been put right
    const closedIds = orders.filter((o) => o.closedShort?.at && o.status === "APPROVED").map((o) => o._id);
    const returns = await OrderCloseService.returnsFor(closedIds);
    const flow = buildFlow({ quotations: quotations.slice(0, LIMIT), orders: orders.slice(0, LIMIT), notes: notes.slice(0, LIMIT), returns }, now);
    return { customer, ...flow, truncated };
  }
}

module.exports = DocumentFlowService;
