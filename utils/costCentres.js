// Which cost centre each ledger row of a trade document belongs to. Pure: no Mongoose.
//
// A document names a cost centre on its header and a line may name its own. The posting template sums the lines into a
// few legs (revenue, discount, inventory or expense, cost of goods); a leg that is a sum of lines is shared out over the
// centres of the lines it came from, by each line's own figure, fils-exact (the last centre takes what is left). Every
// other leg - the customer or supplier, the tax, charges, round-off, reverse charge - is the document's as a whole and
// carries the header's centre. A document whose lines name no centre of their own comes back with every leg on the
// header's centre (or none), in the same order, so its posting is exactly what it was.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const key = (v) => (v === undefined || v === null || v === "" ? null : String(v));

/**
 * @param entries  buildEntries() output after service and GST routing; each carries `figure`
 * @param lines    one per document line: { centre, gross, discount, net, cogs, service, revenueAccount, expenseAccount }
 *                 revenueAccount / expenseAccount: the account a service line's share was moved to (null = it stayed on the
 *                 template's leg); `service` true for a service line (it has no inventory or cost of goods)
 * @param header   the document's cost centre, or null
 * @returns entries, each with `costCentreId` (string or null); a split leg becomes one entry per centre
 */
function splitLegsByCentre(entries, lines, header) {
  const head = key(header);
  const list = (lines || []).map((l) => ({ ...l, centre: key(l.centre) ?? head }));
  const anyOwn = list.some((l) => l.centre !== head);
  if (!anyOwn) return entries.map((e) => ({ ...e, costCentreId: head }));

  // the lines a leg is the sum of, and the figure of each that it summed
  const weightsFor = (e) => {
    const acc = key(e.accountId);
    switch (e.figure) {
      case "gross":
        return list.filter((l) => !l.revenueAccount).map((l) => [l.centre, l.gross]);
      case "serviceRevenue":
        return list.filter((l) => l.service && key(l.revenueAccount) === acc).map((l) => [l.centre, l.gross]);
      case "discount":
        return list.map((l) => [l.centre, l.discount]);
      case "netLines":
        return list.filter((l) => !l.service).map((l) => [l.centre, l.net]);
      case "serviceExpense":
        return list.filter((l) => l.service && key(l.expenseAccount) === acc).map((l) => [l.centre, l.net]);
      case "cogs":
        return list.filter((l) => !l.service).map((l) => [l.centre, l.cogs]);
      default:
        return null;
    }
  };

  const out = [];
  for (const e of entries) {
    const weights = weightsFor(e);
    const side = e.debitAmount > 0 ? "debitAmount" : "creditAmount";
    const amount = round2(e[side]);
    const byCentre = new Map();
    for (const [c, w] of weights || []) {
      const n = Number(w) || 0;
      if (n > 0) byCentre.set(c, (byCentre.get(c) || 0) + n);
    }
    const total = [...byCentre.values()].reduce((t, n) => t + n, 0);
    if (!weights || byCentre.size < 2 || !(total > 0)) {
      // one centre (or nothing to weigh by): the whole leg goes there
      out.push({ ...e, costCentreId: byCentre.size === 1 ? [...byCentre.keys()][0] : head });
      continue;
    }
    const groups = [...byCentre.entries()];
    let left = amount;
    groups.forEach(([c, w], i) => {
      const share = i === groups.length - 1 ? round2(left) : round2((amount * w) / total);
      left = round2(left - share);
      if (!(share > 0)) return;
      out.push({ ...e, debitAmount: side === "debitAmount" ? share : 0, creditAmount: side === "creditAmount" ? share : 0, costCentreId: c });
    });
  }

  const debit = round2(out.reduce((t, x) => t + x.debitAmount, 0));
  const credit = round2(out.reduce((t, x) => t + x.creditAmount, 0));
  const before = round2(entries.reduce((t, x) => t + x.debitAmount, 0));
  if (Math.abs(debit - credit) > 0.01 || Math.abs(debit - before) > 0.01) {
    const err = new Error(`Cost centre split broke the balance: debit ${debit}, credit ${credit}, was ${before}`);
    err.code = "UNBALANCED_POSTING";
    throw err;
  }
  return out;
}

/**
 * The per-line facts the split needs, from a document's stored lines, its stock movements and its item kinds.
 * @param items         Transaction.items
 * @param stockUpdates  processTransactionStock() output (goods lines only, in line order): { itemId, cost }
 * @param kindOf        (line) => { service, incomeAccountId, expenseAccountId }  (ItemKindService.kindOf)
 * @param defaultExpenseAccountId  where a purchased service with no account of its own went (service-expense)
 */
function lineFacts(items, stockUpdates, kindOf, { defaultExpenseAccountId = null } = {}) {
  const queue = new Map();
  for (const u of stockUpdates || []) {
    const k = key(u.itemId);
    if (!queue.has(k)) queue.set(k, []);
    queue.get(k).push(Number(u.cost) || 0);
  }
  return (items || []).map((l) => {
    const kind = kindOf ? kindOf(l) : { service: false };
    const service = Boolean(kind?.service);
    const costs = queue.get(key(l.itemId?._id ?? l.itemId));
    const cogs = !service && costs && costs.length ? costs.shift() : 0;
    const net = Number(l.taxableAmount) || 0;
    const discount = Number(l.discountAmount) || 0;
    const gross = Number(l.grossAmount) || net + discount;
    return {
      centre: key(l.costCentreId?._id ?? l.costCentreId),
      gross,
      discount,
      net,
      cogs,
      service,
      revenueAccount: service && kind.incomeAccountId ? key(kind.incomeAccountId) : null,
      expenseAccount: service ? key(kind.expenseAccountId) ?? key(defaultExpenseAccountId) : null,
    };
  });
}

/** Every centre a document names, header and lines, for one existence check. */
const centresOf = (header, items) => [header, ...(items || []).map((l) => l?.costCentreId)].map(key).filter(Boolean);

module.exports = { splitLegsByCentre, lineFacts, centresOf };
