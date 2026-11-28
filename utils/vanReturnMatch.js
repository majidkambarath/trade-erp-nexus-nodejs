// Which invoices a customer's returned goods are credited against: their own approved invoices that carried each item,
// the NEWEST first, each line up to what can still come back on it (paid lines before the free goods of the same invoice);
// what no invoice covers is left over, to be taken back without one. Pure: no database.

const EPS = 1e-6;
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const time = (v) => (v ? new Date(v).getTime() || 0 : 0);

/** Newest invoice first: by its date, then when it was made, then its id, so the same invoices always sort the same. */
const newestFirst = (a, b) => time(b.date) - time(a.date) || time(b.createdAt) - time(a.createdAt) || String(b.id).localeCompare(String(a.id));

/**
 * @param {Array<{stockId, qty, condition}>} requested  what is coming back, one entry per item and condition
 * @param {Array<{id, number, date, createdAt, lines: Array<{lineId, stockId, remaining, price}>}>} invoices
 * @returns {{ groups: Array<{invoiceId, number, date, lines: Array<{lineId, stockId, qty, condition}>}>,
 *             rest: Array<{stockId, qty, condition}> }}  groups in the order the invoices were used (newest first)
 */
function matchReturnLines(requested, invoices) {
  const sorted = [...(invoices || [])].sort(newestFirst);
  const left = new Map(); // what can still come back on each line, as the entries are placed
  const key = (inv, line) => `${inv.id}:${line.lineId}`;
  // an invoice's paid lines first, then its free goods, each in the order the invoice lists them
  const linesOf = (inv, stockId) => {
    const lines = (inv.lines || []).filter((l) => String(l.stockId) === String(stockId));
    return [...lines.filter((l) => Number(l.price) > 0), ...lines.filter((l) => !(Number(l.price) > 0))];
  };
  const groups = new Map();
  const rest = [];
  for (const entry of requested || []) {
    let need = round3(entry.qty);
    for (const inv of sorted) {
      if (need <= EPS) break;
      for (const line of linesOf(inv, entry.stockId)) {
        if (need <= EPS) break;
        const k = key(inv, line);
        const open = left.has(k) ? left.get(k) : round3(Math.max(0, Number(line.remaining) || 0));
        const take = round3(Math.min(open, need));
        if (take <= EPS) continue;
        left.set(k, round3(open - take));
        need = round3(need - take);
        if (!groups.has(inv.id)) groups.set(inv.id, { invoiceId: inv.id, number: inv.number, date: inv.date, lines: [] });
        groups.get(inv.id).lines.push({ lineId: line.lineId, stockId: String(entry.stockId), qty: take, condition: entry.condition });
      }
    }
    if (need > EPS) rest.push({ stockId: String(entry.stockId), qty: need, condition: entry.condition });
  }
  const order = new Map(sorted.map((inv, i) => [inv.id, i]));
  return { groups: [...groups.values()].sort((a, b) => order.get(a.invoiceId) - order.get(b.invoiceId)), rest };
}

module.exports = { matchReturnLines };
