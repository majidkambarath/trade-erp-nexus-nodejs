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
const noReturn = () => new AppError("That credit note was not made on this trip", 404, "VAN_RETURN_NOT_FOUND");
const inSession = (session) => (q) => (session ? q.session(session) : q);

/** Each line item's barcode and unit, read from the item master as it is now (a document line stores neither). */
async function itemFacts(lines, s) {
  const ids = [...new Set((lines || []).map((l) => String(l.itemId)).filter(isId))];
  const stocks = await s(Stock.find({ _id: { $in: ids } }).select("barcodeQrCode unitOfMeasure").lean());
  const uomIds = [...new Set(stocks.map((st) => String(st.unitOfMeasure)).filter(isId))];
  const uoms = uomIds.length ? await s(UOM.find({ _id: { $in: uomIds } }).select("shortCode unitName").lean()) : [];
  const unitOf = new Map(uoms.map((u) => [String(u._id), u.shortCode || u.unitName || ""]));
  return new Map(stocks.map((st) => [String(st._id), { barcode: st.barcodeQrCode || "", unit: unitOf.get(String(st.unitOfMeasure)) || "" }]));
}
const customerFacts = (id, s) => s(Customer.findById(id).select("customerName customerId phone billingAddress city emirate trnNumber trnNO vat.trn").lean());

// The invoice's slip, as it stands NOW: what was sold (the invoice's own lines, which never change once approved), the
// money taken for it so far, the containers that went with it, and the item's code and unit read from the item master
// as they are today (a line stores neither). The first print right after the sale and any reprint later read the same.
class VanSlipService {
  /** The slip of one invoice sold on this trip. */
  static async forInvoice(tripId, invoiceId, { session } = {}) {
    const trip = await loadTrip(tripId, session);
    if (!isId(invoiceId)) throw notFound();
    const s = inSession(session);
    const invoice = await s(Transaction.findOne({ _id: invoiceId, type: "sales_order", "vanTripRef.tripId": trip._id }).lean());
    if (!invoice) throw notFound();

    const [customer, items, receipts, moves] = await Promise.all([
      customerFacts(invoice.partyId, s),
      itemFacts(invoice.items, s),
      s(Voucher.find({ voucherType: "receipt", "linkedInvoices.invoiceId": invoice._id }).select("voucherNo status paymentMode totalAmount linkedInvoices").lean()),
      s(VanContainerMove.find({ transactionId: invoice._id }).select("typeId given collected deposit").lean()),
    ]);
    const typeIds = [...new Set(moves.map((m) => String(m.typeId)))];
    const types = typeIds.length ? await s(ContainerType.find({ _id: { $in: typeIds } }).select("name").lean()) : [];
    const typeNames = new Map(types.map((t) => [String(t._id), t.name || ""]));
    return slipModel({ invoice, customer: customer || {}, trip, items, receipts, moves, typeNames });
  }

  /** The slip of a credit note made on this trip: what came back, against which invoice, and why. */
  static async forReturn(tripId, returnId, { session } = {}) {
    const trip = await loadTrip(tripId, session);
    if (!isId(returnId)) throw noReturn();
    const s = inSession(session);
    const ret = await s(Transaction.findOne({ _id: returnId, type: "sales_return", "vanTripRef.tripId": trip._id }).lean());
    if (!ret) throw noReturn();
    const [customer, items, original] = await Promise.all([
      customerFacts(ret.partyId, s),
      itemFacts(ret.items, s),
      ret.returnOf?.transactionId ? s(Transaction.findById(ret.returnOf.transactionId).select("transactionNo").lean()) : null,
    ]);
    const record = (trip.returns || []).find((r) => String(r.transactionId) === String(ret._id));
    const model = slipModel({ invoice: ret, customer: customer || {}, trip, items });
    const reason = [record?.reason, record?.note].filter(Boolean).join(". ") || ret.returnReason || "";
    return { ...model, kind: "credit", invoice: { ...model.invoice, against: original?.transactionNo || "", reason } };
  }

  /** The sales invoices and credit notes made on this trip, newest first, for printing a slip again. */
  static async invoices(tripId) {
    const trip = await loadTrip(tripId);
    const rows = await Transaction.find({ type: { $in: ["sales_order", "sales_return"] }, "vanTripRef.tripId": trip._id })
      .select("transactionNo type date partyId totalAmount outstandingAmount status createdAt")
      .sort({ createdAt: -1, _id: -1 })
      .limit(500)
      .lean();
    const names = new Map(
      (await Customer.find({ _id: { $in: [...new Set(rows.map((r) => String(r.partyId)))] } }).select("customerName").lean()).map((c) => [String(c._id), c.customerName || ""])
    );
    return rows.map((r) => ({
      id: String(r._id), type: r.type, number: r.transactionNo || "", date: r.date || null, customerName: names.get(String(r.partyId)) || "",
      total: Number(r.totalAmount) || 0, outstanding: Number(r.outstandingAmount) || 0, status: r.status || "",
    }));
  }
}

module.exports = VanSlipService;
