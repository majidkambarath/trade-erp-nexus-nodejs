// A document priced in a foreign currency, converted to the base currency. Pure, no database.
//
// The rule that keeps this feature small: EVERYTHING stored on a Transaction stays in the base currency, so the ledger, the VAT return, ageing, credit
// control and every report read it exactly as before. A foreign-currency document additionally keeps its foreign figures beside the base ones
// (`fx` on the document and on each line), which is what the customer sees and what they owe.
//
// The document is priced in the foreign currency first (the engine is currency-blind: percentages and rounding to the minor unit). Then each
// money figure is converted ONCE at the document's rate, half-up to the base cent (utils/fx.js convertToBase), and the relationships between
// figures are derived rather than converted, so a line always adds up in base:
//     discount = gross - taxable        lineTotal = taxable + tax
// Converting a total and its parts separately would leave cents that belong to no line; deriving them leaves none.
const { convertToBase } = require("./fx");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (n) => Number(n) || 0;

// 3-decimal currencies (KWD, BHD, OMR) are not supported on a document: the engine rounds money to two places (see utils/currencyCatalog.js)
const MAX_DOCUMENT_DECIMALS = 2;

const toBase = (v, rate, decimals) => (num(v) > 0 ? convertToBase(num(v), rate, { decimals }) : 0);

/**
 * lines: priced lines in the foreign currency (TransactionService.calculateItems output, after the header discount was shared out)
 * -> the same lines with every money field in base, and the foreign figures kept in `fx`.
 */
function convertLinesToBase(lines, rate, decimals = 2) {
  return lines.map((l) => {
    const gross = toBase(l.grossAmount, rate, decimals);
    const taxable = toBase(l.taxableAmount, rate, decimals);
    const vat = toBase(l.vatAmount, rate, decimals);
    const rcmVat = l.rcmVat !== undefined ? toBase(l.rcmVat, rate, decimals) : undefined;
    const discount = round2(Math.max(0, gross - taxable));
    const total = round2(taxable + vat);
    const out = {
      ...l,
      price: l.price !== undefined ? Math.round(num(l.price) * rate * 1e4) / 1e4 : l.price, // a unit price keeps four places: 0.0035 USD is a real price
      grossAmount: gross,
      taxableAmount: taxable,
      vatAmount: vat,
      discountAmount: discount,
      lineTotal: total,
      fx: {
        price: l.price, grossAmount: l.grossAmount, discountAmount: l.discountAmount, taxableAmount: l.taxableAmount,
        vatAmount: l.vatAmount, lineTotal: l.lineTotal, ...(l.rcmVat !== undefined ? { rcmVat: l.rcmVat } : {}),
      },
    };
    if (l.grandTotal !== undefined) out.grandTotal = total;
    if (l.rate !== undefined && num(l.rate) === num(l.taxableAmount)) out.rate = taxable; // `rate` is the line's value, VAT-exclusive, after its discount
    if (rcmVat !== undefined) out.rcmVat = rcmVat;
    if (num(l.headerDiscountNet) > 0) out.headerDiscountNet = Math.min(toBase(l.headerDiscountNet, rate, decimals), discount);
    return out;
  });
}

// Header charges (freight and the like): the net and its tax, each converted once.
function convertChargesToBase(charges, rate, decimals = 2) {
  return charges.map((c) => ({
    ...c,
    amount: toBase(c.amount, rate, decimals),
    vatAmount: toBase(c.vatAmount, rate, decimals),
    fx: { amount: c.amount, vatAmount: c.vatAmount },
  }));
}

/**
 * A priced foreign document's header figures (utils/pricing.js priceDocument output), kept as the foreign view.
 * `total` is what the customer owes, in the document's own currency.
 */
function foreignView(pricing) {
  return {
    gross: pricing.gross, lineDiscount: pricing.lineDiscount, net: pricing.net, lineVat: pricing.lineVat, rcmVat: pricing.rcmVat,
    chargesNet: pricing.chargesNet, chargesVat: pricing.chargesVat, headerDiscount: pricing.headerDiscount,
    ...(pricing.headerDiscountSpread !== undefined ? { headerDiscountSpread: pricing.headerDiscountSpread } : {}),
    roundOff: pricing.roundOff, grandTotal: pricing.grandTotal,
  };
}

/**
 * How much of an invoice's base carrying value a foreign settlement clears. `outstandingBase` is what the ledger still carries for the invoice and
 * `outstandingForeign` what the customer still owes in its currency. Settling all of it clears all of the base (so nothing is ever left over from
 * rounding); settling part clears the same share of the base, to the cent.
 */
function carryingFor(settledForeign, outstandingForeign, outstandingBase) {
  const s = num(settledForeign);
  const f = num(outstandingForeign);
  const b = round2(outstandingBase);
  if (!(s > 0) || !(f > 0)) return 0;
  if (s >= f - 1e-9) return b;
  return round2((b * s) / f);
}

/**
 * The exchange difference of a settlement: what the money was worth when it moved, less what the ledger carried for the invoice it settled.
 * For a RECEIPT a positive difference is a gain (more base money than was owed); for a PAYMENT it is a loss (more base money paid than was carried).
 */
const exchangeDifference = (settledBase, carryingBase) => round2(num(settledBase) - num(carryingBase));

module.exports = { MAX_DOCUMENT_DECIMALS, convertLinesToBase, convertChargesToBase, foreignView, carryingFor, exchangeDifference };
