const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const TradeOrder = require("../../models/modules/tradeOrderModel");
const GoodsReceipt = require("../../models/modules/goodsReceiptModel");
const DeliveryNote = require("../../models/modules/deliveryNoteModel");
const Customer = require("../../models/modules/customerModel");
const Vendor = require("../../models/modules/vendorModel");
const NumberSeriesService = require("../core/numberSeriesService");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { getTenant } = require("../../utils/tenant");
const { todayInOrg } = require("../../utils/documentExpiry");
const { ORDER_ACTIONS, ORDER_EDITABLE, ORDER_OPEN, orderProgress, progressLabel } = require("../../utils/tradeOrders");
const S = require("./salesDocumentSupport");

// Sales orders and purchase orders. A commitment, never a posting (utils/tradeOrders.js): the order holds the lines, the
// prices and the tax as agreed; delivery notes / goods receipts say what came of it, and invoices what was billed.
//
//   DRAFT -> CONFIRMED -> CLOSED (finished early, reopenable)          DRAFT | CONFIRMED -> CANCELLED

const fail = (message, status, code, details) => new AppError(message, status, code, details);

const KIND = {
  sales: { series: "SORD", partyType: "Customer", Party: Customer, nameField: "customerName", codeField: "customerId", noun: "sales order", partyNoun: "customer" },
  purchase: { series: "PORD", partyType: "Vendor", Party: Vendor, nameField: "vendorName", codeField: "vendorId", noun: "purchase order", partyNoun: "vendor" },
};
const kindOf = (kind) => {
  if (!KIND[kind]) throw fail("kind must be sales or purchase", 400, "INVALID_KIND");
  return KIND[kind];
};

const PARTY_SELECT = {
  sales: S.CUSTOMER_FIELDS,
  purchase: "vendorId vendorName contactPerson email phone address trnNO vat paymentTerms status",
};

async function loadParty(kind, id, { session } = {}) {
  const k = kindOf(kind);
  if (!S.isId(id)) throw fail(`Choose a ${k.partyNoun}`, 400, "PARTY_REQUIRED");
  const q = k.Party.findById(id).select(PARTY_SELECT[kind]).lean();
  const party = await (session ? q.session(session) : q);
  if (!party) throw fail(`${k.partyNoun[0].toUpperCase()}${k.partyNoun.slice(1)} not found`, 404, "PARTY_NOT_FOUND");
  return party;
}

// What happened to each order's lines, read from the documents against it: goods receipts for a purchase, delivery notes for
// a sale (a signed-for note is "received" in the vocabulary of the progress rules).
async function receiptLinesFor(kind, orderIds, { session } = {}) {
  const { companyId } = getTenant();
  if (!orderIds.length) return new Map();
  const out = new Map(orderIds.map((id) => [String(id), []]));
  if (kind === "purchase") {
    const q = GoodsReceipt.find({ companyId, "source.kind": "purchase_order", "source.id": { $in: orderIds }, status: { $ne: "CANCELLED" } })
      .select("source.id status invoiceStatus items.sourceLineId items.qty items.receivedQty")
      .lean();
    for (const r of await (session ? q.session(session) : q)) {
      for (const l of r.items) out.get(String(r.source.id))?.push({ sourceLineId: l.sourceLineId, status: r.status, qty: l.qty, receivedQty: l.receivedQty, invoiceStatus: r.invoiceStatus });
    }
  } else {
    const q = DeliveryNote.find({ companyId, "source.kind": "trade_order", "source.id": { $in: orderIds }, status: { $ne: "CANCELLED" } })
      .select("source.id status invoiceStatus items.sourceLineId items.qty items.deliveredQty")
      .lean();
    for (const n of await (session ? q.session(session) : q)) {
      for (const l of n.items) {
        out.get(String(n.source.id))?.push({
          sourceLineId: l.sourceLineId, status: n.status === "DELIVERED" ? "RECEIVED" : "DRAFT", qty: l.qty, receivedQty: l.deliveredQty, invoiceStatus: n.invoiceStatus,
        });
      }
    }
  }
  return out;
}

function present(order, progress) {
  const status = order.status;
  const started = progress.totals.received > 0 || Object.values(progress.lines).some((l) => l.onTheWay > 0);
  const toReceive = Object.values(progress.lines).reduce((t, l) => t + l.toReceive, 0);
  const toInvoice = Object.values(progress.lines).reduce((t, l) => t + l.toInvoice, 0);
  return {
    ...order,
    progress: { ...progress, label: progressLabel(progress, order.kind) },
    actions: {
      edit: ORDER_EDITABLE.includes(status),
      delete: status === "DRAFT",
      confirm: ORDER_ACTIONS.confirm.from.includes(status),
      cancel: ORDER_ACTIONS.cancel.from.includes(status) && !started,
      close: ORDER_ACTIONS.close.from.includes(status),
      reopen: ORDER_ACTIONS.reopen.from.includes(status),
      // goods can be received / delivered against a confirmed order while something is left
      receive: ORDER_OPEN.includes(status) && toReceive > 0,
      invoice: ["CONFIRMED", "CLOSED"].includes(status) && toInvoice > 0,
    },
  };
}

class TradeOrderService {
  static kindOf = kindOf;
  static loadParty = loadParty;

  // Charges (freight, handling) and a header discount belong to the WHOLE order, so they go on its first invoice, once. `docs`
  // are the receipts / delivery notes being invoiced; nothing is carried unless they all belong to one order that has no
  // other document already on an invoice.
  static async firstInvoiceExtras(kind, docs, { session } = {}) {
    const none = { charges: [], discount: 0 };
    const sourceKind = kind === "sales" ? "trade_order" : "purchase_order";
    if (!docs.length || docs.some((d) => d.source?.kind !== sourceKind || !d.source.id)) return none;
    const ids = [...new Set(docs.map((d) => String(d.source.id)))];
    if (ids.length !== 1) return none;
    const { companyId } = getTenant();
    const q = TradeOrder.findById(ids[0]).lean();
    const order = await (session ? q.session(session) : q);
    if (!order) return none;
    const Model = kind === "sales" ? DeliveryNote : GoodsReceipt;
    const other = Model.exists({ companyId, "source.id": order._id, invoiceStatus: { $ne: "NONE" }, status: { $ne: "CANCELLED" }, _id: { $nin: docs.map((d) => d._id) } });
    if (await (session ? other.session(session) : other)) return none;
    return { charges: (order.charges || []).map((c) => ({ ...c })), discount: Number(order.discount) || 0 };
  }

  // Raise the invoice for what has been delivered / received against an order and not yet invoiced: all of it, as one draft.
  static createInvoice = withTransactionSession(async (id, input, createdBy, session) => {
    const order = await TradeOrder.findById(id).session(session);
    if (!order) throw fail("Order not found", 404, "ORDER_NOT_FOUND");
    if (!["CONFIRMED", "CLOSED"].includes(order.status)) {
      throw fail(`${order.orderNo} is ${order.status.toLowerCase()}; it can only be invoiced once it is confirmed`, 409, "ORDER_STATE");
    }
    const { companyId } = getTenant();
    if (order.kind === "sales") {
      const notes = await DeliveryNote.find({ companyId, "source.kind": "trade_order", "source.id": order._id, status: "DELIVERED", invoiceStatus: "NONE" }).select("_id").session(session);
      if (!notes.length) throw fail(`Nothing has been delivered on ${order.orderNo} that is waiting for an invoice. Confirm a delivery note first.`, 409, "NOTHING_TO_INVOICE");
      const DeliveryNoteService = require("./deliveryNoteService");
      const out = await DeliveryNoteService.createInvoice({ deliveryNoteIds: notes.map((n) => String(n._id)), date: input?.date }, createdBy, session);
      return { kind: "sales", invoice: out.salesOrder, documents: out.deliveryNotes };
    }
    const receipts = await GoodsReceipt.find({ companyId, "source.kind": "purchase_order", "source.id": order._id, status: "RECEIVED", invoiceStatus: "NONE" }).select("_id").session(session);
    if (!receipts.length) throw fail(`Nothing has been received on ${order.orderNo} that is waiting for an invoice. Confirm goods received first.`, 409, "NOTHING_TO_INVOICE");
    const GoodsReceiptService = require("./goodsReceiptService");
    const out = await GoodsReceiptService.createInvoice({ receiptIds: receipts.map((r) => String(r._id)), date: input?.date, vendorInvoiceNo: input?.vendorInvoiceNo }, createdBy, session);
    return { kind: "purchase", invoice: out.purchaseInvoice, documents: out.goodsReceipts };
  });

  // ---- reading -----------------------------------------------------------------------------
  static async list(filters = {}) {
    const k = kindOf(filters.kind);
    const { companyId } = getTenant();
    const q = { companyId, kind: filters.kind };
    if (filters.status) q.status = String(filters.status);
    if (filters.partyId) {
      if (!S.isId(filters.partyId)) throw fail(`Invalid ${k.partyNoun}`, 400);
      q.partyId = new mongoose.Types.ObjectId(filters.partyId);
    }
    const dateFrom = S.dayFilter(filters.dateFrom, "dateFrom");
    const dateTo = S.dayFilter(filters.dateTo, "dateTo");
    if (dateFrom || dateTo) q.date = { ...(dateFrom && { $gte: dateFrom }), ...(dateTo && { $lte: new Date(dateTo.getTime() + 86399999) }) };
    if (filters.search) {
      const r = new RegExp(S.escapeRegex(filters.search), "i");
      const parties = await k.Party.find({ $or: [{ [k.nameField]: r }, { [k.codeField]: r }] }).select("_id").limit(200).lean();
      q.$or = [{ orderNo: r }, { reference: r }, { "items.description": r }, { partyId: { $in: parties.map((p) => p._id) } }];
    }
    const { page, limit, skip } = S.pageOf(filters);
    const [rows, total] = await Promise.all([
      TradeOrder.find(q).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      TradeOrder.countDocuments(q),
    ]);
    const [parties, receipts] = await Promise.all([
      k.Party.find({ _id: { $in: rows.map((r) => r.partyId) } }).select(`${k.codeField} ${k.nameField}`).lean(),
      receiptLinesFor(filters.kind, rows.map((r) => r._id)),
    ]);
    const byId = new Map(parties.map((p) => [String(p._id), p]));
    return {
      rows: rows.map((r) => ({
        ...present(r, orderProgress(r.items, receipts.get(String(r._id)) || [])),
        party: byId.get(String(r.partyId)) ? { ...byId.get(String(r.partyId)), name: byId.get(String(r.partyId))[k.nameField], code: byId.get(String(r.partyId))[k.codeField] } : null,
      })),
      pagination: { current: page, pages: Math.ceil(total / limit), total, limit },
    };
  }

  static async summary(kind) {
    const k = kindOf(kind);
    const { companyId } = getTenant();
    const rows = await TradeOrder.aggregate([{ $match: { companyId, kind } }, { $group: { _id: "$status", count: { $sum: 1 }, value: { $sum: "$totalAmount" } } }]);
    const byStatus = {};
    for (const r of rows) byStatus[r._id] = { count: r.count, value: Math.round(r.value * 100) / 100 };
    return { kind, noun: k.noun, byStatus };
  }

  static async getById(id) {
    if (!S.isId(id)) throw fail("Invalid order id", 400);
    const order = await TradeOrder.findById(id).lean();
    if (!order) throw fail("Order not found", 404, "ORDER_NOT_FOUND");
    const [party, items, receipts] = await Promise.all([
      loadParty(order.kind, order.partyId),
      S.attachStockDetails(order.items),
      receiptLinesFor(order.kind, [order._id]),
    ]);
    return { ...present({ ...order, items }, orderProgress(order.items, receipts.get(String(order._id)) || [])), party };
  }

  // ---- writing -----------------------------------------------------------------------------
  static create = withTransactionSession(async (data, createdBy, session) => {
    const kind = data.kind;
    const k = kindOf(kind);
    const { companyId, branchId } = getTenant();
    const party = await loadParty(kind, data.partyId, { session });
    const date = S.dayToDate(data.date) || new Date(todayInOrg());
    const expectedDate = data.expectedDate ? S.dayToDate(data.expectedDate) : null;
    if (data.expectedDate && !expectedDate) throw fail("Enter a valid date", 400, "INVALID_DATE");
    const priced = await S.priceDocument({ items: data.items, charges: data.charges, discount: data.discount, date }, { session });
    const orderNo = await NumberSeriesService.allocate(k.series, date, { session });
    const [doc] = await TradeOrder.create(
      [{
        companyId, branchId, kind, orderNo, partyId: party._id, partyType: k.partyType, date, expectedDate,
        reference: data.reference || "", status: "DRAFT",
        items: priced.lines, charges: priced.charges, discount: Number(data.discount) || 0, pricing: priced.pricing, totalAmount: priced.totalAmount,
        notes: data.notes || "", terms: data.terms || "", createdBy,
      }],
      { session }
    );
    return doc;
  });

  static update = withTransactionSession(async (id, data, createdBy, session) => {
    const order = await TradeOrder.findById(id).session(session);
    if (!order) throw fail("Order not found", 404, "ORDER_NOT_FOUND");
    if (!ORDER_EDITABLE.includes(order.status)) {
      throw fail(`${order.orderNo} is ${order.status.toLowerCase()} and can no longer be edited`, 409, "ORDER_NOT_EDITABLE");
    }
    if (data.partyId && String(data.partyId) !== String(order.partyId)) {
      await loadParty(order.kind, data.partyId, { session });
      order.partyId = data.partyId;
    }
    const date = data.date ? S.dayToDate(data.date) : order.date;
    if (!date) throw fail("Enter a valid date", 400, "INVALID_DATE");
    if (data.expectedDate !== undefined) {
      const day = data.expectedDate ? S.dayToDate(data.expectedDate) : null;
      if (data.expectedDate && !day) throw fail("Enter a valid date", 400, "INVALID_DATE");
      order.expectedDate = day;
    }
    if (data.items || data.charges !== undefined || data.discount !== undefined || data.date) {
      const items = data.items
        ? data.items
        : order.items.map((l) => ({ ...S.toPricingInput(l.toObject()) }));
      const priced = await S.priceDocument(
        { items, charges: data.charges ?? order.charges.map((c) => c.toObject()), discount: data.discount ?? order.discount, date },
        { session }
      );
      order.items = priced.lines;
      order.charges = priced.charges;
      order.discount = Number(data.discount ?? order.discount) || 0;
      order.pricing = priced.pricing;
      order.totalAmount = priced.totalAmount;
    }
    order.date = date;
    for (const key of ["reference", "notes", "terms"]) if (data[key] !== undefined) order[key] = data[key] || "";
    await order.save({ session });
    return order;
  });

  static remove = withTransactionSession(async (id, createdBy, session) => {
    const order = await TradeOrder.findById(id).session(session);
    if (!order) throw fail("Order not found", 404, "ORDER_NOT_FOUND");
    if (order.status !== "DRAFT") throw fail(`${order.orderNo} is ${order.status.toLowerCase()} and cannot be deleted. Cancel it instead.`, 409, "ORDER_NOT_DELETABLE");
    await TradeOrder.deleteOne({ _id: order._id }, { session });
    return { orderNo: order.orderNo, kind: order.kind, totalAmount: order.totalAmount };
  });

  static #act = async (id, action, session, mutate) => {
    const order = await TradeOrder.findById(id).session(session);
    if (!order) throw fail("Order not found", 404, "ORDER_NOT_FOUND");
    const rule = ORDER_ACTIONS[action];
    if (!rule.from.includes(order.status)) {
      throw fail(`${order.orderNo} is ${order.status.toLowerCase()}; it cannot be ${action === "cancel" ? "cancelled" : action === "close" ? "closed" : action === "reopen" ? "reopened" : "confirmed"} from there`, 409, "ORDER_STATE");
    }
    await mutate(order);
    order.status = rule.to;
    await order.save({ session });
    return order;
  };

  static confirm = withTransactionSession(async (id, input, createdBy, session) =>
    TradeOrderService.#act(id, "confirm", session, async (order) => {
      if (!order.items.length) throw fail("An order with no items cannot be confirmed", 400, "ITEMS_REQUIRED");
      order.confirmedAt = new Date();
      order.confirmedBy = String(createdBy || "");
    })
  );

  static cancel = withTransactionSession(async (id, input, createdBy, session) =>
    TradeOrderService.#act(id, "cancel", session, async (order) => {
      // goods that were received (or are on the way) against it keep it standing: cancel those first
      const lines = (await receiptLinesFor(order.kind, [order._id], { session })).get(String(order._id)) || [];
      if (lines.length) {
        throw fail(`${order.orderNo} has ${order.kind === "sales" ? "delivery notes" : "goods received"} against it. Cancel those first, or close the order instead.`, 409, "ORDER_HAS_DOCUMENTS");
      }
      order.cancelledAt = new Date();
      order.cancelReason = String(input?.reason || "").trim();
    })
  );

  static close = withTransactionSession(async (id, input, createdBy, session) =>
    TradeOrderService.#act(id, "close", session, async (order) => {
      order.closedAt = new Date();
      order.closeReason = String(input?.reason || "").trim();
    })
  );

  static reopen = withTransactionSession(async (id, input, createdBy, session) =>
    TradeOrderService.#act(id, "reopen", session, async (order) => {
      order.closedAt = null;
      order.closeReason = "";
    })
  );
}

TradeOrderService.receiptLinesFor = receiptLinesFor;
TradeOrderService.present = present;

module.exports = TradeOrderService;
