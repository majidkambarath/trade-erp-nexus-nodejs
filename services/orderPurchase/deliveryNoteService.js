const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const DeliveryNote = require("../../models/modules/deliveryNoteModel");
const Quotation = require("../../models/modules/quotationModel");
const Transaction = require("../../models/modules/transactionModel");
const Customer = require("../../models/modules/customerModel");
const Stock = require("../../models/modules/stockModel");
const StockBatch = require("../../models/modules/stockBatchModel");
const BatchService = require("../stock/batchService");
const NumberSeriesService = require("../core/numberSeriesService");
const TransactionService = require("./transactionService");
const Links = require("./deliveryNoteLinks");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { getTenant } = require("../../utils/tenant");
const { todayInDubai, dubaiDay, diffDays, toExpiryDay } = require("../../utils/documentExpiry");
const {
  DELIVERY_ACTIONS, DELIVERY_EDITABLE, INVOICE_STATE, QUOTATION_CONVERTIBLE,
  fulfilment, settleDelivery, invoiceClock, quotationExpiry,
} = require("../../utils/salesDocuments");
const S = require("./salesDocumentSupport");

// A delivery note is the paper that goes with the goods. It posts nothing and moves no stock: stock
// leaves, cost of sales is booked and the receivable raised when the SALES ORDER that invoices the
// goods is approved. A note is tied to that order in one of two ways:
//
//   against a sales order   the lines are the order's lines (part by part), and the order is the invoice.
//   on its own              delivered first and invoiced after - one note, or several of the same
//                           customer's on one invoice (createInvoice). Until that invoice is approved
//                           the goods are still on hand in the books; availability() counts them as
//                           committed so they are not promised twice.
//
// Lifecycle:  DRAFT -> DISPATCHED -> DELIVERED (signed for)      DRAFT | DISPATCHED -> CANCELLED

const fail = (message, status, code, details) => new AppError(message, status, code, details);

function present(dn, now = new Date()) {
  const owed = dn.status === "DELIVERED" && dn.invoiceStatus !== INVOICE_STATE.INVOICED;
  return {
    ...dn,
    // the 14-day tax invoice clock runs from delivery until the invoice is approved
    clock: owed ? invoiceClock(dn.deliveredAt, now) : null,
    actions: {
      edit: DELIVERY_EDITABLE.includes(dn.status),
      delete: dn.status === "DRAFT",
      dispatch: DELIVERY_ACTIONS.dispatch.from.includes(dn.status),
      deliver: DELIVERY_ACTIONS.deliver.from.includes(dn.status),
      cancel: DELIVERY_ACTIONS.cancel.from.includes(dn.status),
      invoice: dn.status === "DELIVERED" && dn.invoiceStatus === INVOICE_STATE.NONE && dn.source?.kind !== "sales_order",
    },
  };
}

const addressOf = (c) => c.shippingAddress || c.billingAddress || "";

// The sales order a note is raised against: it must be a live invoice-to-be (a draft) or an invoice
// already approved, and belong to the same customer.
async function loadOrder(id, { session } = {}) {
  if (!S.isId(id)) throw fail("Invalid sales order", 400, "ORDER_REQUIRED");
  const q = Transaction.findById(id).lean();
  const order = await (session ? q.session(session) : q);
  if (!order || order.type !== "sales_order") throw fail("Sales order not found", 404, "ORDER_NOT_FOUND");
  if (order.isOpening) throw fail(`${order.transactionNo} is an opening balance invoice and has no goods to deliver`, 409, "ORDER_NOT_DELIVERABLE");
  if (!["DRAFT", "APPROVED"].includes(order.status)) {
    throw fail(`${order.transactionNo} is ${order.status.toLowerCase()}; nothing can be delivered against it`, 409, "ORDER_NOT_DELIVERABLE");
  }
  if (order.closedShort?.at) {
    throw fail(`${order.transactionNo} was closed short; nothing more can be delivered against it`, 409, "ORDER_CLOSED_SHORT");
  }
  return order;
}

// Every line of every live note against an order, for the fulfilment sums.
async function noteLinesFor(orderId, { session, excludeId } = {}) {
  const { companyId } = getTenant();
  const q = DeliveryNote.find({ companyId, "source.id": orderId, status: { $ne: "CANCELLED" }, ...(excludeId && { _id: { $ne: excludeId } }) })
    .select("status items.sourceLineId items.qty items.deliveredQty")
    .lean();
  const notes = await (session ? q.session(session) : q);
  return notes.flatMap((n) => n.items.map((l) => ({ sourceLineId: l.sourceLineId, status: n.status, qty: l.qty, deliveredQty: l.deliveredQty })));
}

const invoiceStateOfOrder = (order) => (order.status === "APPROVED" ? INVOICE_STATE.INVOICED : INVOICE_STATE.DRAFT);

class DeliveryNoteService {
  // ---- reading -----------------------------------------------------------------------------

  static async list(filters = {}) {
    const { companyId } = getTenant();
    const q = { companyId };

    // "UNINVOICED" is delivered and still waiting for an approved invoice - the VAT clock is running.
    if (filters.status === "UNINVOICED") Object.assign(q, { status: "DELIVERED", invoiceStatus: { $ne: INVOICE_STATE.INVOICED } });
    else if (filters.status) q.status = String(filters.status);
    if (filters.invoiceStatus) q.invoiceStatus = String(filters.invoiceStatus);
    if (filters.partyId) {
      if (!S.isId(filters.partyId)) throw fail("Invalid customer", 400);
      q.partyId = new mongoose.Types.ObjectId(filters.partyId);
    }
    if (filters.sourceId) {
      if (!S.isId(filters.sourceId)) throw fail("Invalid sales order", 400);
      q["source.id"] = new mongoose.Types.ObjectId(filters.sourceId);
    }
    if (filters.invoiceId) {
      if (!S.isId(filters.invoiceId)) throw fail("Invalid sales order", 400);
      q["invoice.id"] = new mongoose.Types.ObjectId(filters.invoiceId);
    }
    const dateFrom = S.dayToDate(filters.dateFrom);
    const dateTo = S.dayToDate(filters.dateTo);
    if (dateFrom || dateTo) q.date = { ...(dateFrom && { $gte: dateFrom }), ...(dateTo && { $lte: new Date(dateTo.getTime() + 86399999) }) };

    if (filters.search) {
      const r = new RegExp(S.escapeRegex(filters.search), "i");
      const parties = await Customer.find({ $or: [{ customerName: r }, { customerId: r }] }).select("_id").limit(200).lean();
      q.$or = [
        { deliveryNoteNo: r }, { reference: r }, { vehicleNo: r }, { driverName: r }, { receivedBy: r }, { "items.description": r },
        { partyId: { $in: parties.map((p) => p._id) } },
      ];
    }

    const { page, limit, skip } = S.pageOf(filters);
    const [rows, total] = await Promise.all([
      DeliveryNote.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      DeliveryNote.countDocuments(q),
    ]);
    const parties = await Customer.find({ _id: { $in: rows.map((r) => r.partyId) } }).select("customerId customerName").lean();
    const byId = new Map(parties.map((p) => [String(p._id), p]));
    return {
      rows: rows.map((r) => ({ ...present(r), party: byId.get(String(r.partyId)) || null })),
      pagination: { current: page, pages: Math.ceil(total / limit), total, limit },
    };
  }

  static async summary() {
    const { companyId } = getTenant();
    const rows = await DeliveryNote.aggregate([
      { $match: { companyId } },
      { $group: { _id: { status: "$status", invoiced: { $eq: ["$invoiceStatus", INVOICE_STATE.INVOICED] } }, count: { $sum: 1 }, value: { $sum: "$totalAmount" } } },
    ]);
    const byStatus = {};
    let uninvoiced = { count: 0, value: 0 };
    for (const r of rows) {
      byStatus[r._id.status] = (byStatus[r._id.status] || 0) + r.count;
      if (r._id.status === "DELIVERED" && !r._id.invoiced) uninvoiced = { count: uninvoiced.count + r.count, value: uninvoiced.value + r.value };
    }
    const report = await DeliveryNoteService.uninvoiced();
    return { byStatus, uninvoiced: { count: uninvoiced.count, value: Math.round(uninvoiced.value * 100) / 100 }, clock: report.summary };
  }

  static async getById(id) {
    if (!S.isId(id)) throw fail("Invalid delivery note id", 400);
    const dn = await DeliveryNote.findById(id).lean();
    if (!dn) throw fail("Delivery note not found", 404, "DELIVERY_NOTE_NOT_FOUND");
    const [party, items] = await Promise.all([Customer.findById(dn.partyId).select(S.CUSTOMER_FIELDS).lean(), S.attachStockDetails(dn.items)]);

    // How much of the order this note serves has gone out, across every note against it.
    let order = null;
    let progress = null;
    if (dn.source?.kind === "sales_order" && dn.source.id) {
      order = await Transaction.findById(dn.source.id).select("transactionNo status date items._id items.qty items.description items.itemCode").lean();
      if (order) progress = fulfilment(order.items, await noteLinesFor(order._id));
    }
    return {
      ...present({ ...dn, items }),
      party,
      sourceOrder: order
        ? { id: order._id, no: order.transactionNo, status: order.status, lines: order.items.map((l) => ({ lineId: l._id, description: l.description, itemCode: l.itemCode })) }
        : null,
      fulfilment: progress,
    };
  }

  // What can still be delivered on each line of a sales order: the starting point for a note against it.
  static async prefillFromOrder(orderId) {
    const order = await loadOrder(orderId);
    const [party, progress] = await Promise.all([S.loadCustomer(order.partyId), noteLinesFor(order._id)]);
    const f = fulfilment(order.items, progress);
    const items = await S.attachStockDetails(order.items);
    return {
      order: { id: order._id, no: order.transactionNo, status: order.status, date: order.date, reference: order.lpono || "" },
      party,
      deliveryAddress: addressOf(party),
      lines: items.map((l) => ({
        sourceLineId: l._id,
        itemId: l.itemId,
        itemCode: l.itemCode,
        description: l.description,
        stockDetails: l.stockDetails,
        price: l.price ?? (l.qty ? (Number(l.rate) || 0) / l.qty : 0),
        ...f[String(l._id)],
      })),
    };
  }

  // Delivered and not yet invoiced, oldest first: where the 14-day tax invoice clock is running.
  static async uninvoiced({ now = new Date(), partyId } = {}) {
    const { companyId } = getTenant();
    const q = { companyId, status: "DELIVERED", invoiceStatus: { $ne: INVOICE_STATE.INVOICED } };
    if (partyId) q.partyId = new mongoose.Types.ObjectId(partyId);
    const notes = await DeliveryNote.find(q)
      .select("deliveryNoteNo partyId deliveredAt totalAmount invoiceStatus source invoice")
      .sort({ deliveredAt: 1 })
      .limit(1000)
      .lean();
    const parties = await Customer.find({ _id: { $in: notes.map((n) => n.partyId) } }).select("customerId customerName").lean();
    const byId = new Map(parties.map((p) => [String(p._id), p]));
    const rows = notes.map((n) => ({
      _id: n._id,
      deliveryNoteNo: n.deliveryNoteNo,
      party: byId.get(String(n.partyId)) || null,
      partyId: n.partyId,
      deliveredAt: n.deliveredAt,
      totalAmount: n.totalAmount,
      invoiceStatus: n.invoiceStatus,
      source: n.source,
      invoice: n.invoice,
      clock: invoiceClock(n.deliveredAt, now),
    }));
    const count = (c) => rows.filter((r) => r.clock?.clock === c).length;
    return {
      rows,
      summary: {
        count: rows.length,
        value: Math.round(rows.reduce((t, r) => t + (r.totalAmount || 0), 0) * 100) / 100,
        within: count("within"), dueSoon: count("dueSoon"), pastStandard: count("pastStandard"), overdue: count("overdue"),
      },
    };
  }

  // On hand, promised on notes not yet invoiced, and what is left to promise. `excludeId` leaves out the
  // note being edited, so it is not counted against itself.
  static async availability(itemIds, { excludeId } = {}) {
    const ids = (Array.isArray(itemIds) ? itemIds : String(itemIds || "").split(",")).filter(S.isId);
    if (!ids.length) return [];
    const { companyId } = getTenant();
    const oid = ids.map((i) => new mongoose.Types.ObjectId(i));
    const [stocks, committed] = await Promise.all([
      Stock.find({ _id: { $in: oid } }).select("currentStock").lean(),
      DeliveryNote.aggregate([
        { $match: { companyId, status: { $ne: "CANCELLED" }, invoiceStatus: { $ne: INVOICE_STATE.INVOICED }, ...(excludeId && S.isId(excludeId) && { _id: { $ne: new mongoose.Types.ObjectId(excludeId) } }) } },
        { $unwind: "$items" },
        { $match: { "items.itemId": { $in: oid } } },
        { $group: { _id: "$items.itemId", qty: { $sum: { $cond: [{ $eq: ["$status", "DELIVERED"] }, { $ifNull: ["$items.deliveredQty", "$items.qty"] }, "$items.qty"] } } } },
      ]),
    ]);
    const held = new Map(committed.map((c) => [String(c._id), c.qty]));
    return stocks.map((s) => {
      const onHand = s.currentStock ?? 0;
      const promised = Math.round((held.get(String(s._id)) || 0) * 1000) / 1000;
      return { itemId: String(s._id), onHand, committed: promised, available: Math.round((onHand - promised) * 1000) / 1000 };
    });
  }

  // What to pick, and from which batches. For a note against an APPROVED order the batches are the ones
  // that order already took (it was allocated first-expiry-first-out when approved); otherwise it is a
  // first-expiry-first-out suggestion from stock on hand, honouring the customer's minimum shelf life.
  // A suggestion only: the batches an invoice takes are decided when it is approved, and those are the
  // ones recorded against it for traceability.
  static async pickList(id) {
    const dn = await DeliveryNote.findById(id).lean();
    if (!dn) throw fail("Delivery note not found", 404, "DELIVERY_NOTE_NOT_FOUND");
    const customer = await Customer.findById(dn.partyId).select("customerName minShelfLifeDays").lean();
    const items = await S.attachStockDetails(dn.items);
    const { companyId } = getTenant();

    let order = null;
    let earlier = [];
    if (dn.source?.kind === "sales_order" && dn.source.id) {
      order = await Transaction.findById(dn.source.id).select("status items._id items.allocations").lean();
      if (order?.status === "APPROVED") {
        earlier = await DeliveryNote.find({ companyId, "source.id": dn.source.id, status: { $ne: "CANCELLED" }, createdAt: { $lt: dn.createdAt } })
          .select("items.sourceLineId items.qty items.deliveredQty status").lean();
      }
    }

    const lines = [];
    for (const l of items) {
      let batches = [];
      let unallocated = 0;
      let basis = "suggested";
      const orderLine = order?.status === "APPROVED" ? order.items.find((x) => String(x._id) === String(l.sourceLineId)) : null;
      if (orderLine?.allocations?.length) {
        basis = "allocated";
        // skip what earlier notes against the same line already took, then take this note's quantity
        let skip = earlier.flatMap((n) => n.items.filter((x) => String(x.sourceLineId) === String(l.sourceLineId)).map((x) => (n.status === "DELIVERED" ? x.deliveredQty ?? x.qty : x.qty))).reduce((t, v) => t + v, 0);
        let need = l.qty;
        for (const a of orderLine.allocations) {
          let avail = a.qty;
          const used = Math.min(avail, skip);
          skip -= used;
          avail -= used;
          const take = Math.min(avail, need);
          if (take > 0) batches.push({ batchNumber: a.batchNumber, expiryDate: a.expiryDate, qty: take });
          need -= take;
        }
        unallocated = Math.max(0, Math.round(need * 1000) / 1000);
      } else {
        const stock = await StockBatch.find({ companyId, stockId: l.itemId, status: "active", qtyOnHand: { $gt: 0 } }).lean();
        const ordered = BatchService.eligibleInOrder(stock, { orderDate: dn.date, minShelfLifeDays: customer?.minShelfLifeDays || 0 });
        const plan = BatchService.plan(ordered, l.qty);
        batches = plan.takes.map((t) => ({ batchNumber: t.batch.batchNumber, expiryDate: t.batch.expiryDate, qty: t.qty }));
        unallocated = plan.unallocated;
      }
      lines.push({
        lineId: l._id, itemCode: l.itemCode, description: l.description, unit: l.stockDetails?.unit || "", barcode: l.stockDetails?.barcode || "",
        qty: l.qty, onHand: l.stockDetails?.currentStock ?? null, batches, unallocated, basis,
      });
    }
    return { deliveryNoteNo: dn.deliveryNoteNo, customer: customer?.customerName || "", date: dn.date, minShelfLifeDays: customer?.minShelfLifeDays || 0, lines };
  }

  // ---- writing -----------------------------------------------------------------------------

  // The lines of a note from what the client sent. Against an order, the client names the order line and
  // the quantity; the item, price, discount and tax come from the order, so a note can never disagree
  // with the invoice it belongs to. On its own, the lines carry their own price like a quotation's.
  static async #buildLines(data, order, { session, excludeId } = {}) {
    if (!order) return S.prepareLines(data.items, { session });

    if (!Array.isArray(data.items) || !data.items.length) throw fail("Add at least one item", 400, "ITEMS_REQUIRED");
    const f = fulfilment(order.items, await noteLinesFor(order._id, { session, excludeId }));
    const taken = new Map();
    const inputs = data.items.map((given, index) => {
      const n = index + 1;
      const line = order.items.find((x) => String(x._id) === String(given.sourceLineId));
      if (!line) throw fail(`Line ${n}: that item is not on ${order.transactionNo}`, 400, "LINE_NOT_ON_ORDER");
      const qty = Number(given.qty);
      if (!(qty > 0)) throw fail(`Line ${n}: quantity must be above zero`, 400, "INVALID_QUANTITY");
      const key = String(line._id);
      const total = (taken.get(key) || 0) + qty;
      taken.set(key, total);
      const left = f[key].remaining;
      if (Math.round((total - left) * 1000) / 1000 > 0) {
        throw fail(`Line ${n}: only ${left} of ${line.description} is left to deliver on ${order.transactionNo}`, 409, "OVER_DELIVERY", { line: n, remaining: left });
      }
      return { ...S.toPricingInput({ ...line, price: line.price ?? (line.qty ? (Number(line.rate) || 0) / line.qty : 0) }, qty), sourceLineId: line._id };
    });
    return S.prepareLines(inputs, { session });
  }

  static create = withTransactionSession(async (data, createdBy, session) => {
    const { companyId, branchId } = getTenant();
    const order = data.sourceTransactionId ? await loadOrder(data.sourceTransactionId, { session }) : null;
    const partyId = order ? order.partyId : data.partyId;
    const customer = await S.loadCustomer(partyId, { session });

    const date = S.dayToDate(data.date) || new Date(todayInDubai());
    const lines = await DeliveryNoteService.#buildLines(data, order, { session });
    const priced = await S.priceDocument(
      { items: lines, charges: order ? [] : data.charges, discount: order ? 0 : data.discount, date },
      { session }
    );
    const deliveryNoteNo = await NumberSeriesService.allocate("DLN", date, { session });
    const [doc] = await DeliveryNote.create(
      [{
        companyId, branchId, deliveryNoteNo, partyId, date, status: "DRAFT",
        source: order ? { kind: "sales_order", id: order._id, no: order.transactionNo } : { kind: "manual" },
        invoice: order ? { kind: "sales_order", id: order._id, no: order.transactionNo } : undefined,
        invoiceStatus: order ? invoiceStateOfOrder(order) : INVOICE_STATE.NONE,
        // a form sends blanks as "", so a blank takes the default, which a person can then overwrite
        reference: data.reference || order?.lpono || "",
        deliveryAddress: data.deliveryAddress || addressOf(customer),
        contactPerson: data.contactPerson || customer.contactPerson || "",
        contactPhone: data.contactPhone || customer.phone || "",
        vehicleNo: data.vehicleNo || "", driverName: data.driverName || "", driverPhone: data.driverPhone || "",
        items: priced.lines, charges: priced.charges, discount: order ? 0 : Number(data.discount) || 0,
        pricing: priced.pricing, totalAmount: priced.totalAmount,
        notes: data.notes || "", createdBy,
      }],
      { session }
    );
    return doc;
  });

  // One-shot: the customer accepted an offer and wants the goods now, to be invoiced afterwards. The
  // offer is spent (CONVERTED) and its lines, discount and charges carry across. Several deliveries
  // against one offer go through a sales order instead, which tracks what is left.
  static createFromQuotation = withTransactionSession(async (quotationId, input, createdBy, session) => {
    const quote = await Quotation.findById(quotationId).session(session);
    if (!quote) throw fail("Quotation not found", 404, "QUOTATION_NOT_FOUND");
    if (!QUOTATION_CONVERTIBLE.includes(quote.status)) {
      const why = quote.status === "CONVERTED" ? `already became ${quote.convertedTo?.no || "another document"}` : `is ${quote.status.toLowerCase()}`;
      throw fail(`${quote.quotationNo} ${why}`, 409, "QUOTATION_STATE");
    }
    const expiry = quotationExpiry(quote);
    if (expiry.expired) throw fail(`${quote.quotationNo} expired on ${expiry.validDay}. Revise it to offer it again.`, 409, "QUOTATION_EXPIRED");

    const dn = await DeliveryNoteService.create(
      {
        partyId: quote.partyId, date: input?.date, reference: quote.reference,
        items: quote.items.map((l) => S.toPricingInput(l.toObject())),
        charges: quote.charges.map((c) => c.toObject()), discount: quote.discount,
        notes: `From quotation ${quote.quotationNo}`,
        deliveryAddress: input?.deliveryAddress, contactPerson: input?.contactPerson, contactPhone: input?.contactPhone,
      },
      createdBy,
      session
    );
    dn.source = { kind: "quotation", id: quote._id, no: quote.quotationNo };
    await dn.save({ session });

    quote.status = "CONVERTED";
    quote.convertedTo = { kind: "delivery_note", id: dn._id, no: dn.deliveryNoteNo };
    quote.convertedAt = new Date();
    if (!quote.acceptedAt) quote.acceptedAt = quote.convertedAt;
    await quote.save({ session });
    return { quotation: quote, deliveryNote: dn };
  });

  static update = withTransactionSession(async (id, data, createdBy, session) => {
    const dn = await DeliveryNote.findById(id).session(session);
    if (!dn) throw fail("Delivery note not found", 404, "DELIVERY_NOTE_NOT_FOUND");
    if (!DELIVERY_EDITABLE.includes(dn.status)) {
      throw fail(`${dn.deliveryNoteNo} has been ${dn.status.toLowerCase()} and can no longer be edited`, 409, "DELIVERY_NOTE_NOT_EDITABLE");
    }
    const order = dn.source?.kind === "sales_order" && dn.source.id ? await loadOrder(dn.source.id, { session }) : null;
    if (!order && data.partyId && String(data.partyId) !== String(dn.partyId)) {
      await S.loadCustomer(data.partyId, { session });
      dn.partyId = data.partyId;
    }
    const date = data.date ? S.dayToDate(data.date) : dn.date;
    if (!date) throw fail("Enter a valid date", 400, "INVALID_DATE");

    if (data.items || data.charges !== undefined || data.discount !== undefined || data.date) {
      const lines = data.items
        ? await DeliveryNoteService.#buildLines(data, order, { session, excludeId: dn._id })
        : await S.prepareLines(dn.items.map((l) => ({ ...S.toPricingInput(l.toObject()), sourceLineId: l.sourceLineId || undefined })), { session });
      const priced = await S.priceDocument(
        { items: lines, charges: order ? [] : data.charges ?? dn.charges.map((c) => c.toObject()), discount: order ? 0 : data.discount ?? dn.discount, date },
        { session }
      );
      dn.items = priced.lines;
      dn.charges = priced.charges;
      dn.discount = order ? 0 : Number(data.discount ?? dn.discount) || 0;
      dn.pricing = priced.pricing;
      dn.totalAmount = priced.totalAmount;
    }
    dn.date = date;
    for (const k of ["reference", "deliveryAddress", "contactPerson", "contactPhone", "vehicleNo", "driverName", "driverPhone", "notes"]) {
      if (data[k] !== undefined) dn[k] = data[k] || "";
    }
    await dn.save({ session });
    return dn;
  });

  static remove = withTransactionSession(async (id, createdBy, session) => {
    const dn = await DeliveryNote.findById(id).session(session);
    if (!dn) throw fail("Delivery note not found", 404, "DELIVERY_NOTE_NOT_FOUND");
    if (dn.status !== "DRAFT") throw fail(`${dn.deliveryNoteNo} has been ${dn.status.toLowerCase()} and cannot be deleted`, 409, "DELIVERY_NOTE_NOT_DELETABLE");
    await DeliveryNote.deleteOne({ _id: dn._id }, { session });
    await Links.releaseQuotationsFor(dn._id, { session });
    return { deliveryNoteNo: dn.deliveryNoteNo, status: dn.status, totalAmount: dn.totalAmount };
  });

  static #load = async (id, action, session) => {
    const dn = await DeliveryNote.findById(id).session(session);
    if (!dn) throw fail("Delivery note not found", 404, "DELIVERY_NOTE_NOT_FOUND");
    if (!DELIVERY_ACTIONS[action].from.includes(dn.status)) {
      throw fail(`${dn.deliveryNoteNo} is ${dn.status.toLowerCase()}; it cannot be ${action === "cancel" ? "cancelled" : action + "ed"} from there`, 409, "DELIVERY_NOTE_STATE");
    }
    return dn;
  };

  static dispatch = withTransactionSession(async (id, input, createdBy, session) => {
    const dn = await DeliveryNoteService.#load(id, "dispatch", session);
    if (!dn.items.length) throw fail("A delivery note with no items cannot be dispatched", 400, "ITEMS_REQUIRED");
    for (const k of ["vehicleNo", "driverName", "driverPhone"]) if (input?.[k] !== undefined) dn[k] = input[k] || "";
    dn.dispatchedAt = new Date();
    dn.status = "DISPATCHED";
    await dn.save({ session });
    return dn;
  });

  // The customer signed for it. Who took delivery is the point of the document, so it is required; what
  // they actually accepted is recorded line by line, and the note's value follows that, not what was loaded.
  static deliver = withTransactionSession(async (id, input, createdBy, session) => {
    const dn = await DeliveryNoteService.#load(id, "deliver", session);
    const receivedBy = String(input?.receivedBy || "").trim();
    if (!receivedBy) throw fail("Enter the name of the person who received the goods", 400, "RECEIVED_BY_REQUIRED");

    const today = todayInDubai();
    const day = input?.deliveredAt ? toExpiryDay(input.deliveredAt) : today;
    if (!day) throw fail("Enter a valid delivery date", 400, "INVALID_DATE");
    if (diffDays(today, day) > 0) throw fail("The delivery date cannot be in the future", 400, "INVALID_DATE");
    if (diffDays(dubaiDay(dn.date), day) < 0) throw fail("The goods cannot be delivered before the note's date", 400, "INVALID_DATE");

    const settled = settleDelivery(dn.items, input?.lines);
    if (settled.errors.length) throw fail(settled.errors[0].message, 400, "INVALID_DELIVERY", settled.errors);

    // Reprice what was accepted, so the value (and any invoice raised from this note) matches the goods.
    const accepted = dn.items
      .map((l, i) => ({ line: l, delivered: settled.lines[i].deliveredQty }))
      .filter((x) => x.delivered > 0);
    const priced = await S.priceDocument(
      {
        items: accepted.map((x) => ({ ...S.toPricingInput(x.line.toObject(), x.delivered), sourceLineId: x.line.sourceLineId || undefined })),
        charges: dn.charges.map((c) => c.toObject()), discount: dn.discount, date: dn.date,
      },
      { session }
    );
    const pricedById = new Map(accepted.map((x, i) => [String(x.line._id), priced.lines[i]]));
    dn.items.forEach((l, i) => {
      l.deliveredQty = settled.lines[i].deliveredQty;
      l.shortReason = settled.lines[i].shortReason;
      const p = pricedById.get(String(l._id));
      for (const k of ["discountAmount", "grossAmount", "taxableAmount", "vatAmount", "lineTotal", "vatPercent", "taxKind"]) {
        l[k] = p ? p[k] : k === "vatPercent" || k === "taxKind" ? l[k] : 0;
      }
    });
    dn.pricing = priced.pricing;
    dn.totalAmount = priced.totalAmount;
    dn.deliveredAt = new Date(`${day}T12:00:00+04:00`); // midday Dubai: the calendar day is unambiguous in any timezone
    if (!dn.dispatchedAt) dn.dispatchedAt = dn.deliveredAt;
    dn.receivedBy = receivedBy;
    dn.proofNote = String(input?.proofNote || "").trim();
    dn.status = "DELIVERED";
    await dn.save({ session });
    return dn;
  });

  static cancel = withTransactionSession(async (id, input, createdBy, session) => {
    const dn = await DeliveryNoteService.#load(id, "cancel", session);
    dn.status = "CANCELLED";
    dn.cancelledAt = new Date();
    dn.cancelReason = String(input?.reason || "").trim();
    await dn.save({ session });
    await Links.releaseQuotationsFor(dn._id, { session });
    return dn;
  });

  // ---- invoicing ----------------------------------------------------------------------------

  // Raise ONE sales order (a draft invoice) for delivered notes of the same customer - a single note, or
  // a month's worth for a summary invoice. Each line is invoiced at the quantity actually accepted. The
  // order is approved like any other, and that is when stock and ledger move.
  static createInvoice = withTransactionSession(async (input, createdBy, session) => {
    const ids = [...new Set((input?.deliveryNoteIds || []).map(String))];
    if (!ids.length || !ids.every(S.isId)) throw fail("Choose the delivery notes to invoice", 400, "NOTES_REQUIRED");
    const { companyId } = getTenant();
    const notes = await DeliveryNote.find({ companyId, _id: { $in: ids } }).session(session);
    if (notes.length !== ids.length) throw fail("A delivery note was not found", 404, "DELIVERY_NOTE_NOT_FOUND");
    if (new Set(notes.map((n) => String(n.partyId))).size > 1) throw fail("Delivery notes for different customers cannot go on one invoice", 400, "MIXED_CUSTOMERS");

    for (const n of notes) {
      if (n.status !== "DELIVERED") throw fail(`${n.deliveryNoteNo} is ${n.status.toLowerCase()}; only delivered notes can be invoiced`, 409, "DELIVERY_NOTE_STATE");
      if (n.source?.kind === "sales_order") {
        throw fail(`${n.deliveryNoteNo} is against ${n.source.no}. Approve that order to invoice these goods.`, 409, "DELIVERY_NOTE_HAS_ORDER");
      }
      if (n.invoiceStatus !== INVOICE_STATE.NONE) throw fail(`${n.deliveryNoteNo} is already on ${n.invoice?.no || "an invoice"}`, 409, "ALREADY_INVOICED");
    }
    notes.sort((a, b) => a.deliveredAt - b.deliveredAt);

    const date = input?.date ? S.dayToDate(input.date) : new Date(todayInDubai());
    if (!date) throw fail("Enter a valid date", 400, "INVALID_DATE");
    const refs = [...new Set(notes.map((n) => n.reference).filter(Boolean))];
    const nos = notes.map((n) => n.deliveryNoteNo);

    const salesOrder = await TransactionService.createTransaction(
      {
        type: "sales_order",
        partyId: notes[0].partyId,
        partyType: "Customer",
        date,
        deliveryDate: notes[notes.length - 1].deliveredAt,
        // what was accepted, priced as the note priced it (its stored discount is already for that quantity)
        items: notes.flatMap((n) =>
          n.items.filter((l) => (l.deliveredQty ?? l.qty) > 0).map((l) => S.toPricingInput(l.toObject(), l.deliveredQty ?? l.qty, l.deliveredQty ?? l.qty))
        ),
        charges: notes.flatMap((n) => n.charges.map((c) => c.toObject())),
        discount: notes.reduce((t, n) => t + (n.discount || 0), 0),
        lpono: refs.join(", ") || null,
        linkedRef: nos.join(", "),
        notes: `Delivery notes ${nos.join(", ")}`,
        status: "DRAFT",
      },
      createdBy,
      session
    );

    for (const n of notes) {
      n.invoice = { kind: "sales_order", id: salesOrder._id, no: salesOrder.transactionNo };
      n.invoiceStatus = INVOICE_STATE.DRAFT;
      await n.save({ session });
    }
    return { salesOrder, deliveryNotes: notes };
  });
}

DeliveryNoteService.present = present;

module.exports = DeliveryNoteService;
