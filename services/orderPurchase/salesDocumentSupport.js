const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const Stock = require("../../models/modules/stockModel");
const Customer = require("../../models/modules/customerModel");
const TransactionService = require("./transactionService");
const { roundTo } = require("../../utils/pricing");
const { toExpiryDay } = require("../../utils/documentExpiry");
const kinds = require("../../utils/itemKinds");

// What a quotation and a delivery note have in common: checking the customer and the lines, pricing
// the document with the same code that prices the invoice it can become, and attaching the stock
// details a printed copy needs.

const num = (v) => Number(v);
const isId = (v) => mongoose.isValidObjectId(v);

const CUSTOMER_FIELDS =
  "customerId customerName contactPerson email phone billingAddress shippingAddress trnNumber vat paymentTerms minShelfLifeDays status";

async function loadCustomer(partyId, { session } = {}) {
  if (!isId(partyId)) throw new AppError("Choose a customer", 400, "CUSTOMER_REQUIRED");
  const q = Customer.findById(partyId).select(CUSTOMER_FIELDS).lean();
  const customer = await (session ? q.session(session) : q);
  if (!customer) throw new AppError("Customer not found", 404, "CUSTOMER_NOT_FOUND");
  return customer;
}

// A calendar day as the Date a form field means: "2026-10-31" -> that day at UTC midnight, which is
// how every date field in the app is stored. Returns null for anything that is not a day.
function dayToDate(value) {
  const day = toExpiryDay(value);
  return day ? new Date(day) : null;
}

// The lines as pricing inputs, after checking each against the stock master.
//   - qty must be above zero; price may be zero (a free sample is a legitimate line)
//   - a line that names an item the master does not know is refused, not stored with a dangling id
//   - `price` is the UNIT price. (Transaction lines also carry `rate`, the line VALUE; it is never read.)
async function prepareLines(items, { session, allowEmpty = false } = {}) {
  if (!Array.isArray(items) || (!items.length && !allowEmpty)) {
    throw new AppError("Add at least one item", 400, "ITEMS_REQUIRED");
  }
  const ids = items.map((i) => i?.itemId);
  const bad = ids.findIndex((id) => !isId(id));
  if (bad !== -1) throw new AppError(`Line ${bad + 1}: choose an item`, 400, "ITEM_REQUIRED");

  const q = Stock.find({ _id: { $in: ids } }).select("itemId itemName").lean();
  const found = new Map((await (session ? q.session(session) : q)).map((s) => [String(s._id), s]));

  return items.map((line, index) => {
    const n = index + 1;
    const stock = found.get(String(line.itemId));
    if (!stock) throw new AppError(`Line ${n}: that item no longer exists`, 400, "ITEM_NOT_FOUND");
    const qty = num(line.qty);
    if (!(qty > 0)) throw new AppError(`Line ${n}: quantity must be above zero`, 400, "INVALID_QUANTITY");
    const price = line.price === undefined || line.price === "" ? 0 : num(line.price);
    if (!(price >= 0)) throw new AppError(`Line ${n}: price cannot be negative`, 400, "INVALID_PRICE");
    const discountPercent = num(line.discountPercent) || 0;
    if (discountPercent < 0 || discountPercent > 100) throw new AppError(`Line ${n}: discount is 0 to 100%`, 400, "INVALID_DISCOUNT");
    const discountAmount = num(line.discountAmount) || 0;
    if (discountAmount < 0) throw new AppError(`Line ${n}: discount cannot be negative`, 400, "INVALID_DISCOUNT");
    const vatPercent = num(line.vatPercent) || 0;
    if (vatPercent < 0) throw new AppError(`Line ${n}: VAT cannot be negative`, 400, "INVALID_VAT");
    return {
      itemId: line.itemId,
      itemCode: line.itemCode || stock.itemId || "",
      description: String(line.description || stock.itemName || "").trim() || stock.itemName,
      qty,
      price,
      discountPercent,
      discountAmount,
      taxCodeId: line.taxCodeId || undefined,
      vatPercent,
      // carried through the pricing untouched (a delivery note keeps which order line it serves)
      ...(line.sourceLineId ? { sourceLineId: line.sourceLineId } : {}),
    };
  });
}

// Prices a document exactly as an invoice is priced (transactionService.buildPricing: tax codes at
// the document date, per-line rounding, header charges, header discount) and returns it in the shape
// the models store. No client total is accepted, so there is no round-off.
async function priceDocument({ items, charges, discount, date }, { session } = {}) {
  const prepared = await prepareLines(items, { session });
  const built = await TransactionService.buildPricing(
    { items: prepared, charges: charges || [], discount: num(discount) || 0, incomingTotal: undefined, date: date || new Date() },
    session
  );
  return {
    lines: built.processedItems.map(storedLine),
    charges: built.charges,
    pricing: built.pricing,
    totalAmount: built.totalAmount,
  };
}

// The priced line, trimmed to what the models keep (the pricing helper hands back everything it was given).
function storedLine(i) {
  return {
    itemId: i.itemId,
    itemCode: i.itemCode,
    itemType: i.itemType, // stamped by buildPricing from the item master; absent = goods
    description: i.description,
    qty: i.qty,
    price: i.price,
    discountPercent: i.discountPercent || 0,
    discountAmount: i.discountAmount || 0,
    grossAmount: i.grossAmount,
    taxableAmount: i.taxableAmount,
    taxCodeId: i.taxCodeId || null,
    taxKind: i.taxKind || null,
    vatPercent: i.vatPercent || 0,
    vatAmount: i.vatAmount,
    ...(i.rcmVat != null ? { rcmVat: i.rcmVat } : {}), // a reverse-charge line: the VAT the recipient assesses (absent on every other line)
    lineTotal: i.lineTotal,
    ...(i.sourceLineId ? { sourceLineId: i.sourceLineId } : {}),
  };
}

// A stored line as an input to the pricing again, at a different quantity (a part delivery) or the
// same one (an offer becoming an order). A percentage discount scales with the quantity by itself; a
// fixed amount is prorated, so delivering half the goods takes half the discount.
// `basisQty` is the quantity the stored discountAmount was worked out for: the line's own qty, except
// on a delivery note after delivery, where the amounts were repriced for the quantity accepted.
function toPricingInput(line, qty = line.qty, basisQty = line.qty) {
  const pct = Number(line.discountPercent) || 0;
  const original = Number(basisQty) || 0;
  const fixed = pct > 0 || !original ? 0 : roundTo(((Number(line.discountAmount) || 0) * qty) / original);
  return {
    itemId: line.itemId,
    itemCode: line.itemCode,
    description: line.description,
    qty,
    price: line.price,
    discountPercent: pct,
    discountAmount: fixed,
    taxCodeId: line.taxCodeId || undefined,
    vatPercent: line.vatPercent,
  };
}

// Item code, name, unit and barcode for each line, for a printed copy. One query for the whole document.
async function attachStockDetails(lines) {
  const ids = [...new Set(lines.map((l) => String(l.itemId?._id || l.itemId)))].filter(isId);
  if (!ids.length) return lines.map((l) => ({ ...l, stockDetails: null }));
  const stocks = await Stock.find({ _id: { $in: ids } })
    .select("itemId itemName itemType barcodeQrCode brand origin currentStock unitOfMeasure")
    .populate("unitOfMeasure", "unitName shortCode")
    .lean();
  const byId = new Map(stocks.map((s) => [String(s._id), s]));
  return lines.map((l) => {
    const s = byId.get(String(l.itemId?._id || l.itemId));
    return {
      ...l,
      itemId: String(l.itemId?._id || l.itemId),
      stockDetails: s
        ? {
            itemId: s.itemId, itemName: s.itemName, itemType: kinds.itemTypeOf(s), barcode: s.barcodeQrCode || "", brand: s.brand || "", origin: s.origin || "",
            // a service has no quantity on hand: null, so a screen shows a dash rather than "0 in stock"
            currentStock: kinds.isService(s) ? null : s.currentStock ?? 0,
            unit: s.unitOfMeasure?.shortCode || s.unitOfMeasure?.unitName || "",
          }
        : null,
    };
  });
}

// "(?i)text" safe for use inside a $regex: user input is never a pattern.
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function pageOf(filters, { defaultLimit = 20 } = {}) {
  const page = Math.max(1, parseInt(filters.page) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(filters.limit) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

module.exports = {
  CUSTOMER_FIELDS, loadCustomer, dayToDate, prepareLines, priceDocument, storedLine, toPricingInput,
  attachStockDetails, escapeRegex, pageOf, isId,
};
