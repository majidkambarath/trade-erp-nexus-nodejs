const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const Stock = require("../../models/modules/stockModel");
const Customer = require("../../models/modules/customerModel");
const Transaction = require("../../models/modules/transactionModel");
const { Voucher } = require("../../models/modules/financial/financialModels");
const rules = require("../../utils/vanSales");
const kinds = require("../../utils/itemKinds");
const proposals = require("../../utils/assistantProposals");
const S = require("../orderPurchase/salesDocumentSupport");
const TransactionService = require("../orderPurchase/transactionService");
const ReturnService = require("../orderPurchase/returnService");
const FinancialService = require("../financial/financialService");
const AgeingService = require("../financial/ageingService");
const PriceListService = require("./priceListService");
const PromotionService = require("./promotionService");
const TradeOrder = require("../../models/modules/tradeOrderModel");
const { withTransactionSession } = require("../../utils/withTransactionSession");
const { todayInOrg } = require("../../utils/documentExpiry");
const { loadTrip, stockOf } = require("./vanTripStock");

const isId = (v) => mongoose.isValidObjectId(v);
const fail = (message, status, code, details) => new AppError(message, status, code, details);
const round2 = rules.round2;
const refOf = (trip) => ({ tripId: trip._id, tripNo: trip.tripNo, vanCode: trip.vanCode });
const orgDay = (d) => String(d || todayInOrg()).slice(0, 10);

// Selling, taking money and taking goods back, all ON a trip. Each is the product's own path - the same
// createTransaction, processTransaction, createVoucher and ReturnService every screen uses - so credit control,
// approval limits, the period lock and the audit trail apply exactly as they do anywhere else. What this module adds
// is the trip's own rule: the trip must be out, and the stock must be on the van (also enforced on approval, by
// vanTripGuard, so no other door can get around it).

/** Only a trip that is out may sell, collect or take a return. */
function assertSelling(trip) {
  if (!rules.SELLING.has(trip.status)) {
    throw fail(
      trip.status === "LOADING" ? "Send the van out before selling from it" : `This trip is ${String(trip.status).toLowerCase()}, so nothing more can be sold on it`,
      409, "TRIP_NOT_SELLING"
    );
  }
}

async function customerOf(id, session) {
  if (!isId(id)) throw fail("Choose a customer", 400, "CUSTOMER_REQUIRED");
  const c = await Customer.findById(id).select("customerName status").session(session).lean();
  if (!c || c.status === "Inactive") throw fail("That customer is not available", 404, "CUSTOMER_NOT_FOUND");
  return c;
}

/**
 * Take money against a customer on this trip: one receipt voucher, into the van's own cash account (cash) or the
 * cheque register (cheque). Joins the caller's transaction. Allocated to the invoices named, else oldest first;
 * whatever is left stays on account.
 */
async function takeMoney(trip, { customerId, amount, mode = "cash", details = {}, invoiceIds, date, narration }, by, { req, session }) {
  const total = round2(amount);
  if (!(total > 0)) throw fail("Enter the amount received", 400, "AMOUNT_REQUIRED");
  if (!["cash", "cheque"].includes(mode)) throw fail("On the road, money is taken in cash or by cheque", 400, "VAN_MODE_NOT_SUPPORTED");
  const customer = await customerOf(customerId, session);

  const open = (await AgeingService.openInvoices({ type: "receivable", partyId: customerId, session }))
    .filter((r) => String(r.partyId) === String(customerId))
    .map((r) => ({ id: String(r.transactionId), number: r.transactionNo, outstanding: r.outstanding, date: r.date }));
  const wanted = Array.isArray(invoiceIds) && invoiceIds.length ? new Set(invoiceIds.map(String)) : null;
  const { allocations } = proposals.allocateOldestFirst(wanted ? open.filter((i) => wanted.has(i.id)) : open, total);

  const paymentDetails = mode === "cash" ? { accountId: trip.cashAccountId } : { ...details };
  const voucher = await FinancialService.createVoucher(
    {
      voucherType: "receipt", customerId, customerName: customer.customerName, date: orgDay(date), totalAmount: total,
      paymentMode: mode, paymentDetails,
      linkedInvoices: allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount, balance: a.balance })),
      narration: narration || `Van ${trip.vanCode} ${trip.tripNo}`,
    },
    by, session, { req }
  );
  // the link to the trip is written after the voucher exists: a voucher body cannot carry it in
  await Voucher.updateOne({ _id: voucher._id }, { $set: { vanTripRef: { tripId: trip._id, tripNo: trip.tripNo } } }, { session });
  return Voucher.findById(voucher._id).session(session); // as stored now, with the trip link on it
}

class VanTripSales {
  /**
   * Sell from the van: a sales invoice for a customer, raised and APPROVED in one step (stock out, ledger, party
   * balance), optionally with the money taken at the same moment. A credit warning comes back as
   * RISK_WARNING_ACKNOWLEDGEMENT_REQUIRED; pressing on needs `acknowledged` and the right to (checked by the controller).
   */
  static sell = withTransactionSession(async (id, input, by, ...rest) => {
    const session = rest[rest.length - 1];
    const opts = rest.length > 1 ? rest[0] || {} : {};
    const trip = await loadTrip(id, session);
    assertSelling(trip);
    const customer = await customerOf(input?.customerId, session);
    const lines = Array.isArray(input?.items) ? input.items : [];
    if (!lines.length) throw fail("Add at least one item to sell", 400, "ITEMS_REQUIRED");

    const ids = lines.map((l) => l.itemId);
    if (ids.some((i) => !isId(i))) throw fail("An item on the invoice is not valid", 400, "ITEM_INVALID");
    const stocks = await Stock.find({ _id: { $in: ids } }).select("itemId itemName itemType salesPrice").session(session).lean();
    const byId = new Map(stocks.map((s) => [String(s._id), s]));
    const listed = await PriceListService.pricesFor({
      customerId: customer._id, routeId: trip.routeId, date: input.date, session,
      items: lines.map((l) => ({ stockId: l.itemId, qty: Number(l.qty) || 1, itemPrice: Number(byId.get(String(l.itemId))?.salesPrice) || 0 })),
    });
    const items = lines.map((l, i) => {
      const s = byId.get(String(l.itemId));
      if (!s) throw fail(`Line ${i + 1}: that item does not exist`, 404, "ITEM_NOT_FOUND");
      if (kinds.isService(s)) throw fail(`${s.itemName} is a service. Only stocked goods are sold from a van.`, 400, "VAN_GOODS_ONLY");
      const qty = Number(l.qty);
      if (!(qty > 0)) throw fail(`Line ${i + 1}: enter a quantity above zero`, 400, "QTY_INVALID");
      const list = listed.get(String(s._id));
      const typed = l.price !== undefined && l.price !== "" && l.price !== null;
      const price = typed ? Number(l.price) : list.price;
      if (!(price >= 0)) throw fail(`Line ${i + 1}: enter a price of zero or more`, 400, "PRICE_INVALID");
      // selling under the customer's list is a discount the business has not agreed: only someone who manages the vans may
      if (typed && price + 0.005 < list.price && !opts.mayUnderprice) {
        throw fail(`${s.itemName} is ${list.price.toFixed(2)} for this customer${list.listName ? ` (${list.listName})` : ""}. Selling it for less needs a supervisor.`, 403, "PRICE_BELOW_LIST", { stockId: String(s._id), listPrice: list.price });
      }
      return {
        itemId: s._id, itemCode: s.itemId, description: s.itemName, qty,
        price,
        discountPercent: Number(l.discountPercent) || 0,
        taxCodeId: l.taxCodeId || undefined,
        vatPercent: l.vatPercent,
      };
    });

    // Promotions, on the server whatever the phone worked out: a line's discount is the offer's (on top of any the
    // salesman typed), and goods given free are lines of their own at price 0 - they leave the van and the books at
    // cost like any other, so the stock check below counts them.
    const promo = await PromotionService.apply(items.map((l) => ({ itemId: String(l.itemId), qty: l.qty, price: l.price, discountPercent: l.discountPercent })), { customerId: customer._id, routeId: trip.routeId, date: input.date, session });
    promo.lines.forEach((p, i) => { items[i].discountPercent = p.discountPercent; });
    if (promo.free.length) {
      const freeStocks = await Stock.find({ _id: { $in: promo.free.map((f) => f.stockId) } }).select("itemId itemName itemType").session(session).lean();
      const named = new Map(freeStocks.map((s) => [String(s._id), s]));
      const offer = new Map(promo.applied.map((a) => [a.id, a.name]));
      for (const f of promo.free) {
        const s = named.get(String(f.stockId));
        if (!s || kinds.isService(s)) continue;
        items.push({ itemId: s._id, itemCode: s.itemId, description: `${s.itemName} (free: ${offer.get(f.promoId) || "offer"})`, qty: f.qty, price: 0, discountPercent: 0 });
        if (!byId.has(String(s._id))) byId.set(String(s._id), s);
      }
    }

    // a pre-order this sale delivers: the customer's own, still open
    let preorder = null;
    if (input.preorderId) {
      if (!isId(input.preorderId)) throw fail("That pre-order does not exist", 404, "PREORDER_NOT_FOUND");
      preorder = await TradeOrder.findById(input.preorderId).session(session);
      if (!preorder || preorder.kind !== "sales" || String(preorder.partyId) !== String(customer._id)) throw fail("That pre-order is not this customer's", 404, "PREORDER_NOT_FOUND");
      if (preorder.status !== "CONFIRMED") throw fail(`${preorder.orderNo} is ${String(preorder.status).toLowerCase()}, so it has nothing left to deliver`, 409, "PREORDER_NOT_OPEN");
    }

    // the friendly message first; vanTripGuard repeats it as the lock when the invoice is approved
    const stock = await stockOf(trip, { session });
    const short = rules.shortages(items, stock.sellable);
    if (short.length) {
      const first = short[0];
      const name = byId.get(first.stockId)?.itemName || "that item";
      throw fail(`Only ${first.available} of ${name} is on the van; this invoice sells ${first.wanted}`, 409, "VAN_STOCK_SHORT", { short });
    }

    const day = orgDay(input.date);
    let reservedNumber;
    if (input.number) {
      reservedNumber = String(input.number).trim().toUpperCase();
      if (!(trip.numberBlock || []).includes(reservedNumber)) throw fail(`${reservedNumber} is not one of this trip's reserved numbers`, 400, "NUMBER_NOT_RESERVED");
      if (await Transaction.exists({ transactionNo: reservedNumber }).session(session)) throw fail(`${reservedNumber} has already been used`, 409, "NUMBER_ALREADY_USED");
    }
    const invoice = await TransactionService.createTransaction(
      {
        reservedNumber,
        type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", date: day, items,
        notes: input.notes ? String(input.notes).slice(0, 500) : `Van ${trip.vanCode} ${trip.tripNo}`,
        status: "DRAFT", vanTripRef: refOf(trip),
      },
      by, session
    );
    await TransactionService.processTransaction(invoice._id, "approve", by, { req: opts.req, acknowledged: input.acknowledged === true }, session);
    const approved = await Transaction.findById(invoice._id).session(session);
    // a first approval of two leaves it a draft: the sale is not made, and the person must know
    if (approved.status !== "APPROVED") {
      throw fail("This invoice needs a second approval before it can be completed, so it cannot be sold from the van", 409, "VAN_SALE_NEEDS_APPROVAL");
    }

    let receipt = null;
    const pay = input.payNow;
    if (pay && (pay.full === true || Number(pay.amount) > 0)) {
      const amount = pay.full === true ? round2(approved.totalAmount) : round2(pay.amount);
      if (amount > round2(approved.totalAmount) + 0.005) throw fail("The money taken is more than the invoice. Take the rest as a separate receipt.", 400, "PAYMENT_EXCEEDS_INVOICE");
      receipt = await takeMoney(trip, { customerId: customer._id, amount, mode: pay.mode || "cash", details: pay.details, invoiceIds: [String(approved._id)], date: day }, by, { req: opts.req, session });
    }
    if (preorder) {
      preorder.status = "CLOSED";
      preorder.closedAt = new Date();
      preorder.closeReason = `Delivered by van ${trip.vanCode} on ${trip.tripNo} (${approved.transactionNo})`;
      await preorder.save({ session });
    }
    return { invoice: approved, receipt, promotions: promo.applied, preorder: preorder ? preorder.orderNo : null };
  });

  /** Take money from a customer (cash or a cheque): against named invoices, else the oldest first. */
  static collect = withTransactionSession(async (id, input, by, ...rest) => {
    const session = rest[rest.length - 1];
    const opts = rest.length > 1 ? rest[0] || {} : {};
    const trip = await loadTrip(id, session);
    assertSelling(trip);
    const voucher = await takeMoney(trip, input || {}, by, { req: opts.req, session });
    return { receipt: voucher };
  });

  /**
   * Take goods back from a customer against one of their approved invoices. Each line says whether it came back
   * sellable (it goes back on the van) or damaged (it does not). The return is approved at once, like a sale.
   */
  static returnGoods = withTransactionSession(async (id, input, by, ...rest) => {
    const session = rest[rest.length - 1];
    const opts = rest.length > 1 ? rest[0] || {} : {};
    const trip = await loadTrip(id, session);
    assertSelling(trip);
    const customer = await customerOf(input?.customerId, session);
    if (!isId(input?.returnOfId)) throw fail("Choose the invoice the goods are returned against", 400, "RETURN_LINK_REQUIRED");
    const original = await Transaction.findById(input.returnOfId).session(session);
    if (!original || original.type !== "sales_order") throw fail("That invoice does not exist", 404, "ORIGINAL_NOT_FOUND");
    const wanted = Array.isArray(input.lines) ? input.lines : [];
    if (!wanted.length) throw fail("Add at least one item being returned", 400, "ITEMS_REQUIRED");

    const items = [];
    const record = [];
    for (const [i, w] of wanted.entries()) {
      const qty = Number(w.qty);
      if (!(qty > 0)) throw fail(`Line ${i + 1}: enter a quantity above zero`, 400, "QTY_INVALID");
      const line = original.items.find((l) => String(l._id) === String(w.lineId)) || original.items.find((l) => String(l.itemId) === String(w.itemId));
      if (!line) throw fail(`Line ${i + 1} is not on ${original.transactionNo}`, 400, "LINE_NOT_IN_ORIGINAL");
      if (kinds.isService(line)) throw fail("A service cannot be returned to a van", 400, "VAN_GOODS_ONLY");
      const condition = w.condition === "damaged" ? "damaged" : "good";
      items.push({ ...S.toPricingInput(line, qty, line.qty), returnOfLineId: line._id });
      record.push({ stockId: line.itemId, qty, condition });
    }
    const day = orgDay(input.date);
    const ret = await TransactionService.createTransaction(
      {
        type: "sales_return", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", date: day, items,
        returnOf: { transactionId: original._id }, status: "DRAFT", vanTripRef: refOf(trip),
        notes: input.notes ? String(input.notes).slice(0, 500) : `Van ${trip.vanCode} ${trip.tripNo}`,
      },
      by, session
    );
    await TransactionService.processTransaction(ret._id, "approve", by, { req: opts.req }, session);
    const approved = await Transaction.findById(ret._id).session(session);
    if (approved.status !== "APPROVED") throw fail("This return needs a second approval, so it cannot be taken on the van", 409, "VAN_SALE_NEEDS_APPROVAL");
    trip.returns.push({ transactionId: approved._id, no: approved.transactionNo, at: new Date(), lines: record });
    trip.updatedBy = String(by);
    await trip.save({ session });
    return { creditNote: approved };
  });

  /** What each item on the van costs THIS customer (their price list, else the route's, else the item's own price). */
  static async prices(tripId, customerId) {
    const trip = await loadTrip(tripId);
    if (!isId(customerId)) throw fail("Choose a customer", 400, "CUSTOMER_REQUIRED");
    const stock = await stockOf(trip);
    const ids = [...stock.sellable.keys()];
    const items = await Stock.find({ _id: { $in: ids } }).select("salesPrice").lean();
    const map = await PriceListService.pricesFor({ customerId, routeId: trip.routeId, items: items.map((s) => ({ stockId: s._id, qty: 1, itemPrice: Number(s.salesPrice) || 0 })) });
    return [...map].map(([stockId, p]) => ({ stockId, ...p }));
  }

  /**
   * Everything the phone keeps for working with no signal, read in one go while it still has some: the trip and what is
   * on the van, the customers it may sell to (the route's, plus any the salesman searched for), each one's prices for
   * what is on the van, and the reserved invoice numbers not used yet. Stamped with the time it was read, which the
   * screen shows: a figure from this pack is "as of" that time, never passed off as live.
   */
  static async offlinePack(tripId, { extraCustomerIds = [] } = {}) {
    const VanTripService = require("./vanTripService");
    const trip = await loadTrip(tripId);
    const shown = await VanTripService.present(trip);
    const route = trip.routeId ? await require("../../models/modules/vansales/vanRouteModel").findById(trip.routeId).lean() : null;
    const ids = [...new Set([...(route?.customers || []).map((c) => String(c.customerId)), ...extraCustomerIds.map(String)])].filter(isId).slice(0, 300);
    const customers = await Customer.find({ _id: { $in: ids } }).select("customerName customerId phone trnNumber vat.trn status").lean();
    const stock = await stockOf(trip);
    const items = await Stock.find({ _id: { $in: [...stock.sellable.keys()] } }).select("salesPrice category").lean();
    const prices = {};
    for (const c of customers) {
      const map = await PriceListService.pricesFor({ customerId: c._id, routeId: trip.routeId, items: items.map((s) => ({ stockId: s._id, qty: 1, itemPrice: Number(s.salesPrice) || 0 })) });
      prices[String(c._id)] = Object.fromEntries([...map].map(([k, p]) => [k, p.price]));
    }
    const used = new Set((await Transaction.find({ transactionNo: { $in: trip.numberBlock || [] } }).select("transactionNo").lean()).map((t) => t.transactionNo));
    return {
      at: new Date().toISOString(),
      trip: shown,
      customers: customers.filter((c) => c.status !== "Inactive").map((c) => ({ id: String(c._id), name: c.customerName, code: c.customerId || "", phone: c.phone || "", trn: c.vat?.trn || c.trnNumber || "" })),
      prices,
      freeNumbers: (trip.numberBlock || []).filter((n) => !used.has(n)),
      // the offers, so a slip printed with no signal shows what the server will give (it applies them again on sync)
      promotions: await PromotionService.live(),
      categories: Object.fromEntries(items.map((s) => [String(s._id), s.category ? String(s.category) : ""])),
    };
  }

  /** What a customer still owes and which of their invoices can be returned against: the salesman's lookup on the road. */
  static async customerPosition(customerId) {
    const open = (await AgeingService.openInvoices({ type: "receivable", partyId: customerId }))
      .filter((r) => String(r.partyId) === String(customerId))
      .map((r) => ({ id: String(r.transactionId), number: r.transactionNo, outstanding: r.outstanding, date: r.date }));
    const owed = round2(open.reduce((t, r) => t + Number(r.outstanding || 0), 0));
    return { owed, open };
  }

  /** The lines of an invoice that can still be returned (feeds the return form). */
  static async returnable(originalId) {
    return ReturnService.returnable(originalId);
  }
}

module.exports = VanTripSales;
