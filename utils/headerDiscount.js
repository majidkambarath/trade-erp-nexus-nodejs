// A discount on the whole invoice, spread over its lines. Pure, no database.
//
// A discount given at the time of supply reduces the price the customer pays, so it reduces the TAXABLE amount and therefore the tax (UAE VAT law,
// Executive Regulation; India CGST s.15). Before this the header discount was taken off the VAT-inclusive TOTAL after the tax had been worked
// out, so the invoice charged VAT on a price nobody paid.
//
// The amount typed is what comes off the total, VAT included (that is what the order form has always previewed). It is shared out over the lines
// in proportion to what each costs the customer (taxable + tax), and each line's taxable amount and tax fall together, so:
//   - the document's total is EXACTLY what it was (so a total typed or previewed in the form still matches, with no round-off),
//   - each line carries the discount as an ordinary line discount (`discountAmount` grows), which is what the VAT return, the GST split, the
//     posting and the e-invoice all read, with no new rule in any of them,
//   - nothing remains as a "header discount" on the document (pricing.headerDiscount is 0 and pricing.headerDiscountSpread says what was spread).
//
// Applied whenever a document is priced (TransactionService.buildPricing), from the lines as entered. A line priced again from what is stored
// strips `headerDiscountNet` first (calculateItems, toPricingInput), so the discount is never taken twice. A document priced before this keeps its
// header discount as it was: it was issued that way, until it is priced again.
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (n) => Number(n) || 0;

// what one priced line costs the customer: its taxable amount and the tax on it (a reverse-charge line has none)
const costOf = (l) => round2(num(l.taxableAmount) + num(l.vatAmount));

/**
 * lines: priced lines (utils/pricing.js via TransactionService.calculateItems); discount: the typed amount.
 * -> { lines, applied, net, vat } - `applied` is what really came off (never more than the lines cost), `net` the taxable amount it removed and
 *    `vat` the tax it removed (applied = net + vat). With nothing to spread the lines come back as they were and applied is 0.
 */
function spreadHeaderDiscount(lines, discount) {
  const typed = Math.max(0, num(discount));
  const costs = lines.map(costOf);
  const positive = costs.map((c, i) => (c > 0 ? i : -1)).filter((i) => i >= 0);
  const base = round2(positive.reduce((t, i) => t + costs[i], 0));
  const applied = round2(Math.min(typed, base));
  if (!(applied > 0)) return { lines, applied: 0, net: 0, vat: 0 };

  // each line's share; the last one takes what is left so the shares add up to the amount to the fils
  const share = new Map();
  let given = 0;
  positive.forEach((i, k) => {
    const s = k === positive.length - 1 ? round2(applied - given) : round2((applied * costs[i]) / base);
    const capped = Math.min(Math.max(s, 0), costs[i]);
    share.set(i, capped);
    given = round2(given + capped);
  });

  let net = 0;
  let vat = 0;
  const out = lines.map((l, i) => {
    if (!share.has(i)) return l;
    const cost = costs[i];
    const left = round2(cost - share.get(i)); // what the customer now pays for the line
    const taxable = num(l.taxableAmount);
    const tax = num(l.vatAmount);
    // taxable and tax keep their proportion; the tax takes the rounding so the line adds back to `left` exactly
    const taxable2 = tax > 0 ? round2((left * taxable) / cost) : left;
    const tax2 = tax > 0 ? round2(left - taxable2) : 0;
    net = round2(net + (taxable - taxable2));
    vat = round2(vat + (tax - tax2));
    const mine = round2(taxable - taxable2);
    const next = {
      ...l,
      taxableAmount: taxable2,
      vatAmount: tax2,
      discountAmount: round2(num(l.discountAmount) + mine),
      // how much of discountAmount is the shared-out header discount, so a line priced again from what is stored (an offer becoming an order,
      // a part delivery, an edit) takes only its OWN discount back and the typed discount is shared out once, not twice
      headerDiscountNet: round2(num(l.headerDiscountNet) + mine),
      lineTotal: left,
    };
    if (l.grandTotal !== undefined) next.grandTotal = left;
    if (l.rate !== undefined && num(l.rate) === taxable) next.rate = taxable2; // `rate` is the line's value, VAT-exclusive, after its discount
    if (num(l.rcmVat) > 0) next.rcmVat = taxable > 0 ? round2((num(l.rcmVat) * taxable2) / taxable) : 0; // the tax the recipient assesses follows the value
    return next;
  });
  return { lines: out, applied, net, vat };
}

module.exports = { spreadHeaderDiscount };
