// Document pricing. Pure functions; every figure is computed on the server.
//
// Rule: round each money column to the amount precision, THEN sum. Never sum raw values and
// round once, or the total will not equal the sum of the columns the user sees.
//
//   gross     = qty x unit price
//   discount  = a fixed amount, or a percentage of gross
//   taxable   = gross - discount          (a trade discount REDUCES the taxable base)
//   vat       = taxable x vat% / 100
//   lineTotal = taxable + vat             (VAT-inclusive)
//
// REVERSE CHARGE (line.taxKind === "reverse_charge"): the supplier charged no VAT, so the line carries
// vat = 0 and lineTotal = taxable (what the party is owed is the net). The recipient self-assesses:
//   rcmVat = taxable x rate / 100         (the rate is the tax code's, 5 when none is given)
// which is a separate figure, never part of the line total or of the party's balance. It is posted by the
// purchase templates (utils/postingTemplates.js) and reported in boxes 3 and 10 of the VAT 201 return.

const roundTo = (n, dp = 2) => {
  const f = 10 ** dp;
  const v = Number(n) || 0;
  return Math.sign(v) * (Math.round(Math.abs(v) * f + 1e-9) / f);
};

// The self-assessment rate when a reverse-charge line names none (a code's rate is always given: this is the safety net).
const DEFAULT_RCM_PERCENT = 5;
const REVERSE_CHARGE = "reverse_charge";

function priceLine(line, { dp = 2 } = {}) {
  const qty = Number(line.qty) || 0;
  const unit = Number(line.price ?? line.rate ?? 0) || 0;
  const gross = roundTo(qty * unit, dp);

  const fixed = Number(line.discountAmount) || 0;
  const pct = Number(line.discountPercent) || 0;
  // A discount can never exceed the line it applies to.
  const discount = Math.min(gross, fixed > 0 ? roundTo(fixed, dp) : roundTo((gross * pct) / 100, dp));

  const taxable = roundTo(gross - discount, dp);

  if (line.taxKind === REVERSE_CHARGE) {
    // An explicit 0 stays 0 (a zero-rated service bought from abroad is still declared, with nil VAT); only a missing rate gets the default.
    const given = line.vatPercent === undefined || line.vatPercent === null || line.vatPercent === "" ? NaN : Number(line.vatPercent);
    const vatPercent = Number.isFinite(given) && given >= 0 ? given : DEFAULT_RCM_PERCENT;
    return {
      gross, discount, taxable, vatPercent, vat: 0, lineTotal: taxable,
      reverseCharge: true, rcmVat: roundTo((taxable * vatPercent) / 100, dp),
    };
  }

  const vatPercent = Number(line.vatPercent) || 0;
  const vat = roundTo((taxable * vatPercent) / 100, dp);
  return { gross, discount, taxable, vatPercent, vat, lineTotal: roundTo(taxable + vat, dp) };
}

// A header charge (freight, handling, ...): its own tax, posted to its own account.
function priceCharge(charge, { dp = 2 } = {}) {
  const net = roundTo(charge.amount, dp);
  const vatPercent = Number(charge.vatPercent) || 0;
  const vat = roundTo((net * vatPercent) / 100, dp);
  return { net, vatPercent, vat, total: roundTo(net + vat, dp) };
}

// Header totals from priced lines and charges.
//   headerDiscount: an amount taken off the VAT-inclusive total (e.g. a settlement discount).
//   incomingTotal:  what the client says the total is. If it differs from the computed total by
//                   no more than roundOffLimit, the difference is kept as an explicit round-off;
//                   anything larger is a client error and the computed total wins. (This is what
//                   stops a return form posting a total of 0.)
function priceDocument(
  lines,
  charges = [],
  { headerDiscount = 0, incomingTotal, roundOffLimit = 1, dp = 2 } = {}
) {
  const sum = (arr, k) => roundTo(arr.reduce((t, x) => t + (Number(x[k]) || 0), 0), dp);
  const gross = sum(lines, "gross");
  const lineDiscount = sum(lines, "discount");
  const net = sum(lines, "taxable");
  const lineVat = sum(lines, "vat");
  // VAT the recipient assesses on reverse-charge lines: reported beside the document, never inside its total
  const rcmVat = sum(lines, "rcmVat");
  const chargesNet = sum(charges, "net");
  const chargesVat = sum(charges, "vat");
  const hd = roundTo(Math.min(Number(headerDiscount) || 0, net + lineVat + chargesNet + chargesVat), dp);

  const computed = roundTo(net + lineVat + chargesNet + chargesVat - hd, dp);
  let roundOff = 0;
  if (incomingTotal !== undefined && incomingTotal !== null && Number.isFinite(Number(incomingTotal))) {
    const diff = roundTo(Number(incomingTotal) - computed, dp);
    if (diff !== 0 && Math.abs(diff) <= roundOffLimit) roundOff = diff;
  }
  return {
    gross,
    lineDiscount,
    net,
    lineVat,
    rcmVat,
    chargesNet,
    chargesVat,
    headerDiscount: hd,
    roundOff,
    grandTotal: roundTo(computed + roundOff, dp),
  };
}

module.exports = { roundTo, priceLine, priceCharge, priceDocument, DEFAULT_RCM_PERCENT, REVERSE_CHARGE };
