// What Zarvia AI shows when a person asks about their OWN books: who is unpaid, what is in stock, what is in
// the bank, what was sold. Pure: no database, no clock (the caller passes today), so every rule is a test.
//
// THE RULE: the figures never go to the AI service. The model only chooses which lookup to run and with what
// words ("vendors", "Al Noor", "this month"); the server runs it through the product's own services, as the
// signed-in person, and writes the answer and the table itself. So the answer cannot hold a figure the books
// do not, and the names and amounts of a client's business never leave our server.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const MAX_ROWS = 15;

const money = (n, currency = "") =>
  `${currency ? `${currency} ` : ""}${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 3 });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- periods -------------------------------------------------------------------------------------

const PERIODS = ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "this_quarter", "last_quarter", "this_year", "last_year"];

const parse = (day) => {
  const [y, m, d] = String(day).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const iso = (dt) => dt.toISOString().slice(0, 10);
const addDays = (day, n) => iso(new Date(parse(day).getTime() + n * 86400000));
const monthStart = (y, m) => iso(new Date(Date.UTC(y, m, 1)));
const monthEnd = (y, m) => iso(new Date(Date.UTC(y, m + 1, 0)));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const human = (day) => {
  const d = parse(day);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

/**
 * A period word as two calendar days in the organisation's own calendar. Anything unknown is this month, which
 * is what "sales" with no period means to most people. A week starts on Monday.
 * -> { key, from, to, label }
 */
function periodOf(word, today) {
  const key = PERIODS.includes(word) ? word : "this_month";
  const t = parse(today);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  const range = (from, to, label) => ({ key, from, to: to > today ? today : to, label });
  if (key === "today") return range(today, today, "today");
  if (key === "yesterday") {
    const d = addDays(today, -1);
    return range(d, d, "yesterday");
  }
  const dow = (t.getUTCDay() + 6) % 7; // Monday = 0
  if (key === "this_week") return range(addDays(today, -dow), today, "this week");
  if (key === "last_week") return range(addDays(today, -dow - 7), addDays(today, -dow - 1), "last week");
  if (key === "last_month") {
    const ly = m === 0 ? y - 1 : y;
    const lm = m === 0 ? 11 : m - 1;
    return range(monthStart(ly, lm), monthEnd(ly, lm), `${MONTHS[lm]} ${ly}`);
  }
  if (key === "this_quarter" || key === "last_quarter") {
    let q = Math.floor(m / 3) - (key === "last_quarter" ? 1 : 0);
    let qy = y;
    if (q < 0) {
      q = 3;
      qy -= 1;
    }
    return range(monthStart(qy, q * 3), monthEnd(qy, q * 3 + 2), `${key === "this_quarter" ? "this quarter" : "last quarter"} (Q${q + 1} ${qy})`);
  }
  if (key === "this_year") return range(`${y}-01-01`, `${y}-12-31`, `this year (${y})`);
  if (key === "last_year") return range(`${y - 1}-01-01`, `${y - 1}-12-31`, String(y - 1));
  return range(monthStart(y, m), monthEnd(y, m), `this month (${MONTHS[m]} ${y})`);
}

// ---- unpaid invoices and bills ----------------------------------------------------------------

/**
 * Open invoices (AgeingService.openInvoices rows) by party, largest amount first.
 * -> [{ partyId, name, count, outstanding, overdue, overdueCount, oldestDays }]
 */
function groupOpen(rows = []) {
  const by = new Map();
  for (const r of rows) {
    const id = String(r.partyId || r.partyName);
    if (!by.has(id)) by.set(id, { partyId: id, name: r.partyName || "(deleted)", count: 0, outstanding: 0, overdue: 0, overdueCount: 0, oldestDays: 0 });
    const g = by.get(id);
    g.count += 1;
    g.outstanding = round2(g.outstanding + Number(r.outstanding || 0));
    if (Number(r.daysPastDue) > 0) {
      g.overdue = round2(g.overdue + Number(r.outstanding || 0));
      g.overdueCount += 1;
      g.oldestDays = Math.max(g.oldestDays, Number(r.daysPastDue));
    }
  }
  return [...by.values()].sort((a, b) => b.outstanding - a.outstanding || a.name.localeCompare(b.name));
}

const SIDES = {
  payable: { who: "vendor", whos: "vendors", doc: "bill", docs: "bills", verb: "you owe", link: { path: "/ageing?type=payable", label: "Open payables ageing" } },
  receivable: { who: "customer", whos: "customers", doc: "invoice", docs: "invoices", verb: "owe you", link: { path: "/ageing?type=receivable", label: "Open receivables ageing" } },
};

/** Everyone unpaid on one side, as an answer and a table. `overdueOnly` keeps the parties with something past due. */
function unpaidSummary(rows, { side, currency = "", overdueOnly = false } = {}) {
  const s = SIDES[side];
  let groups = groupOpen(rows);
  if (overdueOnly) groups = groups.filter((g) => g.overdue > 0.004);
  const total = round2(groups.reduce((t, g) => t + (overdueOnly ? g.overdue : g.outstanding), 0));
  const overdue = round2(groups.reduce((t, g) => t + g.overdue, 0));
  const count = groups.reduce((t, g) => t + (overdueOnly ? g.overdueCount : g.count), 0);
  if (!groups.length) {
    return {
      reply: overdueOnly ? `Nothing is overdue: no ${s.whos} have a ${s.doc} past its due date.` : `No ${s.whos} are unpaid: there are no open approved ${s.docs}.`,
      table: null,
    };
  }
  const one = groups.length === 1;
  const reply = overdueOnly
    ? `${plural(groups.length, s.who, s.whos)} ${side === "payable" ? one ? "is owed" : "are owed" : one ? "owes you" : "owe you"} ${money(total, currency)} that is past due, on ${plural(count, s.doc, s.docs)}.`
    : `${plural(groups.length, s.who, s.whos)} ${side === "payable" ? one ? "is unpaid" : "are unpaid" : one ? "has not paid in full" : "have not paid in full"}: ${money(total, currency)} on ${plural(count, s.doc, s.docs)}${overdue > 0.004 ? `, of which ${money(overdue, currency)} is past due` : ", none of it past due"}.`;
  const shown = groups.slice(0, MAX_ROWS);
  return {
    reply,
    table: {
      title: overdueOnly ? `Overdue ${s.whos}` : `Unpaid ${s.whos}`,
      rows: shown.map((g) => ({
        label: g.name,
        sub: `${plural(overdueOnly ? g.overdueCount : g.count, s.doc, s.docs)}${g.overdue > 0.004 ? ` · ${money(g.overdue, currency)} overdue, oldest ${plural(g.oldestDays, "day")}` : " · not yet due"}`,
        value: money(overdueOnly ? g.overdue : g.outstanding, currency),
        tone: g.overdue > 0.004 ? "danger" : "",
      })),
      total: { label: "Total", value: money(total, currency) },
      more: groups.length - shown.length,
      link: s.link,
    },
  };
}

/** One party's open documents, oldest first. */
function partyUnpaid(rows, { side, name, currency = "" } = {}) {
  const s = SIDES[side];
  const open = [...rows].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  if (!open.length) return { reply: `${name} has no unpaid ${s.docs}. Nothing is open.`, table: null };
  const total = round2(open.reduce((t, r) => t + Number(r.outstanding || 0), 0));
  const overdue = round2(open.filter((r) => Number(r.daysPastDue) > 0).reduce((t, r) => t + Number(r.outstanding || 0), 0));
  const shown = open.slice(0, MAX_ROWS);
  return {
    reply: `${side === "payable" ? `You owe ${name}` : `${name} owes you`} ${money(total, currency)} on ${plural(open.length, s.doc, s.docs)}${overdue > 0.004 ? `, ${money(overdue, currency)} of it past due` : ", none of it past due yet"}.`,
    table: {
      title: `${name}: unpaid ${s.docs}`,
      rows: shown.map((r) => ({
        label: r.transactionNo || "(no number)",
        sub: `${human(iso(new Date(r.date)))} · ${Number(r.daysPastDue) > 0 ? `${plural(Number(r.daysPastDue), "day")} overdue` : Number(r.daysToDue) > 0 ? `due in ${plural(Number(r.daysToDue), "day")}` : "due today"}`,
        value: money(r.outstanding, currency),
        tone: Number(r.daysPastDue) > 0 ? "danger" : "",
      })),
      total: { label: "Total", value: money(total, currency) },
      more: open.length - shown.length,
      link: s.link,
    },
  };
}

// ---- stock ---------------------------------------------------------------------------------------

const low = (i) => Number(i.reorderLevel) > 0 && Number(i.currentStock || 0) <= Number(i.reorderLevel);

/** Items and what is on hand. `lowOnly` = at or below the reorder level. Services have no stock and are left out. */
function stockTable(items, { lowOnly = false, search = "" } = {}) {
  const goods = (items || []).filter((i) => i.itemType !== "service");
  const list = (lowOnly ? goods.filter(low) : goods).sort((a, b) => Number(a.currentStock || 0) - Number(b.currentStock || 0) || String(a.itemName).localeCompare(String(b.itemName)));
  if (!list.length) {
    return {
      reply: lowOnly ? "Nothing is running low: every item is above its reorder level." : search ? `I could not find a stocked item called "${search}".` : "There are no stocked items yet.",
      table: null,
    };
  }
  // The list read does not carry the unit's name; a quantity with no unit is better than a guessed one.
  const unit = (i) => String(i.unitName || "").trim();
  const shown = list.slice(0, MAX_ROWS);
  const lowCount = list.filter(low).length;
  const reply = lowOnly
    ? `${plural(list.length, "item is", "items are")} at or below the reorder level.`
    : list.length === 1
      ? `${list[0].itemName}: ${qty(list[0].currentStock)}${unit(list[0]) ? ` ${unit(list[0])}` : ""} on hand${low(list[0]) ? `, which is at or below its reorder level of ${qty(list[0].reorderLevel)}` : ""}.`
      : `${plural(list.length, "item")} found${lowCount ? `, ${lowCount} of them running low` : ""}.`;
  return {
    reply,
    table: {
      title: lowOnly ? "Running low" : "Stock on hand",
      rows: shown.map((i) => ({
        label: i.itemName,
        sub: `${i.sku || i.itemId || ""}${Number(i.reorderLevel) > 0 ? `${i.sku || i.itemId ? " · " : ""}reorder at ${qty(i.reorderLevel)}` : ""}`,
        value: `${qty(i.currentStock)}${unit(i) ? ` ${unit(i)}` : ""}`,
        tone: low(i) ? "danger" : "",
      })),
      total: null,
      more: list.length - shown.length,
      link: { path: "/stock-item-creation", label: "Open stock items" },
    },
  };
}

// ---- cash and bank --------------------------------------------------------------------------------

/** Cash and bank accounts with their balances, as PaymentModeService.options returns them. */
function cashTable({ cashAccounts = [], bankAccounts = [] } = {}, currency = "") {
  const all = [...bankAccounts.map((a) => ({ ...a, kind: "Bank" })), ...cashAccounts.map((a) => ({ ...a, kind: "Cash" }))];
  if (!all.length) return { reply: "There are no cash or bank accounts set up yet.", table: null };
  const sum = (list) => round2(list.reduce((t, a) => t + Number(a.balance || 0), 0));
  const total = sum(all);
  const bank = sum(bankAccounts);
  const cash = sum(cashAccounts);
  const shown = all.slice(0, MAX_ROWS);
  return {
    reply: `You have ${money(total, currency)} across ${plural(all.length, "cash and bank account")}: ${money(bank, currency)} in the bank and ${money(cash, currency)} in cash.`,
    table: {
      title: "Cash and bank",
      rows: shown.map((a) => ({ label: a.accountName, sub: a.kind, value: money(a.balance, currency), tone: Number(a.balance) < 0 ? "danger" : "" })),
      total: { label: "Total", value: money(total, currency) },
      more: all.length - shown.length,
      link: { path: "/cash-and-bank", label: "Open cash and bank" },
    },
  };
}

// ---- sales and purchases ------------------------------------------------------------------------

/** TradeReportsService.summary grouped by party, as an answer and a table. */
function tradeTable(summary, { direction, period, currency = "", party = "" } = {}) {
  const what = direction === "purchases" ? "Purchases" : "Sales";
  const t = summary?.totals || {};
  const rows = summary?.rows || [];
  if (!rows.length) return { reply: `No ${what.toLowerCase()} ${party ? `with ${party} ` : ""}were approved for ${period.label}.`, table: null };
  const shown = rows.slice(0, MAX_ROWS);
  const word = direction === "purchases" ? "vendor" : "customer";
  return {
    reply: `${what} ${party ? `with ${party} ` : ""}for ${period.label}: ${money(t.net, currency)} before tax (${money(t.total, currency)} with tax) on ${plural(t.documents || 0, "invoice")}${party ? "" : ` from ${plural(t.parties || rows.length, word)}`}${Number(t.returns) > 0.004 ? `, after ${money(t.returns, currency)} of returns` : ""}.`,
    table: {
      title: `${what}, ${human(period.from)} to ${human(period.to)}`,
      rows: shown.map((r) => ({ label: r.partyName || "Unknown", sub: `${plural(r.documents || 0, "invoice")}${r.sharePct != null ? ` · ${r.sharePct}%` : ""}`, value: money(r.net, currency) })),
      total: { label: "Total before tax", value: money(t.net, currency) },
      more: rows.length - shown.length,
      link: { path: "/trade-reports", label: "Open analysis" },
    },
  };
}

// ---- profit and loss, balance sheet, the whole position, stock alerts ------------------------------

const signed = (n, currency) => (Number(n) < 0 ? `-${money(Math.abs(n), currency)}` : money(n, currency));

/** LedgerReportsService.profitAndLoss for a period: headline tiles and the statement's own lines. */
function profitTable(pl, { period, currency = "" } = {}) {
  const revenue = Number(pl?.revenue?.total || 0);
  const net = Number(pl?.netProfit || 0);
  const gross = Number(pl?.grossProfit || 0);
  if (!pl || (!revenue && !Number(pl.directCosts?.total) && !Number(pl.operatingExpenses?.total) && !Number(pl.otherIncome?.total))) {
    return { reply: `There is nothing in the books for ${period.label} yet, so there is no profit or loss to show.`, table: null };
  }
  const result = net < 0 ? `a loss of ${money(Math.abs(net), currency)}` : net === 0 ? "break-even" : `a profit of ${money(net, currency)}`;
  const line = (label, value, sub = "", tone = "") => ({ label, sub, value: signed(value, currency), tone });
  return {
    reply: `For ${period.label} you have ${result}: revenue ${money(revenue, currency)}, gross profit ${money(gross, currency)}${pl.grossMargin != null ? ` (${pl.grossMargin}% margin)` : ""}.`,
    table: {
      title: `Profit and loss, ${human(period.from)} to ${human(period.to)}`,
      stats: [
        { label: net < 0 ? "Net loss" : "Net profit", value: money(Math.abs(net), currency), tone: net < 0 ? "danger" : net > 0 ? "good" : "" },
        { label: "Revenue", value: money(revenue, currency), tone: "" },
        { label: "Gross margin", value: pl.grossMargin != null ? `${pl.grossMargin}%` : "-", tone: "" },
      ],
      rows: [
        line("Revenue", revenue, "after sales discounts"),
        line("Direct costs", pl.directCosts?.total, "cost of goods"),
        line("Gross profit", gross),
        line("Other income", pl.otherIncome?.total),
        line("Operating expenses", pl.operatingExpenses?.total),
        line(net < 0 ? "Net loss" : "Net profit", net, "", net < 0 ? "danger" : ""),
      ],
      total: null,
      more: 0,
      link: { path: "/financial-statements", label: "Open financial statements" },
    },
  };
}

/** FinancialService.getBalanceSheet: assets against liabilities and equity, and whether it balances. */
function balanceTable(bs, { asOn, currency = "" } = {}) {
  const a = bs?.sections?.assets;
  const l = bs?.sections?.liabilities;
  const e = bs?.sections?.equity;
  if (!a || !l || !e) return { reply: "The balance sheet could not be read just now.", table: null };
  const assets = Number(bs.totalAssets ?? a.amount ?? 0);
  const liabilities = Number(bs.totalLiabilities ?? l.amount ?? 0);
  const equity = Number(bs.totalEquity ?? e.amount ?? 0);
  if (!assets && !liabilities && !equity) return { reply: `There is nothing in the books as at ${human(asOn)} yet, so the balance sheet is empty.`, table: null };
  const row = (label, value) => ({ label, sub: "", value: signed(value, currency), tone: "" });
  return {
    reply: `As at ${human(asOn)} you own ${money(assets, currency)}, owe ${money(liabilities, currency)} and the owners' equity is ${money(equity, currency)}.${bs.isBalanced === false ? " The sheet does not balance, which needs an accountant's look." : ""}`,
    table: {
      title: `Balance sheet as at ${human(asOn)}`,
      stats: [
        { label: "Assets", value: money(assets, currency), tone: "" },
        { label: "Liabilities", value: money(liabilities, currency), tone: "" },
        { label: "Equity", value: signed(equity, currency), tone: equity < 0 ? "danger" : "" },
      ],
      rows: [
        row("Non-current assets", a.nonCurrent?.amount),
        row("Current assets", a.current?.amount),
        row("Non-current liabilities", l.nonCurrent?.amount),
        row("Current liabilities", l.current?.amount),
        row("Equity", equity),
      ],
      total: { label: "Liabilities and equity", value: money(bs.totalLiabilitiesAndEquity ?? liabilities + equity, currency) },
      more: 0,
      link: { path: "/financial-statements", label: "Open financial statements" },
    },
  };
}

/** The whole position in one look: money in the bank, owed to you, owed by you, and the period's result. */
function snapshotTable({ cash = 0, receivable = 0, payable = 0, overdueReceivable = 0, overduePayable = 0, profit = null, period = null } = {}, currency = "") {
  const rows = [
    { label: "Cash and bank", sub: "", value: signed(cash, currency), tone: cash < 0 ? "danger" : "" },
    { label: "Customers owe you", sub: overdueReceivable > 0.004 ? `${money(overdueReceivable, currency)} past due` : "none past due", value: money(receivable, currency), tone: overdueReceivable > 0.004 ? "danger" : "" },
    { label: "You owe vendors", sub: overduePayable > 0.004 ? `${money(overduePayable, currency)} past due` : "none past due", value: money(payable, currency), tone: overduePayable > 0.004 ? "danger" : "" },
  ];
  if (profit != null) rows.push({ label: profit < 0 ? `Loss, ${period.label}` : `Profit, ${period.label}`, sub: "", value: signed(profit, currency), tone: profit < 0 ? "danger" : "" });
  const net = round2(cash + receivable - payable);
  const result = profit == null ? "" : profit < 0 ? ` For ${period.label} you are at a loss of ${money(Math.abs(profit), currency)}.` : profit === 0 ? ` For ${period.label} you are break-even.` : ` For ${period.label} you are ${money(profit, currency)} in profit.`;
  return {
    reply: `You have ${money(cash, currency)} in cash and bank, customers owe you ${money(receivable, currency)} and you owe vendors ${money(payable, currency)}.${result}`,
    table: {
      title: "Where the business stands",
      stats: [
        { label: "Cash and bank", value: money(cash, currency), tone: "" },
        { label: "Cash + owed - owing", value: signed(net, currency), tone: net < 0 ? "danger" : "" },
      ],
      rows,
      total: null,
      more: 0,
      link: { path: "/dashboard", label: "Open the dashboard" },
    },
  };
}

/** StockReportsService.reorder and .expiry: what is out, what is low, what is about to go off. */
function stockAlertsTable(reorder, expiry, { days = 30 } = {}) {
  const low = reorder?.rows || [];
  const batches = expiry?.rows || [];
  if (!low.length && !batches.length) return { reply: `Nothing needs attention: no item is at or below its reorder level and nothing expires within ${plural(days, "day")}.`, table: null };
  const out = low.filter((r) => r.status === "out").length;
  const parts = [];
  if (low.length) parts.push(`${plural(low.length, "item is", "items are")} at or below the reorder level${out ? ` (${out} out of stock)` : ""}`);
  if (batches.length) parts.push(`${plural(batches.length, "batch", "batches")} expired or will expire within ${plural(days, "day")}`);
  const lowRows = low.slice(0, 8).map((r) => ({
    label: r.itemName,
    sub: `${r.status === "out" ? "Out of stock" : "Below reorder level"} · reorder at ${qty(r.reorderLevel)}${r.vendorName ? ` · ${r.vendorName}` : ""}`,
    value: qty(r.qty),
    tone: "danger",
  }));
  const batchRows = batches.slice(0, 7).map((b) => ({
    label: b.itemName,
    sub: `Batch ${b.batchNumber || "-"} · ${b.expired ? `expired ${plural(Math.abs(b.daysToExpiry), "day")} ago` : `expires in ${plural(b.daysToExpiry, "day")}`}`,
    value: qty(b.qtyOnHand),
    tone: b.expired || b.daysToExpiry <= 7 ? "danger" : "",
  }));
  return {
    reply: `${parts.join(", and ")}.`.replace(/^./, (c) => c.toUpperCase()),
    table: {
      title: "Stock alerts",
      stats: [
        { label: "Out of stock", value: String(out), tone: out ? "danger" : "" },
        { label: "Running low", value: String(low.length - out), tone: low.length - out ? "danger" : "" },
        { label: `Expiring in ${days}d`, value: String(batches.length), tone: batches.length ? "danger" : "" },
      ],
      rows: [...lowRows, ...batchRows],
      total: null,
      more: Math.max(0, low.length - lowRows.length) + Math.max(0, batches.length - batchRows.length),
      link: { path: "/stock-reports", label: "Open stock reports" },
    },
  };
}

// ---- telling a lookup from a how-to --------------------------------------------------------------

const LOOKUP_WORDS = /\b(van|route|visited|profit|loss|balance sheet|financial position|position|how are we doing|how is the business|expire|expiry|expiring|expired|alerts?|out of stock|reorder|unpaid|outstanding|owe|owes|owed|owing|overdue|due|balance|balances|pending|stock|on hand|in stock|low|sales|sold|purchases|bought|cash|bank|list|show|total|how much|how many)\b/i;
const HOW_TO = /^\s*(how (do|can|should) i|how to|where (do|can) i|what is a|what does|explain|why)\b/i;

/** "list unpaid vendors", "how much do we owe Al Noor", "stock of rice": a question about the person's own figures. */
function looksLikeLookup(question) {
  const t = String(question || "").trim();
  if (!t || HOW_TO.test(t)) return false;
  return LOOKUP_WORDS.test(t);
}

module.exports = {
  PERIODS, MAX_ROWS, periodOf, groupOpen, unpaidSummary, partyUnpaid, stockTable, cashTable, tradeTable, profitTable, balanceTable, snapshotTable, stockAlertsTable, looksLikeLookup, money, round2,
};
