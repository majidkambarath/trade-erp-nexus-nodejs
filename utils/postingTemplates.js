// Declarative posting templates. Pure: no I/O, no Mongoose.
//
// One template per document type is a list of legs:
//   { account, side, amount }
//     account: { party: true }  the customer / vendor ledger account
//              { key: "..." }   a posting-map configKey (services/financial/accountConfigService)
//     side:    "debit" | "credit"
//     amount:  the name of a figure in `figures` (net, vat, total, cogs, roundOff, ...)
//
// One engine (buildEntries) evaluates any template, so a new document type is a new list of
// legs, not a new 200-line function.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const TEMPLATES = {
  // Customer owes the VAT-inclusive total. Revenue is posted GROSS with discounts shown
  // separately, so the discount given is visible in the books; stock leaves inventory at cost.
  sales_order: [
    { account: { party: true }, side: "debit", amount: "total" },
    { account: { key: "sales-revenue" }, side: "credit", amount: "gross" },
    { account: { key: "discount-sales" }, side: "debit", amount: "discount" },
    { account: { key: "freight-sales" }, side: "credit", amount: "charges" },
    { account: { key: "vat-sales" }, side: "credit", amount: "vat" },
    { account: { key: "round-off-sales" }, side: "credit", amount: "roundUp" },
    { account: { key: "round-off-sales" }, side: "debit", amount: "roundDown" },
    { account: { key: "cogs" }, side: "debit", amount: "cogs" },
    { account: { key: "inventory-asset" }, side: "credit", amount: "cogs" },
  ],
  // The exact mirror of a sale; stock returns to inventory at the cost it was issued at.
  sales_return: [
    { account: { party: true }, side: "credit", amount: "total" },
    { account: { key: "sales-revenue" }, side: "debit", amount: "gross" },
    { account: { key: "discount-sales" }, side: "credit", amount: "discount" },
    { account: { key: "freight-sales" }, side: "debit", amount: "charges" },
    { account: { key: "vat-sales" }, side: "debit", amount: "vat" },
    { account: { key: "round-off-sales" }, side: "debit", amount: "roundUp" },
    { account: { key: "round-off-sales" }, side: "credit", amount: "roundDown" },
    { account: { key: "inventory-asset" }, side: "debit", amount: "cogs" },
    { account: { key: "cogs" }, side: "credit", amount: "cogs" },
  ],
  // We owe the vendor the VAT-inclusive total. Stock is received at the VAT-exclusive cost after
  // line discounts (netLines); a settlement discount is income; input VAT is recoverable.
  purchase_order: [
    { account: { key: "inventory-asset" }, side: "debit", amount: "netLines" },
    { account: { key: "freight-purchase" }, side: "debit", amount: "charges" },
    { account: { key: "vat-purchase" }, side: "debit", amount: "vat" },
    { account: { key: "round-off-purchase" }, side: "debit", amount: "roundUp" },
    { account: { key: "round-off-purchase" }, side: "credit", amount: "roundDown" },
    { account: { key: "discount-purchase" }, side: "credit", amount: "headerDiscount" },
    { account: { party: true }, side: "credit", amount: "total" },
    // Reverse charge: the supplier charged no VAT, so the vendor is owed the net and the VAT we assess on it is booked
    // as input tax (recoverable) against a liability (payable to the FTA). A pair that balances on its own, outside the party total.
    { account: { key: "vat-purchase" }, side: "debit", amount: "rcmVat" },
    { account: { key: "rcm-purchase" }, side: "credit", amount: "rcmVat" },
  ],
  purchase_return: [
    { account: { party: true }, side: "debit", amount: "total" },
    { account: { key: "inventory-asset" }, side: "credit", amount: "netLines" },
    { account: { key: "freight-purchase" }, side: "credit", amount: "charges" },
    { account: { key: "vat-purchase" }, side: "credit", amount: "vat" },
    { account: { key: "round-off-purchase" }, side: "credit", amount: "roundUp" },
    { account: { key: "round-off-purchase" }, side: "debit", amount: "roundDown" },
    { account: { key: "discount-purchase" }, side: "debit", amount: "headerDiscount" },
    // the mirror of the reverse-charge pair on a purchase
    { account: { key: "rcm-purchase" }, side: "debit", amount: "rcmVat" },
    { account: { key: "vat-purchase" }, side: "credit", amount: "rcmVat" },
  ],
};

// Figures a template can reference.
//   gross        qty x price before discounts
//   discount     line discounts + header discount (a sale posts both to discount-sales)
//   netLines     gross - line discounts: the VAT-exclusive value of the goods
//   headerDiscount, charges (freight etc., VAT-exclusive), vat (lines + charges)
//   total        what the party is charged (header total)
//   roundUp / roundDown   explicit round-off, so the posting always agrees with the party balance
//   cogs         cost of goods issued / restored, from the costing engine
//   rcmVat       VAT the recipient assesses on reverse-charge lines. NOT part of vat or total: the supplier did not charge it, so the
//                party is not owed it. Only the purchase templates have legs for it; a sale (the supplier side) posts no VAT for it.
// Documents saved before server-side pricing carry no `pricing`; they fall back to the lines.
function figuresFor(transaction, cogs = 0) {
  const items = transaction.items || [];
  const p = transaction.pricing;
  const total = round2(Number(transaction.totalAmount));

  if (p && p.grandTotal != null) {
    const roundOff = round2(p.roundOff || 0);
    return {
      gross: round2(p.gross), discount: round2(p.lineDiscount + p.headerDiscount),
      netLines: round2(p.net), headerDiscount: round2(p.headerDiscount),
      charges: round2(p.chargesNet), vat: round2(p.lineVat + p.chargesVat), total,
      roundUp: roundOff > 0 ? roundOff : 0, roundDown: roundOff < 0 ? -roundOff : 0, cogs: round2(cogs),
      rcmVat: round2(p.rcmVat || 0), // absent on a document priced before reverse charge was posted
    };
  }

  const lineTotal = round2(items.reduce((t, i) => t + (Number(i.lineTotal) || 0), 0));
  const vat = round2(items.reduce((t, i) => t + (Number(i.vatAmount) || 0), 0));
  const net = round2(lineTotal - vat);
  const diff = round2((Number.isFinite(total) ? total : lineTotal) - lineTotal);
  return {
    gross: net, discount: 0, netLines: net, headerDiscount: 0, charges: 0, vat,
    total: Number.isFinite(total) ? total : lineTotal,
    roundUp: diff > 0 ? diff : 0, roundDown: diff < 0 ? -diff : 0, cogs: round2(cogs),
    // lines that carry the assessed VAT (written with it, never by hand); a line from before it existed has none
    rcmVat: round2(items.reduce((t, i) => t + (Number(i.rcmVat) || 0), 0)),
  };
}

// Evaluate a template into entries. `resolve(account)` maps a leg's account reference to a
// ledger account id (it throws when a key is unmapped). Zero legs are dropped; the result must
// balance, or nothing is written.
function buildEntries(type, figures, resolve) {
  const template = TEMPLATES[type];
  if (!template) throw new Error(`No posting template for document type "${type}"`);

  const entries = [];
  for (const leg of template) {
    const amount = round2(figures[leg.amount] || 0);
    if (amount <= 0) continue;
    entries.push({
      accountId: resolve(leg.account),
      debitAmount: leg.side === "debit" ? amount : 0,
      creditAmount: leg.side === "credit" ? amount : 0,
      figure: leg.amount,
    });
  }

  const debit = round2(entries.reduce((t, e) => t + e.debitAmount, 0));
  const credit = round2(entries.reduce((t, e) => t + e.creditAmount, 0));
  if (Math.abs(debit - credit) > 0.01) {
    const err = new Error(`Unbalanced posting for ${type}: debit ${debit} vs credit ${credit}`);
    err.code = "UNBALANCED_POSTING";
    throw err;
  }
  return entries;
}

module.exports = { TEMPLATES, figuresFor, buildEntries, round2 };
