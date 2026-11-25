const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const Stock = require("../../models/modules/stockModel");
const Customer = require("../../models/modules/customerModel");
const Van = require("../../models/modules/vansales/vanModel");
const Transaction = require("../../models/modules/transactionModel");
const { Voucher } = require("../../models/modules/financial/financialModels");
const rules = require("../../utils/vanSales");
const vanRules = require("../../utils/vanSettings");
const VanSettingsService = require("./vanSettingsService");
const VanRoute = require("../../models/modules/vansales/vanRouteModel");
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
  const c = await Customer.findById(id).select("customerName status paymentTerms").session(session).lean();
  if (!c || c.status === "Inactive") throw fail("That customer is not available", 404, "CUSTOMER_NOT_FOUND");
  return c;
}

/**
 * The organisation's "only the customers on the route" rule. A van that may sell to anyone, and a supervisor
 * (`mayOverride`), are never refused, so the route is not even read for them.
 */
async function assertCustomerAllowed(trip, active, customerId, { mayOverride = false, session } = {}) {
  if (active.customers !== "route" || mayOverride) return;
  const route = trip.routeId ? await VanRoute.findById(trip.routeId).select("customers").session(session || null).lean() : null;
  const onRoute = (route?.customers || []).some((c) => String(c.customerId) === String(customerId));
  const bad = vanRules.checkCustomer({ rules: active, onRoute, hasRoute: Boolean(route), mayOverride });
  if (bad) throw fail(bad.message, bad.status, bad.code);
}

const VAN_MODES = ["cash", "cheque", "card", "transfer"];
const text = (v) => String(v ?? "").trim();

/**
 * The details the shared receipt path (PaymentModeService.resolve) needs for each way of taking money, BUILT HERE and
 * never passed through from the request, so a phone cannot name a card machine, a cash account or any other field of
 * its own choosing:
 *   cash      the van's own cash account;
 *   cheque    the account it will be deposited to, number, date and the bank it is drawn on;
 *   card      the VAN's card machine (Van.cardId) and the approval code from its slip: a van with none takes no card;
 *   transfer  the bank account, the customer's reference and its date.
 * resolve keeps every field rule (REFERENCE_REQUIRED, APPROVAL_CODE_REQUIRED, DRAWN_ON_BANK_REQUIRED, BANK_ACCOUNT_REQUIRED).
 */
async function paymentDetailsFor(trip, mode, details = {}, session) {
  const d = details && typeof details === "object" ? details : {};
  if (mode === "cash") return { accountId: trip.cashAccountId };
  if (mode === "cheque") {
    return {
      accountId: d.accountId || undefined, chequeNo: text(d.chequeNo), chequeDate: d.chequeDate,
      ...(isId(d.drawnOnBankId) ? { drawnOnBankId: d.drawnOnBankId } : { drawnOnBankName: text(d.drawnOnBankName) }),
    };
  }
  if (mode === "card") {
    const van = await Van.findById(trip.vanId).select("cardId").session(session || null).lean();
    if (!van?.cardId) throw fail("This van has no card machine. Ask a supervisor to set one on the van, or take another way of payment.", 409, "VAN_NO_CARD_MACHINE");
    return { cardId: van.cardId, approvalCode: text(d.approvalCode) };
  }
  return { accountId: d.accountId || undefined, reference: text(d.reference), referenceDate: d.referenceDate || undefined };
}

/**
 * Take money against a customer on this trip: one receipt voucher - into the van's own cash account (cash), the cheque
 * register (cheque), the van's card machine's bank account less its fee (card), or the bank (transfer). A TRANSFER is
 * saved waiting for the office to see it in the bank: nobody can count it at the van, so it posts nothing and settles no
 * invoice until it is approved. Joins the caller's transaction. Allocated to the invoices named, else oldest first;
 * whatever is left stays on account.
 */
async function takeMoney(trip, { customerId, amount, mode = "cash", details = {}, invoiceIds, date, narration }, by, { req, session }) {
  const total = round2(amount);
  if (!(total > 0)) throw fail("Enter the amount received", 400, "AMOUNT_REQUIRED");
  if (!VAN_MODES.includes(mode)) throw fail("On the road, money is taken in cash, by cheque, by card or by bank transfer", 400, "VAN_MODE_NOT_SUPPORTED");
  const notAllowed = vanRules.checkMode(await VanSettingsService.forTrip(trip, { session }), mode);
  if (notAllowed) throw fail(notAllowed.message, notAllowed.status, notAllowed.code, notAllowed.details);
  const customer = await customerOf(customerId, session);

  const open = (await AgeingService.openInvoices({ type: "receivable", partyId: customerId, session }))
    .filter((r) => String(r.partyId) === String(customerId))
    .map((r) => ({ id: String(r.transactionId), number: r.transactionNo, outstanding: r.outstanding, date: r.date }));
  const wanted = Array.isArray(invoiceIds) && invoiceIds.length ? new Set(invoiceIds.map(String)) : null;
  const { allocations } = proposals.allocateOldestFirst(wanted ? open.filter((i) => wanted.has(i.id)) : open, total);

  const paymentDetails = await paymentDetailsFor(trip, mode, details, session);
  const voucher = await FinancialService.createVoucher(
    {
      voucherType: "receipt", customerId, customerName: customer.customerName, date: orgDay(date), totalAmount: total,
      paymentMode: mode, paymentDetails,
      linkedInvoices: allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount, balance: a.balance })),
      narration: narration || `Van ${trip.vanCode} ${trip.tripNo}`,
    },
    by, session, { req, ...(mode === "transfer" ? { holdFor: "van_transfer" } : {}) }
  );
  // the link to the trip is written after the voucher exists: a voucher body cannot carry it in
  await Voucher.updateOne({ _id: voucher._id }, { $set: { vanTripRef: { tripId: trip._id, tripNo: trip.tripNo } } }, { session });
  return Voucher.findById(voucher._id).session(session); // as stored now, with the trip link on it
}

/**
 * Why the goods came back, in the organisation's own wording, and an optional note. The screen asks every time; the
 * server insists only where no invoice stands behind the return (an older caller returning against an invoice, or a
 * phone syncing one, is not refused for not knowing about reasons).
 */
function reasonOf(active, input, { required }) {
  const given = input?.reason;
  if (given !== undefined && given !== null && given !== "" && typeof given !== "string") throw fail("Choose why the goods came back", 400, "RETURN_REASON_REQUIRED");
  const note = typeof input?.note === "string" ? input.note.trim().slice(0, 300) : "";
  if (!given) {
    if (required) throw fail("Choose why the goods came back", 400, "RETURN_REASON_REQUIRED");
    return { reason: null, note };
  }
  const reason = vanRules.matchReason(active, given);
  if (!reason) throw fail(`"${String(given).slice(0, 40)}" is not one of this business's reasons for a return`, 400, "RETURN_REASON_UNKNOWN", { reasons: active.returnReasons });
  return { reason, note };
}

/** Goods taken back with no invoice named: the organisation's switch, or a supervisor. */
function assertMayReturnLoose(active, opts) {
  if (active.returnsWithoutInvoice || opts.mayUnderprice) return;
  throw fail("Choose the invoice the goods are returned against. Taking goods back without one needs a supervisor.", 403, "VAN_RETURN_LINK_REQUIRED");
}

/**
 * The lines of a return with no invoice: goods only, each once, priced at what THIS customer pays today (their price
 * list, else the route's, else the item's own price) - not what is on the van, since what comes back may never have
 * been on it. The price is locked; a supervisor may type another. -> { items, record }
 */
async function looseLines(trip, customer, wanted, date, opts, session = null) {
  const ids = wanted.map((w) => w?.stockId);
  if (ids.some((i) => !isId(i))) throw fail("An item being returned is not valid", 400, "ITEM_INVALID");
  if (new Set(ids.map(String)).size !== ids.length) throw fail("Each item is listed once; add up its quantity on one line", 400, "ITEM_REPEATED");
  const stocks = await Stock.find({ _id: { $in: ids } }).select("itemId itemName itemType salesPrice status").session(session).lean();
  const byId = new Map(stocks.map((s) => [String(s._id), s]));
  const listed = await PriceListService.pricesFor({
    customerId: customer._id, routeId: trip.routeId, date, session,
    items: wanted.map((w) => ({ stockId: w.stockId, qty: Number(w.qty) || 1, itemPrice: Number(byId.get(String(w.stockId))?.salesPrice) || 0 })),
  });
  const items = [];
  const record = [];
  for (const [i, w] of wanted.entries()) {
    const s = byId.get(String(w.stockId));
    if (!s || s.status === "Inactive") throw fail(`Line ${i + 1}: that item does not exist`, 404, "ITEM_NOT_FOUND");
    if (kinds.isService(s)) throw fail(`${s.itemName} is a service. Only stocked goods come back to a van.`, 400, "VAN_GOODS_ONLY");
    const qty = typeof w.qty === "number" || typeof w.qty === "string" ? Number(w.qty) : NaN;
    if (!(qty > 0)) throw fail(`Line ${i + 1}: enter a quantity above zero`, 400, "QTY_INVALID");
    const list = Number(listed.get(String(s._id))?.price) || 0;
    const typed = w.price !== undefined && w.price !== null && w.price !== "";
    if (typed && !opts.mayUnderprice) throw fail(`${s.itemName} comes back at ${list.toFixed(2)}, this customer's price. Only a supervisor can change it.`, 403, "PRICE_LOCKED", { stockId: String(s._id), listPrice: list });
    const price = typed ? Number(w.price) : list;
    if (!(price >= 0) || !Number.isFinite(price)) throw fail(`Line ${i + 1}: enter a price of zero or more`, 400, "PRICE_INVALID");
    if (!typed && !(price > 0)) throw fail(`${s.itemName} has no price for this customer, so it cannot be credited. A supervisor can enter one.`, 400, "RETURN_NO_PRICE", { stockId: String(s._id) });
    items.push({ itemId: s._id, itemCode: s.itemId, description: s.itemName, qty, price, discountPercent: 0 });
    record.push({ stockId: s._id, qty, condition: w.condition === "damaged" ? "damaged" : "good" });
  }
  return { items, record };
}

/**
 * The containers of a sale (services/vansales/vanContainerService.js): what the salesman counted, else what the goods
 * sold take; written with the invoice, the deposit as its own note (a refund set against the invoice where it fits).
 * Nothing at all where the organisation has no container types and none were sent.
 */
async function containersOfSale({ trip, customer, input, items, approved, by, opts, session }) {
  const VanContainerService = require("./vanContainerService");
  const crates = require("../../utils/vanContainers");
  const none = { deposit: 0, voucher: null, summary: [] };
  const sent = input?.containers !== undefined && input?.containers !== null;
  const types = await VanContainerService.types({ session });
  if (!types.length && !sent) return none;
  let moves;
  try {
    moves = sent ? crates.cleanMoves(input.containers) : [...crates.givenFor(items.map((l) => ({ stockId: l.itemId, qty: l.qty })), types)].map(([typeId, given]) => ({ typeId, given, collected: 0 }));
  } catch (err) {
    if (err instanceof crates.ContainerError) throw fail(err.message, 400, err.code, err.details);
    throw err;
  }
  if (!moves.length) return none;
  const r = await VanContainerService.record({ trip, customerId: customer._id, moves, kind: "sale", transactionId: approved._id, transactionNo: approved.transactionNo, settleInvoiceId: approved._id, by, byName: opts.byName, mayOverride: opts.mayUnderprice, session });
  const names = new Map(types.map((t) => [t.id, t.name]));
  return { deposit: r.deposit, voucher: r.voucher, summary: moves.map((m) => ({ ...m, name: names.get(m.typeId) || "" })) };
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
    const active = await VanSettingsService.forTrip(trip, { session }); // this van's rules, read live
    await assertCustomerAllowed(trip, active, customer._id, { mayOverride: opts.mayUnderprice, session });
    // what must be taken at the door is known before anything is priced; the amount is checked again once it is
    const cashCustomer = vanRules.isCashTerms(customer.paymentTerms);
    const unpaid = vanRules.checkPayment({ rules: active, payNow: input?.payNow, cashCustomer });
    if (unpaid) throw fail(unpaid.message, unpaid.status, unpaid.code, unpaid.details);
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
      // selling under the customer's list, or with a discount of his own, is a concession the business has not agreed:
      // the organisation's price rules say how far a salesman may go, and a supervisor (manage) is never held to them
      const typedDiscount = Number(l.discountPercent) || 0;
      if (typedDiscount < 0 || typedDiscount > 100) throw fail(`Line ${i + 1}: a discount is between 0 and 100 percent`, 400, "DISCOUNT_INVALID");
      const held = vanRules.checkLine({ name: s.itemName, price, list: list.price, typedPrice: typed, discountPercent: typedDiscount, listName: list.listName, rules: active, mayOverride: opts.mayUnderprice });
      if (held) throw fail(held.message, held.status, held.code, { stockId: String(s._id), ...(held.details || {}) });
      return {
        itemId: s._id, itemCode: s.itemId, description: s.itemName, qty,
        price,
        discountPercent: typedDiscount,
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
      const asked = preorder.status === "DRAFT" && preorder.source?.kind === "customer_link"; // the customer's own request
      if (preorder.status !== "CONFIRMED" && !asked) throw fail(`${preorder.orderNo} is ${String(preorder.status).toLowerCase()}, so it has nothing left to deliver`, 409, "PREORDER_NOT_OPEN");
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

    // containers that went out with the goods and came back empty, and the deposit they are worth (its own note): only
    // where the organisation set containers up. With no count sent, what the goods sold take is given and nothing collected.
    const containers = await containersOfSale({ trip, customer, input, items, approved, by, opts, session });
    // what is owed now: the invoice (less a deposit refund already set against it) and a deposit charged
    const owed = round2((await Transaction.findById(approved._id).select("outstandingAmount").session(session).lean()).outstandingAmount + Math.max(0, containers.deposit));

    let receipt = null;
    const pay = input.payNow;
    if (pay && (pay.full === true || Number(pay.amount) > 0)) {
      const amount = pay.full === true ? owed : round2(pay.amount);
      if (amount > owed + 0.005) throw fail("The money taken is more than the invoice. Take the rest as a separate receipt.", 400, "PAYMENT_EXCEEDS_INVOICE");
      const short = vanRules.checkPayment({ rules: active, payNow: pay, cashCustomer, total: owed });
      if (short) throw fail(short.message, short.status, short.code, short.details);
      receipt = await takeMoney(trip, { customerId: customer._id, amount, mode: pay.mode || "cash", details: pay.details, invoiceIds: [String(approved._id)], date: day }, by, { req: opts.req, session });
    }
    await require("./vanFleetService").ping(trip, { kind: "sale", customerId: customer._id, ref: approved.transactionNo, location: input.location }, { session });
    if (preorder) {
      preorder.status = "CLOSED";
      preorder.closedAt = new Date();
      preorder.closeReason = `Delivered by van ${trip.vanCode} on ${trip.tripNo} (${approved.transactionNo})`;
      await preorder.save({ session });
    }
    return { invoice: approved, receipt, promotions: promo.applied, preorder: preorder ? preorder.orderNo : null, containers: containers.summary, deposit: containers.deposit, depositNote: containers.voucher ? containers.voucher.voucherNo : null };
  });

  /** Take money from a customer (cash or a cheque): against named invoices, else the oldest first. */
  static collect = withTransactionSession(async (id, input, by, ...rest) => {
    const session = rest[rest.length - 1];
    const opts = rest.length > 1 ? rest[0] || {} : {};
    const trip = await loadTrip(id, session);
    assertSelling(trip);
    const voucher = await takeMoney(trip, input || {}, by, { req: opts.req, session });
    await require("./vanFleetService").ping(trip, { kind: "collect", customerId: input?.customerId, ref: voucher.voucherNo, location: input?.location }, { session });
    return { receipt: voucher };
  });

  /**
   * Take goods back from a customer. Against one of their approved invoices (the invoice's prices), or - where the
   * organisation allows it, or for a supervisor - with no invoice at all, at the customer's own list price and up to the
   * organisation's limit. Each line says whether it came back sellable (it goes back on the van) or damaged (it does
   * not). The return is approved at once, like a sale, and carries the reason it came back.
   */
  static returnGoods = withTransactionSession(async (id, input, by, ...rest) => {
    const session = rest[rest.length - 1];
    const opts = rest.length > 1 ? rest[0] || {} : {};
    const trip = await loadTrip(id, session);
    assertSelling(trip);
    const active = await VanSettingsService.forTrip(trip, { session });
    if (!active.returnsAllowed) throw fail("This business does not take goods back on the van. Bring them to the depot.", 403, "VAN_RETURNS_OFF");
    const customer = await customerOf(input?.customerId, session);
    await assertCustomerAllowed(trip, active, customer._id, { mayOverride: opts.mayUnderprice, session });
    const withoutInvoice = input?.returnOfId === undefined || input?.returnOfId === null || input?.returnOfId === "";
    if (withoutInvoice) assertMayReturnLoose(active, opts);
    const { reason, note } = reasonOf(active, input, { required: withoutInvoice });
    const wanted = Array.isArray(input?.lines) ? input.lines : [];

    let original = null;
    let items = [];
    let record = [];
    if (withoutInvoice) {
      if (!wanted.length) throw fail("Add at least one item being returned", 400, "ITEMS_REQUIRED");
      ({ items, record } = await looseLines(trip, customer, wanted, input.date, opts, session));
    } else {
      if (!isId(input.returnOfId)) throw fail("That invoice does not exist", 404, "ORIGINAL_NOT_FOUND");
      original = await Transaction.findById(input.returnOfId).session(session);
      if (!original || original.type !== "sales_order") throw fail("That invoice does not exist", 404, "ORIGINAL_NOT_FOUND");
      if (!wanted.length) throw fail("Add at least one item being returned", 400, "ITEMS_REQUIRED");
      for (const [i, w] of wanted.entries()) {
        const qty = Number(w?.qty);
        if (!(qty > 0)) throw fail(`Line ${i + 1}: enter a quantity above zero`, 400, "QTY_INVALID");
        const line = original.items.find((l) => String(l._id) === String(w.lineId)) || original.items.find((l) => String(l.itemId) === String(w.itemId));
        if (!line) throw fail(`Line ${i + 1} is not on ${original.transactionNo}`, 400, "LINE_NOT_IN_ORIGINAL");
        if (kinds.isService(line)) throw fail("A service cannot be returned to a van", 400, "VAN_GOODS_ONLY");
        items.push({ ...S.toPricingInput(line, qty, line.qty), returnOfLineId: line._id });
        record.push({ stockId: line.itemId, qty, condition: w.condition === "damaged" ? "damaged" : "good" });
      }
    }

    const day = orgDay(input.date);
    const said = [reason, note].filter(Boolean).join(". ");
    const ret = await TransactionService.createTransaction(
      {
        type: "sales_return", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", date: day, items,
        ...(original ? { returnOf: { transactionId: original._id } } : {}), status: "DRAFT", vanTripRef: refOf(trip),
        notes: input.notes ? String(input.notes).slice(0, 500) : `Returned on van ${trip.vanCode} ${trip.tripNo}${said ? `: ${said}` : ""}`,
      },
      by, session
    );
    // a return with no invoice behind it is a credit nobody has checked: past the organisation's limit it is a
    // supervisor's. Judged on the priced total (tax included); refusing here rolls the draft back with everything else.
    if (withoutInvoice && !opts.mayUnderprice && round2(ret.totalAmount) > Number(active.maxReturnWithoutInvoice) + 0.005) {
      throw fail(`This return comes to ${round2(ret.totalAmount).toFixed(2)}. Without an invoice a salesman may take back up to ${Number(active.maxReturnWithoutInvoice).toFixed(2)}; a supervisor must do this one.`, 403, "VAN_RETURN_OVER_LIMIT", { amount: round2(ret.totalAmount), limit: Number(active.maxReturnWithoutInvoice) });
    }
    await TransactionService.processTransaction(ret._id, "approve", by, { req: opts.req }, session);
    const approved = await Transaction.findById(ret._id).session(session);
    if (approved.status !== "APPROVED") throw fail("This return needs a second approval, so it cannot be taken on the van", 409, "VAN_SALE_NEEDS_APPROVAL");
    trip.returns.push({
      transactionId: approved._id, no: approved.transactionNo, at: new Date(), lines: record,
      ...(reason ? { reason } : {}), ...(note ? { note } : {}), withoutInvoice, amount: round2(approved.totalAmount),
    });
    trip.updatedBy = String(by);
    await trip.save({ session });
    return { creditNote: approved };
  });

  /**
   * What goods taken back with no invoice would be credited at, before anything is saved: the same lines and the same
   * pricing as the return itself, so the screen cannot promise a figure the return then differs from.
   */
  static async returnQuote(id, input, opts = {}) {
    const trip = await loadTrip(id);
    assertSelling(trip);
    const active = await VanSettingsService.forTrip(trip);
    if (!active.returnsAllowed) throw fail("This business does not take goods back on the van. Bring them to the depot.", 403, "VAN_RETURNS_OFF");
    assertMayReturnLoose(active, opts);
    const customer = await customerOf(input?.customerId);
    await assertCustomerAllowed(trip, active, customer._id, { mayOverride: opts.mayUnderprice });
    const wanted = Array.isArray(input?.lines) ? input.lines : [];
    if (!wanted.length) throw fail("Add at least one item being returned", 400, "ITEMS_REQUIRED");
    const day = orgDay(input.date);
    const { items } = await looseLines(trip, customer, wanted, day, opts);
    const priced = await TransactionService.buildPricing({ items, date: day, side: "sales" });
    const total = round2(priced.totalAmount);
    const limit = Number(active.maxReturnWithoutInvoice);
    return {
      lines: priced.processedItems.map((l) => ({ stockId: String(l.itemId), description: l.description, qty: l.qty, price: l.price, vatAmount: round2(l.vatAmount), lineTotal: round2(l.lineTotal) })),
      total, limit, overLimit: !opts.mayUnderprice && total > limit + 0.005,
    };
  }

  /** The route rule for a door that does not sell itself (a pre-order): refuses a customer this van may not serve. */
  static async assertCustomerAllowed(tripId, customerId, { mayOverride = false } = {}) {
    const trip = await loadTrip(tripId);
    await assertCustomerAllowed(trip, await VanSettingsService.forTrip(trip), customerId, { mayOverride });
  }

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
   * What the salesman should know at this customer's door: the last order, what they usually buy, what they used to
   * buy and have stopped, and what they owe - all from their own approved invoices, all cut to what is on the van now.
   * Read-only; nothing is stored. The salesman sees it only for a trip they may work (the controller checks).
   */
  static async insight(tripId, customerId) {
    const trip = await loadTrip(tripId);
    if (!isId(customerId)) throw fail("Choose a customer", 400, "CUSTOMER_REQUIRED");
    const stock = await stockOf(trip);
    const onVan = new Map([...stock.sellable].map(([k, v]) => [String(k), Number(v) || 0]));
    return { ...(await this.history(customerId, onVan)), position: await this.customerPosition(customerId) };
  }

  /** The history half of the insight (no money owed): the last order, usual items and what they stopped buying, cut to `onVan` (a Map). */
  static async history(customerId, onVan) {
    const docs = await Transaction.find({ partyId: customerId, type: "sales_order", status: "APPROVED", isOpening: { $ne: true } })
      .sort({ date: -1, _id: -1 }).limit(12).select("transactionNo date items.itemId items.qty items.itemType").lean();
    // goods sent back come off the invoice they were returned against: a customer who returned an item did not "buy" it
    const back = docs.length
      ? await Transaction.find({ type: "sales_return", status: "APPROVED", "returnOf.transactionId": { $in: docs.map((d) => d._id) } }).select("returnOf.transactionId items.itemId items.qty").lean()
      : [];
    const returned = new Map();
    for (const r of back) for (const l of r.items || []) { const k = `${r.returnOf.transactionId}:${l.itemId}`; returned.set(k, (returned.get(k) || 0) + (Number(l.qty) || 0)); }
    const ids = new Set();
    for (const d of docs) for (const l of d.items || []) if (l.itemId && l.itemType !== "service") ids.add(String(l.itemId));
    const names = new Map((await Stock.find({ _id: { $in: [...ids] } }).select("itemName").lean()).map((x) => [String(x._id), x.itemName]));
    const invoices = docs.map((d) => ({
      number: d.transactionNo, date: d.date,
      lines: (d.items || []).filter((l) => l.itemType !== "service").map((l) => ({ stockId: String(l.itemId), name: names.get(String(l.itemId)) || "", qty: Number(l.qty) - (returned.get(`${d._id}:${l.itemId}`) || 0) })).filter((l) => l.qty > 0),
    }));
    return rules.customerInsight({ invoices, onVan });
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
    const customers = await Customer.find({ _id: { $in: ids } }).select("customerName customerId phone trnNumber vat.trn status paymentTerms").lean();
    const stock = await stockOf(trip);
    const items = await Stock.find({ _id: { $in: [...stock.sellable.keys()] } }).select("salesPrice category").lean();
    const prices = {};
    for (const c of customers) {
      const map = await PriceListService.pricesFor({ customerId: c._id, routeId: trip.routeId, items: items.map((s) => ({ stockId: s._id, qty: 1, itemPrice: Number(s.salesPrice) || 0 })) });
      prices[String(c._id)] = Object.fromEntries([...map].map(([k, p]) => [k, p.price]));
    }
    // what each of the route's customers usually buys, for the Sell dialog with no signal (as of the time the pack was read)
    const held = new Map([...stock.sellable].map(([k, v]) => [String(k), Number(v) || 0]));
    const insight = {};
    for (const c of customers.slice(0, 60)) insight[String(c._id)] = await this.history(c._id, held);
    const used = new Set((await Transaction.find({ transactionNo: { $in: trip.numberBlock || [] } }).select("transactionNo").lean()).map((t) => t.transactionNo));
    return {
      at: new Date().toISOString(),
      trip: shown,
      customers: customers.filter((c) => c.status !== "Inactive").map((c) => ({ id: String(c._id), name: c.customerName, code: c.customerId || "", phone: c.phone || "", trn: c.vat?.trn || c.trnNumber || "", terms: c.paymentTerms || "" })),
      prices,
      insight,
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
    // the containers they hold (crates, bottles), only where the organisation has container types
    const containers = (await require("./vanContainerService").balances(customerId)).filter((c) => c.holds !== 0);
    return { owed, open, containers };
  }

  /** The lines of an invoice that can still be returned (feeds the return form). */
  static async returnable(originalId) {
    return ReturnService.returnable(originalId);
  }
}

module.exports = VanTripSales;
