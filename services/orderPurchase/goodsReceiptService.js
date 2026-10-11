const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const GoodsReceipt = require("../../models/modules/goodsReceiptModel");
const TradeOrder = require("../../models/modules/tradeOrderModel");
const Vendor = require("../../models/modules/vendorModel");
const NumberSeriesService = require("../core/numberSeriesService");
const TransactionService = require("./transactionService");
const TradeOrderService = require("./tradeOrderService");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { getTenant } = require("../../utils/tenant");
const { todayInOrg, orgDay, diffDays, toExpiryDay } = require("../../utils/documentExpiry");
const { RECEIPT_ACTIONS, RECEIPT_EDITABLE, INVOICE_STATE, ORDER_OPEN, orderProgress } = require("../../utils/tradeOrders");
const S = require("./salesDocumentSupport");

// A goods receipt is the paper that says what a vendor's goods turned out to be on arrival. It posts nothing and moves no
// stock: stock comes in, the vendor is credited and input VAT is claimed when the PURCHASE INVOICE made from it is
// approved, and that invoice can bill no more than was received (receiptLinks.js). Its lines are priced from the order
// (price, discount, tax code) so the invoice made from it matches what was agreed.
//
//   against a purchase order   the lines are the order's (part by part); it tracks how much of the order has arrived
//   on its own                 goods that came without an order (a direct purchase)
//
// Lifecycle:  DRAFT -> RECEIVED (a person signed for it)         DRAFT | RECEIVED -> CANCELLED (until it is invoiced)

const fail = (message, status, code, details) => new AppError(message, status, code, details);
const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

const VENDOR_FIELDS = "vendorId vendorName contactPerson email phone address trnNO vat paymentTerms status";

function present(gr) {
  const invoiced = gr.invoiceStatus && gr.invoiceStatus !== INVOICE_STATE.NONE;
  return {
    ...gr,
    actions: {
      edit: RECEIPT_EDITABLE.includes(gr.status),
      delete: gr.status === "DRAFT",
      receive: RECEIPT_ACTIONS.receive.from.includes(gr.status),
      cancel: RECEIPT_ACTIONS.cancel.from.includes(gr.status) && !invoiced,
      invoice: gr.status === "RECEIVED" && gr.invoiceStatus === INVOICE_STATE.NONE,
    },
  };
}

// The order a receipt is raised against: it must be confirmed (open) and the same vendor's.
async function loadOrder(id, { session } = {}) {
  if (!S.isId(id)) throw fail("Invalid purchase order", 400, "ORDER_REQUIRED");
  const q = TradeOrder.findById(id).lean();
  const order = await (session ? q.session(session) : q);
  if (!order || order.kind !== "purchase") throw fail("Purchase order not found", 404, "ORDER_NOT_FOUND");
  if (!ORDER_OPEN.includes(order.status)) {
    throw fail(`${order.orderNo} is ${order.status.toLowerCase()}; nothing can be received against it${order.status === "DRAFT" ? ". Confirm it first" : ""}`, 409, "ORDER_NOT_RECEIVABLE");
  }
  return order;
}

async function progressOf(order, { session } = {}) {
  const lines = (await TradeOrderService.receiptLinesFor("purchase", [order._id], { session })).get(String(order._id)) || [];
  return orderProgress(order.items, lines);
}

// Every line of every live receipt against an order except one (the one being edited), for the remaining sums.
async function otherReceiptLines(orderId, excludeId, { session } = {}) {
  const { companyId } = getTenant();
  const q = GoodsReceipt.find({ companyId, "source.kind": "purchase_order", "source.id": orderId, status: { $ne: "CANCELLED" }, ...(excludeId && { _id: { $ne: excludeId } }) })
    .select("status invoiceStatus items.sourceLineId items.qty items.receivedQty")
    .lean();
  const receipts = await (session ? q.session(session) : q);
  return receipts.flatMap((r) => r.items.map((l) => ({ sourceLineId: l.sourceLineId, status: r.status, qty: l.qty, receivedQty: l.receivedQty, invoiceStatus: r.invoiceStatus })));
}

class GoodsReceiptService {
  // ---- reading -----------------------------------------------------------------------------
  static async list(filters = {}) {
    const { companyId } = getTenant();
    const q = { companyId };
    // "UNINVOICED": received and still waiting for an invoice
    if (filters.status === "UNINVOICED") Object.assign(q, { status: "RECEIVED", invoiceStatus: { $ne: INVOICE_STATE.INVOICED } });
    else if (filters.status) q.status = String(filters.status);
    if (filters.invoiceStatus) q.invoiceStatus = String(filters.invoiceStatus);
    if (filters.partyId) {
      if (!S.isId(filters.partyId)) throw fail("Invalid vendor", 400);
      q.partyId = new mongoose.Types.ObjectId(filters.partyId);
    }
    if (filters.sourceId) {
      if (!S.isId(filters.sourceId)) throw fail("Invalid purchase order", 400);
      q["source.id"] = new mongoose.Types.ObjectId(filters.sourceId);
    }
    if (filters.invoiceId) {
      if (!S.isId(filters.invoiceId)) throw fail("Invalid invoice", 400);
      q["invoice.id"] = new mongoose.Types.ObjectId(filters.invoiceId);
    }
    const dateFrom = S.dayFilter(filters.dateFrom, "dateFrom");
    const dateTo = S.dayFilter(filters.dateTo, "dateTo");
    if (dateFrom || dateTo) q.date = { ...(dateFrom && { $gte: dateFrom }), ...(dateTo && { $lte: new Date(dateTo.getTime() + 86399999) }) };
    if (filters.search) {
      const r = new RegExp(S.escapeRegex(filters.search), "i");
      const vendors = await Vendor.find({ $or: [{ vendorName: r }, { vendorId: r }] }).select("_id").limit(200).lean();
      q.$or = [{ receiptNo: r }, { vendorDeliveryNo: r }, { reference: r }, { vehicleNo: r }, { receivedBy: r }, { "items.description": r }, { partyId: { $in: vendors.map((p) => p._id) } }];
    }
    const { page, limit, skip } = S.pageOf(filters);
    const [rows, total] = await Promise.all([
      GoodsReceipt.find(q).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      GoodsReceipt.countDocuments(q),
    ]);
    const vendors = await Vendor.find({ _id: { $in: rows.map((r) => r.partyId) } }).select("vendorId vendorName").lean();
    const byId = new Map(vendors.map((p) => [String(p._id), p]));
    return {
      rows: rows.map((r) => {
        const v = byId.get(String(r.partyId));
        return { ...present(r), party: v ? { _id: v._id, name: v.vendorName, code: v.vendorId } : null };
      }),
      pagination: { current: page, pages: Math.ceil(total / limit), total, limit },
    };
  }

  static async summary() {
    const { companyId } = getTenant();
    const rows = await GoodsReceipt.aggregate([
      { $match: { companyId } },
      { $group: { _id: { status: "$status", invoiced: { $eq: ["$invoiceStatus", INVOICE_STATE.INVOICED] } }, count: { $sum: 1 }, value: { $sum: "$totalAmount" } } },
    ]);
    const byStatus = {};
    let uninvoiced = { count: 0, value: 0 };
    for (const r of rows) {
      byStatus[r._id.status] = (byStatus[r._id.status] || 0) + r.count;
      if (r._id.status === "RECEIVED" && !r._id.invoiced) uninvoiced = { count: uninvoiced.count + r.count, value: uninvoiced.value + r.value };
    }
    return { byStatus, uninvoiced: { count: uninvoiced.count, value: Math.round(uninvoiced.value * 100) / 100 } };
  }

  static async getById(id) {
    if (!S.isId(id)) throw fail("Invalid goods receipt id", 400);
    const gr = await GoodsReceipt.findById(id).lean();
    if (!gr) throw fail("Goods receipt not found", 404, "RECEIPT_NOT_FOUND");
    const [vendor, items] = await Promise.all([Vendor.findById(gr.partyId).select(VENDOR_FIELDS).lean(), S.attachStockDetails(gr.items)]);
    let order = null;
    let progress = null;
    if (gr.source?.kind === "purchase_order" && gr.source.id) {
      order = await TradeOrder.findById(gr.source.id).select("orderNo status date items._id items.qty items.description items.itemCode").lean();
      if (order) progress = await progressOf(order);
    }
    return {
      ...present({ ...gr, items }),
      party: vendor,
      sourceOrder: order ? { id: order._id, no: order.orderNo, status: order.status, lines: order.items.map((l) => ({ lineId: l._id, description: l.description, itemCode: l.itemCode })) } : null,
      progress,
    };
  }

  // What can still be received on each line of a purchase order: the starting point for a receipt against it.
  static async prefillFromOrder(orderId) {
    const order = await loadOrder(orderId);
    const [vendor, progress, items] = await Promise.all([TradeOrderService.loadParty("purchase", order.partyId), progressOf(order), S.attachStockDetails(order.items)]);
    return {
      order: { id: order._id, no: order.orderNo, status: order.status, date: order.date, reference: order.reference || "", expectedDate: order.expectedDate },
      party: vendor,
      lines: items.map((l) => ({
        sourceLineId: l._id, itemId: l.itemId, itemCode: l.itemCode, description: l.description, stockDetails: l.stockDetails,
        price: l.price, batchNumber: l.batchNumber || "", expiryDate: l.expiryDate || null, ...progress.lines[String(l._id)],
      })),
    };
  }

  // ---- writing -----------------------------------------------------------------------------
  static async #buildLines(data, order, { session, excludeId } = {}) {
    if (!order) {
      const prepared = await S.prepareLines(data.items, { session });
      // prepareLines keeps what it prices; the batch details ride along beside it
      return prepared.map((p, i) => ({ ...p, batchNumber: data.items[i].batchNumber || "", expiryDate: data.items[i].expiryDate || null }));
    }
    if (!Array.isArray(data.items) || !data.items.length) throw fail("Add at least one item", 400, "ITEMS_REQUIRED");
    const others = await otherReceiptLines(order._id, excludeId, { session });
    const progress = orderProgress(order.items, others);
    const taken = new Map();
    const inputs = data.items.map((given, index) => {
      const n = index + 1;
      const line = order.items.find((x) => String(x._id) === String(given.sourceLineId));
      if (!line) throw fail(`Line ${n}: that item is not on ${order.orderNo}`, 400, "LINE_NOT_ON_ORDER");
      const qty = Number(given.qty);
      if (!(qty > 0)) throw fail(`Line ${n}: quantity must be above zero`, 400, "INVALID_QUANTITY");
      const key = String(line._id);
      const total = (taken.get(key) || 0) + qty;
      taken.set(key, total);
      const left = progress.lines[key].toReceive;
      if (r3(total - left) > 0) {
        throw fail(`Line ${n}: only ${left} of ${line.description} is left to receive on ${order.orderNo}`, 409, "OVER_RECEIPT", { line: n, remaining: left });
      }
      return {
        ...S.toPricingInput(line, qty),
        sourceLineId: line._id,
        // what the order expects, which a person can overwrite on the receipt
        batchNumber: given.batchNumber ?? line.batchNumber ?? "",
        expiryDate: given.expiryDate ?? line.expiryDate ?? null,
      };
    });
    const prepared = await S.prepareLines(inputs, { session });
    // prepareLines keeps only what it prices; the batch details ride along beside it
    return prepared.map((p, i) => ({ ...p, batchNumber: inputs[i].batchNumber || "", expiryDate: inputs[i].expiryDate || null }));
  }

  static create = withTransactionSession(async (data, createdBy, session) => {
    const { companyId, branchId } = getTenant();
    const order = data.sourceOrderId ? await loadOrder(data.sourceOrderId, { session }) : null;
    const vendor = await TradeOrderService.loadParty("purchase", order ? order.partyId : data.partyId, { session });
    const date = S.dayToDate(data.date) || new Date(todayInOrg());
    const lines = await GoodsReceiptService.#buildLines(data, order, { session });
    const priced = await S.priceDocument({ items: lines, charges: order ? [] : data.charges, discount: order ? 0 : data.discount, date }, { session });
    const receiptNo = await NumberSeriesService.allocate("GRN", date, { session });
    const [doc] = await GoodsReceipt.create(
      [{
        companyId, branchId, receiptNo, partyId: vendor._id, date, status: "DRAFT",
        source: order ? { kind: "purchase_order", id: order._id, no: order.orderNo } : { kind: "manual" },
        vendorDeliveryNo: data.vendorDeliveryNo || "", reference: data.reference || order?.reference || "",
        vehicleNo: data.vehicleNo || "", driverName: data.driverName || "",
        items: priced.lines.map((l, i) => ({ ...l, batchNumber: lines[i].batchNumber || "", expiryDate: lines[i].expiryDate || null })),
        // charges and a header discount follow the whole order onto its invoice, so a part receipt carries none of them
        charges: order ? [] : priced.charges, discount: order ? 0 : Number(data.discount) || 0, pricing: priced.pricing, totalAmount: priced.totalAmount,
        notes: data.notes || "", createdBy,
      }],
      { session }
    );
    return doc;
  });

  static update = withTransactionSession(async (id, data, createdBy, session) => {
    const gr = await GoodsReceipt.findById(id).session(session);
    if (!gr) throw fail("Goods receipt not found", 404, "RECEIPT_NOT_FOUND");
    if (!RECEIPT_EDITABLE.includes(gr.status)) throw fail(`${gr.receiptNo} is ${gr.status.toLowerCase()} and can no longer be edited`, 409, "RECEIPT_NOT_EDITABLE");
    const order = gr.source?.kind === "purchase_order" && gr.source.id ? await loadOrder(gr.source.id, { session }) : null;
    if (!order && data.partyId && String(data.partyId) !== String(gr.partyId)) {
      await TradeOrderService.loadParty("purchase", data.partyId, { session });
      gr.partyId = data.partyId;
    }
    const date = data.date ? S.dayToDate(data.date) : gr.date;
    if (!date) throw fail("Enter a valid date", 400, "INVALID_DATE");
    if (data.items || data.charges !== undefined || data.discount !== undefined || data.date) {
      const lines = data.items
        ? await GoodsReceiptService.#buildLines(data, order, { session, excludeId: gr._id })
        : gr.items.map((l) => ({ ...S.toPricingInput(l.toObject()), sourceLineId: l.sourceLineId || undefined, batchNumber: l.batchNumber, expiryDate: l.expiryDate }));
      const prepared = data.items ? lines : await S.prepareLines(lines, { session });
      const priced = await S.priceDocument(
        { items: prepared, charges: order ? [] : data.charges ?? gr.charges.map((c) => c.toObject()), discount: order ? 0 : data.discount ?? gr.discount, date },
        { session }
      );
      gr.items = priced.lines.map((l, i) => ({ ...l, batchNumber: lines[i].batchNumber || "", expiryDate: lines[i].expiryDate || null }));
      gr.charges = priced.charges;
      gr.discount = order ? 0 : Number(data.discount ?? gr.discount) || 0;
      gr.pricing = priced.pricing;
      gr.totalAmount = priced.totalAmount;
    }
    gr.date = date;
    for (const k of ["vendorDeliveryNo", "reference", "vehicleNo", "driverName", "notes"]) if (data[k] !== undefined) gr[k] = data[k] || "";
    await gr.save({ session });
    return gr;
  });

  static remove = withTransactionSession(async (id, createdBy, session) => {
    const gr = await GoodsReceipt.findById(id).session(session);
    if (!gr) throw fail("Goods receipt not found", 404, "RECEIPT_NOT_FOUND");
    if (gr.status !== "DRAFT") throw fail(`${gr.receiptNo} has been ${gr.status.toLowerCase()} and cannot be deleted`, 409, "RECEIPT_NOT_DELETABLE");
    await GoodsReceipt.deleteOne({ _id: gr._id }, { session });
    return { receiptNo: gr.receiptNo, status: gr.status, totalAmount: gr.totalAmount };
  });

  static #load = async (id, action, session) => {
    const gr = await GoodsReceipt.findById(id).session(session);
    if (!gr) throw fail("Goods receipt not found", 404, "RECEIPT_NOT_FOUND");
    if (!RECEIPT_ACTIONS[action].from.includes(gr.status)) {
      throw fail(`${gr.receiptNo} is ${gr.status.toLowerCase()}; it cannot be ${action === "cancel" ? "cancelled" : "received"} from there`, 409, "RECEIPT_STATE");
    }
    return gr;
  };

  // A person signed for the goods. Who took them in is the point of the document, so it is required; what actually arrived
  // is recorded line by line, and the receipt's value follows that, not what was expected.
  static receive = withTransactionSession(async (id, input, createdBy, session) => {
    const gr = await GoodsReceiptService.#load(id, "receive", session);
    const receivedBy = String(input?.receivedBy || "").trim();
    if (!receivedBy) throw fail("Enter the name of the person who received the goods", 400, "RECEIVED_BY_REQUIRED");
    if (!gr.items.length) throw fail("A goods receipt with no items cannot be received", 400, "ITEMS_REQUIRED");

    const today = todayInOrg();
    const day = input?.receivedAt ? toExpiryDay(input.receivedAt) : today;
    if (!day) throw fail("Enter a valid date", 400, "INVALID_DATE");
    if (diffDays(today, day) > 0) throw fail("The date received cannot be in the future", 400, "INVALID_DATE");
    if (diffDays(orgDay(gr.date), day) < 0) throw fail("The goods cannot be received before the receipt's date", 400, "INVALID_DATE");

    const byLine = new Map((input?.lines || []).map((l) => [String(l.lineId), l]));
    const errors = [];
    const settled = gr.items.map((line, index) => {
      const given = byLine.get(String(line._id));
      const qty = Number(line.qty) || 0;
      const receivedQty = given && given.receivedQty !== undefined && given.receivedQty !== "" ? Number(given.receivedQty) : qty;
      if (!Number.isFinite(receivedQty) || receivedQty < 0) errors.push(`Line ${index + 1}: quantity received must be zero or more`);
      else if (r3(receivedQty) > qty) errors.push(`Line ${index + 1}: received ${receivedQty} is more than the ${qty} expected. Raise the order first.`);
      const short = r3(qty - receivedQty) > 0;
      const shortReason = short ? String(given?.shortReason || "").trim() : "";
      if (short && !shortReason) errors.push(`Line ${index + 1}: say why ${r3(qty - receivedQty)} was not received`);
      return {
        receivedQty: r3(receivedQty), shortReason,
        batchNumber: given?.batchNumber !== undefined ? String(given.batchNumber || "").trim() : line.batchNumber || "",
        expiryDate: given?.expiryDate !== undefined ? given.expiryDate || null : line.expiryDate || null,
      };
    });
    if (!errors.length && settled.every((s) => s.receivedQty === 0)) errors.push("Nothing was received. Cancel the receipt instead.");
    if (errors.length) throw fail(errors[0], 400, "INVALID_RECEIPT", errors);

    // Reprice what was accepted, so the value (and the invoice made from it) matches the goods.
    const accepted = gr.items.map((l, i) => ({ line: l, got: settled[i].receivedQty })).filter((x) => x.got > 0);
    const priced = await S.priceDocument(
      { items: accepted.map((x) => ({ ...S.toPricingInput(x.line.toObject(), x.got), sourceLineId: x.line.sourceLineId || undefined })), charges: gr.charges.map((c) => c.toObject()), discount: gr.discount, date: gr.date },
      { session }
    );
    const pricedById = new Map(accepted.map((x, i) => [String(x.line._id), priced.lines[i]]));
    gr.items.forEach((l, i) => {
      Object.assign(l, settled[i]);
      const p = pricedById.get(String(l._id));
      for (const k of ["discountAmount", "grossAmount", "taxableAmount", "vatAmount", "lineTotal", "vatPercent", "taxKind"]) l[k] = p ? p[k] : k === "vatPercent" || k === "taxKind" ? l[k] : 0;
      if (p) l.rcmVat = p.rcmVat;
      else if (l.rcmVat != null) l.rcmVat = 0;
    });
    gr.pricing = priced.pricing;
    gr.totalAmount = priced.totalAmount;
    gr.receivedAt = require("../../utils/orgLocale").noonOf(day);
    gr.receivedBy = receivedBy;
    gr.proofNote = String(input?.proofNote || "").trim();
    if (input?.vendorDeliveryNo !== undefined) gr.vendorDeliveryNo = String(input.vendorDeliveryNo || "").trim();
    gr.status = "RECEIVED";
    await gr.save({ session });
    return gr;
  });

  static cancel = withTransactionSession(async (id, input, createdBy, session) => {
    const gr = await GoodsReceiptService.#load(id, "cancel", session);
    if (gr.invoiceStatus !== INVOICE_STATE.NONE) {
      throw fail(`${gr.receiptNo} is on ${gr.invoice?.no || "an invoice"}. Delete or reject that invoice first.`, 409, "RECEIPT_INVOICED");
    }
    gr.status = "CANCELLED";
    gr.cancelledAt = new Date();
    gr.cancelReason = String(input?.reason || "").trim();
    await gr.save({ session });
    return gr;
  });

  // ---- invoicing ---------------------------------------------------------------------------
  // Raise ONE purchase invoice (a draft) for received receipts of the same vendor. Each line is billed at the quantity
  // actually received, at the price agreed on the order. Approving the invoice is when stock comes in and the ledger moves,
  // and it can never bill more than was received (receiptLinks.assertWithinReceipts).
  static createInvoice = withTransactionSession(async (input, createdBy, session) => {
    const ids = [...new Set((input?.receiptIds || []).map(String))];
    if (!ids.length || !ids.every(S.isId)) throw fail("Choose the goods receipts to invoice", 400, "RECEIPTS_REQUIRED");
    const { companyId } = getTenant();
    const receipts = await GoodsReceipt.find({ companyId, _id: { $in: ids } }).session(session);
    if (receipts.length !== ids.length) throw fail("A goods receipt was not found", 404, "RECEIPT_NOT_FOUND");
    if (new Set(receipts.map((r) => String(r.partyId))).size > 1) throw fail("Goods received from different vendors cannot go on one invoice", 400, "MIXED_VENDORS");
    for (const r of receipts) {
      if (r.status !== "RECEIVED") throw fail(`${r.receiptNo} is ${r.status.toLowerCase()}; only received goods can be invoiced`, 409, "RECEIPT_STATE");
      if (r.invoiceStatus !== INVOICE_STATE.NONE) throw fail(`${r.receiptNo} is already on ${r.invoice?.no || "an invoice"}`, 409, "ALREADY_INVOICED");
    }
    receipts.sort((a, b) => a.receivedAt - b.receivedAt);
    const date = input?.date ? S.dayToDate(input.date) : new Date(todayInOrg());
    if (!date) throw fail("Enter a valid date", 400, "INVALID_DATE");
    const nos = receipts.map((r) => r.receiptNo);
    const vendorNos = [...new Set(receipts.map((r) => r.vendorDeliveryNo).filter(Boolean))];

    const invoice = await TransactionService.createTransaction(
      {
        type: "purchase_order",
        partyId: receipts[0].partyId,
        partyType: "Vendor",
        date,
        deliveryDate: receipts[receipts.length - 1].receivedAt,
        // the vendor's own invoice number, which is what this document records
        vendorReference: String(input?.vendorInvoiceNo || "").trim() || vendorNos.join(", ") || undefined,
        items: receipts.flatMap((r) =>
          r.items
            .filter((l) => (l.receivedQty ?? l.qty) > 0)
            .map((l) => ({
              ...S.toPricingInput(l.toObject(), l.receivedQty ?? l.qty, l.receivedQty ?? l.qty),
              rate: l.price, // the purchase log records each line's rate; the price it was priced at is the same figure
              batchNumber: l.batchNumber || undefined,
              expiryDate: l.expiryDate || undefined,
            }))
        ),
        charges: receipts.flatMap((r) => r.charges.map((c) => c.toObject())),
        discount: receipts.reduce((t, r) => t + (r.discount || 0), 0),
        notes: `Goods received ${nos.join(", ")}`,
        status: "DRAFT",
      },
      createdBy,
      session
    );

    for (const r of receipts) {
      r.invoice = { kind: "purchase_order", id: invoice._id, no: invoice.transactionNo };
      r.invoiceStatus = INVOICE_STATE.DRAFT;
      await r.save({ session });
    }
    return { purchaseInvoice: invoice, goodsReceipts: receipts };
  });
}

GoodsReceiptService.present = present;

module.exports = GoodsReceiptService;
