// The tools that let Zarvia AI LOOK THINGS UP in the person's own books: who is unpaid, what is in stock, what is
// in the bank, what was sold or bought in a period.
//
// THE RULE: the figures never go to the AI service. The model only picks the lookup and the words to look up
// ("vendors", "Al Noor", "this_month"). The server runs it through the product's own services - as the
// signed-in person, inside their organisation and branch, so they see exactly what their screens show them -
// and writes the answer and the table itself (utils/assistantData.js). assistantService.ask never hands the
// rows back to the model: a round made only of these tools ends with the server's words, and in a mixed round
// the model is told only that a table was shown.
//
// Nothing here writes anything. Offered only when the organisation has not switched lookups off and the person
// holds the read keys of the screen the same figures live on.
const roles = require("../../utils/permissions");
const data = require("../../utils/assistantData");
const orgLocale = require("../../utils/orgLocale");
const StockService = require("../stock/stockService");
const AgeingService = require("../financial/ageingService");
const PaymentModeService = require("../banking/paymentModeService");
const TradeReportsService = require("../reports/tradeReportsService");
const LedgerReportsService = require("../reports/ledgerReportsService");
const StockReportsService = require("../reports/stockReportsService");
const FinancialService = require("../financial/financialService");
const DefaultChartService = require("../financial/defaultChartService");
const { findParty, choiceReply } = require("./partyLookup");
const van = require("./vanTools");

const ok = (d) => ({ ok: true, data: d });
const refused = (error) => ({ ok: false, error });
const CLOSE = "Tell me which one and I will look it up.";

const unpaidSchema = (party) => ({
  type: "object",
  properties: {
    [party]: { type: "string", description: `Only when the person named one ${party}: the name as they typed it. Leave out to list every ${party}.` },
    overdue_only: { type: "boolean", description: "True only if the person asked for overdue or past-due ones." },
  },
  required: [],
  additionalProperties: false,
});

const DEFINITIONS = [
  {
    name: "unpaid_bills",
    description:
      "Look up what the business still OWES its vendors (suppliers): unpaid purchase bills, by vendor, or one vendor's open bills. " +
      "Use it for: unpaid vendors, payables, what we owe, outstanding bills, overdue suppliers.",
    input_schema: unpaidSchema("vendor"),
    needsAny: ["purchase.view", "accounts.view", "finance.view"],
  },
  {
    name: "unpaid_invoices",
    description:
      "Look up what CUSTOMERS still owe the business: unpaid sales invoices, by customer, or one customer's open invoices. " +
      "Use it for: unpaid customers, receivables, who owes us, outstanding invoices, overdue customers.",
    input_schema: unpaidSchema("customer"),
    needsAny: ["sales.view", "accounts.view", "finance.view"],
  },
  {
    name: "stock_levels",
    description:
      "Look up stock on hand. With an item name, that item's quantity. With low_only, the items at or below their reorder level. " +
      "Use it for: stock of an item, how many are left, what is running low, what to reorder.",
    input_schema: {
      type: "object",
      properties: {
        item: { type: "string", description: "Only when the person named an item: its name as they typed it." },
        low_only: { type: "boolean", description: "True when they asked what is low, running out or needs reordering." },
      },
      required: [],
      additionalProperties: false,
    },
    needsAny: ["inventory.view"],
  },
  {
    name: "cash_and_bank",
    description: "Look up the balance of every cash and bank account. Use it for: cash in hand, bank balance, how much money we have.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    needsAny: ["banking.view", "finance.view", "accounts.view"],
  },
  {
    name: "profit_and_loss",
    description:
      "Look up the profit or loss for a period: revenue, gross profit and margin, expenses, net profit. " +
      "Use it for: profit, loss, how much did we make, income statement, P&L.",
    input_schema: {
      type: "object",
      properties: { period: { type: "string", enum: data.PERIODS, description: "The period the person asked about. this_month when they did not say." } },
      required: [],
      additionalProperties: false,
    },
    needsAny: ["reports.financial"],
  },
  {
    name: "balance_sheet",
    description: "Look up the balance sheet as at today: assets, liabilities and equity. ALWAYS use it when asked to show, see or give the balance sheet. Use it for: balance sheet, financial position, what we own and owe, net worth, equity.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
    needsAny: ["reports.financial"],
  },
  {
    name: "business_snapshot",
    description:
      "Look up the whole position at a glance: cash and bank, what customers owe, what is owed to vendors, and this period's profit or loss. " +
      "Use it for: how are we doing, how is the business, overall position, give me a summary.",
    input_schema: {
      type: "object",
      properties: { period: { type: "string", enum: data.PERIODS, description: "The period for the profit line. this_month when they did not say." } },
      required: [],
      additionalProperties: false,
    },
    needsAny: ["reports.financial"],
  },
  {
    name: "stock_alerts",
    description:
      "Look up what needs attention in stock: items out of stock or at their reorder level, and batches that have expired or expire soon. " +
      "Use it for: stock alerts, what to reorder, out of stock, expiring, expired items.",
    input_schema: {
      type: "object",
      properties: { within_days: { type: "number", description: "How far ahead to look for expiry, in days. 30 when the person did not say." } },
      required: [],
      additionalProperties: false,
    },
    needsAny: ["inventory.view", "reports.view"],
  },
  {
    name: "trade_totals",
    description:
      "Look up total sales or total purchases for a period, by customer or vendor (approved invoices less returns). " +
      "Use it for: sales this month, purchases last month, how much did we sell today, top customers this year.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["sales", "purchases"], description: "sales, or purchases." },
        period: { type: "string", enum: data.PERIODS, description: "The period the person asked about. this_month when they did not say." },
        party: { type: "string", description: "Only when the person named one customer or vendor: the name as they typed it." },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    needs: "reports.view",
    needsAny: ["sales.view", "purchase.view"],
  },
];

const grantsOf = (req) => req?.admin?.grants;
const mayUse = (def, req) => (!def.needs || roles.can(grantsOf(req), def.needs)) && roles.canAny(grantsOf(req), def.needsAny);

/** The tools to OFFER this person: none when the organisation switched lookups off, and only those they hold the keys for. */
function definitionsFor(req, settings) {
  if (settings && settings.lookupsEnabled === false) return [];
  return [...DEFINITIONS.filter((d) => mayUse(d, req)).map(({ needs, needsAny, ...def }) => def), ...van.lookupDefinitions(req)];
}

const names = () => [...DEFINITIONS.map((d) => d.name), ...van.LOOKUPS.map((d) => d.name)];
const isDataTool = (name) => names().includes(name);

const currencyOf = () => orgLocale.baseCurrency();
const answer = (built) => ok({ shown: true, reply: built.reply, table: built.table });
const choices = (side, found) =>
  ok({ needsChoice: true, choices: found.choices, reply: choiceReply(`Which ${side} do you mean?`, found.choices, found.more || 0, CLOSE) });

async function unpaid(type, input) {
  const side = type === "payable" ? "vendor" : "customer";
  const currency = currencyOf();
  const name = String(input[side] || "").trim();
  if (name) {
    const found = await findParty(side, name);
    if (found.error) return refused(found.error);
    if (found.choices) return choices(side, found);
    const rows = (await AgeingService.openInvoices({ type, partyId: found.party.id })).filter((r) => String(r.partyId) === found.party.id);
    const open = input.overdue_only ? rows.filter((r) => Number(r.daysPastDue) > 0) : rows;
    return answer(data.partyUnpaid(open, { side: type, name: found.party.name, currency }));
  }
  const rows = await AgeingService.openInvoices({ type });
  return answer(data.unpaidSummary(rows, { side: type, currency, overdueOnly: Boolean(input.overdue_only) }));
}

async function stock(input) {
  const search = String(input.item || "").trim();
  const filters = { itemType: "goods", status: "Active" };
  if (search) filters.search = search;
  if (input.low_only && !search) filters.lowStock = "true";
  const items = (await StockService.getAllStock(filters)).map((d) => (typeof d.toObject === "function" ? d.toObject() : d));
  return answer(data.stockTable(items, { lowOnly: Boolean(input.low_only), search }));
}

async function cash(req) {
  return answer(data.cashTable(await PaymentModeService.options(req), currencyOf()));
}

async function trade(input, req) {
  const kind = input.kind === "purchases" ? "purchases" : "sales";
  const key = kind === "purchases" ? "purchase.view" : "sales.view";
  if (!roles.can(grantsOf(req), key)) return refused(`Your role cannot see ${kind}. Ask an administrator.`);
  const period = data.periodOf(input.period, orgLocale.today());
  let partyId;
  let partyName = "";
  const name = String(input.party || "").trim();
  if (name) {
    const side = kind === "purchases" ? "vendor" : "customer";
    const found = await findParty(side, name);
    if (found.error) return refused(found.error);
    if (found.choices) return choices(side, found);
    partyId = found.party.id;
    partyName = found.party.name;
  }
  const summary = await TradeReportsService.summary({ direction: kind, from: period.from, to: period.to, groupBy: "party", partyId });
  return answer(data.tradeTable(summary, { direction: kind, period, currency: currencyOf(), party: partyName }));
}

// The statements read the ledger, which must be ready first (the report routes do the same through middleware/ledgerReady).
const ledgerReady = (req) => DefaultChartService.onOpenThrottled(req).catch(() => {});

async function profit(input, req) {
  await ledgerReady(req);
  const period = data.periodOf(input.period, orgLocale.today());
  const pl = await LedgerReportsService.profitAndLoss({ from: period.from, to: period.to });
  return answer(data.profitTable(pl, { period, currency: currencyOf() }));
}

async function balance(req) {
  await ledgerReady(req);
  const asOn = orgLocale.today();
  return answer(data.balanceTable(await FinancialService.getBalanceSheet(asOn), { asOn, currency: currencyOf() }));
}

async function snapshot(input, req) {
  await ledgerReady(req);
  const period = data.periodOf(input.period, orgLocale.today());
  const [options, payable, receivable, pl] = await Promise.all([
    PaymentModeService.options(req),
    AgeingService.openInvoices({ type: "payable" }),
    AgeingService.openInvoices({ type: "receivable" }),
    LedgerReportsService.profitAndLoss({ from: period.from, to: period.to }),
  ]);
  const sum = (rows, f = () => true) => data.round2(rows.filter(f).reduce((t, r) => t + Number(r.outstanding || 0), 0));
  const cash = data.round2([...options.cashAccounts, ...options.bankAccounts].reduce((t, a) => t + Number(a.balance || 0), 0));
  return answer(data.snapshotTable({
    cash,
    receivable: sum(receivable), payable: sum(payable),
    overdueReceivable: sum(receivable, (r) => Number(r.daysPastDue) > 0), overduePayable: sum(payable, (r) => Number(r.daysPastDue) > 0),
    profit: pl.netProfit, period,
  }, currencyOf()));
}

async function alerts(input) {
  const days = Math.min(365, Math.max(1, Math.round(Number(input.within_days)) || 30));
  const [reorder, expiry] = await Promise.all([StockReportsService.reorder({}), StockReportsService.expiry({ withinDays: days })]);
  return answer(data.stockAlertsTable(reorder, expiry, { days }));
}

/** Run one lookup for this person. Always resolves to { ok, data } or { ok: false, error }: a refusal is a result, not a throw. */
async function run(name, input, ctx, settings) {
  if (settings && settings.lookupsEnabled === false) return refused("Looking things up in your books is switched off for this organisation.");
  if (van.isLookup(name)) {
    try {
      return await van.runLookup(name, input && typeof input === "object" ? input : {}, ctx);
    } catch (err) {
      return refused(`I could not look that up just now: ${String(err?.message || err).slice(0, 160)}.`);
    }
  }
  const def = DEFINITIONS.find((d) => d.name === name);
  if (!def) return refused(`There is no tool called ${name}.`);
  if (!mayUse(def, ctx.req)) return refused("Your role cannot see that. Ask an administrator.");
  const args = input && typeof input === "object" ? input : {};
  try {
    if (name === "unpaid_bills") return await unpaid("payable", args);
    if (name === "unpaid_invoices") return await unpaid("receivable", args);
    if (name === "stock_levels") return await stock(args);
    if (name === "cash_and_bank") return await cash(ctx.req);
    if (name === "profit_and_loss") return await profit(args, ctx.req);
    if (name === "balance_sheet") return await balance(ctx.req);
    if (name === "business_snapshot") return await snapshot(args, ctx.req);
    if (name === "stock_alerts") return await alerts(args);
    return await trade(args, ctx.req);
  } catch (err) {
    return refused(`I could not look that up just now: ${String(err?.message || err).slice(0, 160)}.`);
  }
}

module.exports = { definitionsFor, isDataTool, run, names, DEFINITIONS };
