const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const Transaction = require("../../models/modules/transactionModel");
const Customer = require("../../models/modules/customerModel");
const Stock = require("../../models/modules/stockModel");
const UOM = require("../../models/modules/uomModel");
const { Voucher } = require("../../models/modules/financial/financialModels");
const VanContainerMove = require("../../models/modules/vansales/vanContainerMoveModel");
const ContainerType = require("../../models/modules/vansales/containerTypeModel");
const { slipModel } = require("../../utils/vanSlip");
const { loadTrip } = require("./vanTripStock");

const isId = (v) => mongoose.isValidObjectId(v);
const notFound = () => new AppError("That invoice was not sold on this trip", 404, "VAN_INVOICE_NOT_FOUND");

// The invoice's slip, as it stands NOW: what was sold (the invoice's own lines, which never change once approved), the
// money taken for it so far, the containers that went with it, and the item's code and unit read from the item master
// as they are today (a line stores neither). The first print right after the sale and any reprint later read the same.
class VanSlipService {
  /** The slip of one invoice sold on this trip. */
  static async forInvoice(tripId, invoiceId, { session } = {}) {
    const trip = await loadTrip(tripId, session);
    if (!isId(invoiceId)) throw notFound();
    const s = (q) => (session ? q.session(session) : q);
    const invoice = await s(Transaction.findOne({ _id: invoiceId, type: "sales_order", "vanTripRef.tripId": trip._id }).lean());
    if (!invoice) throw notFound();

    const ids = [...new Set((invoice.items || []).map((l) => String(l.itemId)).filter(isId))];
    const [customer, stocks, receipts, moves] = await Promise.all([
      s(Customer.findById(invoice.partyId).select("customerName customerId phone billingAddress city emirate trnNumber trnNO vat.trn").lean()),
      s(Stock.find({ _id: { $in: ids } }).select("barcodeQrCode unitOfMeasure").lean()),
      s(Voucher.find({ voucherType: "receipt", "linkedInvoices.invoiceId": invoice._id }).select("voucherNo status paymentMode totalAmount linkedInvoices").lean()),
      s(VanContainerMove.find({ transactionId: invoice._id }).select("typeId given collected deposit").lean()),
    ]);
    const uomIds = [...new Set(stocks.map((st) => String(st.unitOfMeasure)).filter(isId))];
    const typeIds = [...new Set(moves.map((m) => String(m.typeId)))];
    const [uoms, types] = await Promise.all([
      uomIds.length ? s(UOM.find({ _id: { $in: uomIds } }).select("shortCode unitName").lean()) : [],
      typeIds.length ? s(ContainerType.find({ _id: { $in: typeIds } }).select("name").lean()) : [],
    ]);
    const unitOf = new Map(uoms.map((u) => [String(u._id), u.shortCode || u.unitName || ""]));
    const items = new Map(stocks.map((st) => [String(st._id), { barcode: st.barcodeQrCode || "", unit: unitOf.get(String(st.unitOfMeasure)) || "" }]));
    const typeNames = new Map(types.map((t) => [String(t._id), t.name || ""]));
    return slipModel({ invoice, customer: customer || {}, trip, items, receipts, moves, typeNames });
  }

  /** The sales invoices made on this trip, newest first, for printing a slip again. */
  static async invoices(tripId) {
    const trip = await loadTrip(tripId);
    const rows = await Transaction.find({ type: "sales_order", "vanTripRef.tripId": trip._id })
      .select("transactionNo date partyId totalAmount outstandingAmount status createdAt")
      .sort({ createdAt: -1, _id: -1 })
      .limit(500)
      .lean();
    const names = new Map(
      (await Customer.find({ _id: { $in: [...new Set(rows.map((r) => String(r.partyId)))] } }).select("customerName").lean()).map((c) => [String(c._id), c.customerName || ""])
    );
    return rows.map((r) => ({
      id: String(r._id), number: r.transactionNo || "", date: r.date || null, customerName: names.get(String(r.partyId)) || "",
      total: Number(r.totalAmount) || 0, outstanding: Number(r.outstandingAmount) || 0, status: r.status || "",
    }));
  }
}

module.exports = VanSlipService;
