// VAT worked out once per tax category and rate, the way a PINT-AE e-invoice (and so Wafeq) does it. Pure, no database.
//
// Our pricing adds VAT line by line; the e-invoice rounds the VAT of each (category, rate) group once. Three lines of 0.10 at 5% are 0.03 line by
// line and 0.02 as a group, and an invoice the ledger says is 0.33 but the e-invoice says is 0.32 cannot be sent. For an organisation that sends
// its invoices through Wafeq the document is priced the e-invoice's way: the group's VAT is round2(sum of nets x rate / 100) and the fils
// difference goes onto the group's largest line (a charge counts as a line). Nets never change.
//
// It recomputes from freshly priced lines every time, so applying it twice gives the same answer.
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (n) => Number(n) || 0;

const taxable = (l) => l.kind === "line" && l.row.taxKind && l.row.taxKind !== "standard" ? false : num(l.rate) > 0;

/**
 * lines: priced lines { taxableAmount, vatAmount, lineTotal, vatPercent, taxKind }; charges: { amount, vatPercent, vatAmount }.
 * -> { lines, charges, changed } with the same shapes. A reverse-charge, zero-rated, exempt or out-of-scope row is left alone.
 */
function roundVatByRate(lines = [], charges = []) {
  const members = [];
  lines.forEach((row, index) => members.push({ kind: "line", index, row, net: num(row.taxableAmount), vat: num(row.vatAmount), rate: num(row.vatPercent) }));
  charges.forEach((row, index) => members.push({ kind: "charge", index, row, net: num(row.amount), vat: num(row.vatAmount), rate: num(row.vatPercent) }));

  const groups = new Map();
  for (const m of members) {
    if (!taxable(m) || m.net <= 0) continue;
    const key = String(m.rate);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  const outLines = lines.map((l) => l);
  const outCharges = charges.map((c) => c);
  let changed = false;
  for (const [, g] of groups) {
    const rate = g[0].rate;
    const net = round2(g.reduce((t, m) => t + m.net, 0));
    const want = round2((net * rate) / 100);
    const have = round2(g.reduce((t, m) => t + m.vat, 0));
    const diff = round2(want - have);
    if (diff === 0) continue;
    const biggest = g.reduce((a, b) => (b.net > a.net ? b : a));
    changed = true;
    if (biggest.kind === "line") {
      const l = biggest.row;
      outLines[biggest.index] = { ...l, vatAmount: round2(num(l.vatAmount) + diff), lineTotal: round2(num(l.lineTotal) + diff) };
    } else {
      const c = biggest.row;
      outCharges[biggest.index] = { ...c, vatAmount: round2(num(c.vatAmount) + diff) };
    }
  }
  return { lines: outLines, charges: outCharges, changed };
}

module.exports = { roundVatByRate };
