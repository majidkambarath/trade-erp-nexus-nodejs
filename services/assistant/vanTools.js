// Zarvia AI on the van (phase 6): four lookups and one prepare tool, offered only to people who hold van sales keys.
//
// The two rules of the assistant hold here exactly as in dataTools.js and actionTools.js:
//   - a LOOKUP's figures never go to the AI service: the server reads the van and writes the answer and the table
//     (utils/vanAssistant.js); the model only picked the question (and, for a supervisor, a van code);
//   - a PREPARED sale is a proposal: the exact body POST /van-sales/trips/:tripId/sell takes. The card's button posts
//     it from the salesman's own phone with their own sign-in, so the van's rules (stock on the van, price lists,
//     credit, promotions, the period lock) decide. Nothing here writes.
const mongoose = require("mongoose");
const roles = require("../../utils/permissions");
const proposals = require("../../utils/assistantProposals");
const tables = require("../../utils/vanAssistant");
const orgLocale = require("../../utils/orgLocale");
const VanTrip = require("../../models/modules/vansales/vanTripModel");
const VanRoute = require("../../models/modules/vansales/vanRouteModel");
const AgeingService = require("../financial/ageingService");
const { findParty, choiceReply } = require("./partyLookup");

const ok = (d) => ({ ok: true, data: d });
const refused = (error) => ({ ok: false, error });
const grantsOf = (req) => req?.admin?.grants;
const VIEW = ["vansales.view", "vansales.sell"];
const vanArg = {
  van: { type: "string", description: "Only when the person named a van by its code (VAN-2): the code as typed. Leave out for their own van." },
};

const LOOKUPS = [
  {
    name: "van_stock",
    description: "Look up what is on a van right now (goods left to sell, and damaged goods brought back). Use it for: what is on my van, what have I got left, van stock.",
    input_schema: { type: "object", properties: vanArg, required: [], additionalProperties: false },
    needsAny: VIEW,
  },
  {
    name: "route_owing",
    description: "Look up which customers on the van's route still owe money, and how much is overdue. Use it for: who on my route owes, who should pay me today, collections on the route.",
    input_schema: { type: "object", properties: vanArg, required: [], additionalProperties: false },
    needsAny: VIEW,
  },
  {
    name: "route_not_visited",
    description: "Look up the stops on the van's route not called on yet today. Use it for: who is left, who have I not visited, remaining stops.",
    input_schema: { type: "object", properties: vanArg, required: [], additionalProperties: false },
    needsAny: VIEW,
  },
  {
    name: "van_suggested_load",
    description: "Look up what to load on the van for its route, worked out from the route's orders and its past runs. Use it for: what should I load, suggested load, what do I need tomorrow.",
    input_schema: { type: "object", properties: vanArg, required: [], additionalProperties: false },
    needsAny: ["vansales.load", "vansales.sell"],
  },
];

const PREPARE = [
  {
    name: "prepare_van_sale",
    description:
      "Prepare a sale FROM THE VAN to a customer, from what is on the van, at the customer's own price. Nothing is saved: the salesman checks the card and confirms. " +
      "Use it for: sell 10 rice to Al Noor, give Corner Shop 5 cartons of oil.",
    input_schema: {
      type: "object",
      properties: {
        customer: { type: "string", description: "The customer's name as the person typed it." },
        lines: {
          type: "array",
          description: "What to sell. One entry per item.",
          items: {
            type: "object",
            properties: { item: { type: "string", description: "The item's name as typed." }, qty: { type: "number", description: "How many." } },
            required: ["item", "qty"],
            additionalProperties: false,
          },
        },
        cash: { type: "boolean", description: "True only if the person said the customer pays in cash now." },
      },
      required: ["customer", "lines"],
      additionalProperties: false,
    },
    needsAny: ["vansales.sell"],
  },
];

const mayUse = (def, req) => roles.canAny(grantsOf(req), def.needsAny);
const lookupDefinitions = (req) => LOOKUPS.filter((d) => mayUse(d, req)).map(({ needsAny, ...d }) => d);
const prepareDefinitions = (req) => PREPARE.filter((d) => mayUse(d, req)).map(({ needsAny, ...d }) => d);
const isLookup = (name) => LOOKUPS.some((d) => d.name === name);
const isPrepare = (name) => PREPARE.some((d) => d.name === name);

/**
 * The trip the question is about: the person's own open trip, or - for someone who supervises the vans - the open
 * trip of the van named. A salesman naming another van is answered about nothing: that is not their van.
 */
async function tripFor(req, vanCode) {
  const VanTripService = require("../vansales/vanTripService");
  const me = String(req?.admin?.id || "");
  // (a salesman holds view with selling, so view alone does not supervise: utils/vanSales.js isSellerOnly)
  const supervises = !require("../../utils/vanSales").isSellerOnly(grantsOf(req)) && roles.canAny(grantsOf(req), ["vansales.manage", "vansales.settle", "vansales.view"]) && !!vanCode;
  const q = { status: { $in: ["LOADING", "ON_ROUTE", "UNLOADED"] } };
  if (vanCode) q.vanCode = String(vanCode).trim().toUpperCase();
  if (!supervises) q.salesmanId = me;
  const t = await VanTrip.findOne(q).sort({ status: 1, date: -1 });
  if (!t) return null;
  const shown = await VanTripService.present(t);
  return { ...shown, mine: String(t.salesmanId) === me };
}

async function runLookup(name, input, ctx) {
  const def = LOOKUPS.find((d) => d.name === name);
  if (!def || !mayUse(def, ctx.req)) return refused("Your role cannot see that. Ask an administrator.");
  const trip = await tripFor(ctx.req, input?.van);
  const answer = (built) => ok({ shown: true, reply: built.reply, table: built.table });
  if (input?.van && !trip) return answer({ reply: `No open trip was found for ${String(input.van).toUpperCase()} that you can see.`, table: null });
  if (name === "van_stock") return answer(tables.vanStockTable(trip));
  if (name === "route_not_visited") return answer(tables.notVisitedTable(trip));
  if (name === "van_suggested_load") {
    if (!trip) return answer(tables.suggestedLoadTable(null));
    const VanPlanningService = require("../vansales/vanPlanningService");
    return answer(tables.suggestedLoadTable(trip, await VanPlanningService.suggestedLoad(trip.id)));
  }
  // route_owing
  if (!trip) return answer(tables.routeOwingTable(null));
  const route = trip.routeId ? await VanRoute.findById(trip.routeId).select("customers").lean() : null;
  const ids = new Set((route?.customers || []).map((c) => String(c.customerId)));
  const open = ids.size ? (await AgeingService.openInvoices({ type: "receivable" })).filter((r) => ids.has(String(r.partyId))) : [];
  return answer(tables.routeOwingTable(trip, open, orgLocale.baseCurrency()));
}

/** "sell 10 rice to Al Noor": a proposal for POST /van-sales/trips/:tripId/sell, priced for the customer. */
async function prepareSale(input, ctx, push) {
  const trip = await tripFor(ctx.req);
  if (!trip || trip.status !== "ON_ROUTE") return refused("You have no van out on the road right now, so there is nothing to sell from.");
  const found = await findParty("customer", input.customer);
  if (found.error) return refused(found.error);
  if (found.choices) return ok({ needsChoice: true, choices: found.choices, more: found.more || 0, reply: choiceReply("Which customer do you mean?", found.choices, found.more) });
  const wanted = Array.isArray(input.lines) ? input.lines.slice(0, 20) : [];
  if (!wanted.length) return refused("What should I sell, and how many?");

  const VanTripSales = require("../vansales/vanTripSales");
  const prices = new Map((await VanTripSales.prices(trip.id, found.party.id)).map((p) => [p.stockId, p.price]));
  const lines = [];
  for (const w of wanted) {
    const qty = Number(w.qty);
    if (!Number.isFinite(qty) || qty <= 0) return refused(`How many ${w.item}?`);
    const r = proposals.rankByName(trip.sellable || [], w.item, (s) => s.itemName);
    if (r.choices) return ok({ needsChoice: true, choices: r.choices.map((c) => c.name), reply: choiceReply(`Which item is "${w.item}"?`, r.choices.map((c) => c.name)) });
    if (!r.match) return refused(`"${w.item}" is not on the van. Ask "what is on my van" to see what is.`);
    if (qty > Number(r.match.qty) + 1e-9) return refused(`Only ${r.match.qty} of ${r.match.itemName} is on the van.`);
    lines.push({ itemId: r.match.stockId, name: r.match.itemName, qty, price: prices.get(r.match.stockId) ?? r.match.salesPrice });
  }
  const currency = orgLocale.baseCurrency();
  const total = proposals.round2(lines.reduce((t, l) => t + l.qty * Number(l.price || 0), 0));
  const body = { tripId: trip.id, customerId: found.party.id, items: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, price: l.price })), ...(input.cash ? { payNow: { mode: "cash", full: true } } : {}) };
  const proposal = push(ctx, {
    kind: "van_sale", endpoint: "van_sale", title: "Sale from the van", confirm: `Sell to ${found.party.name}`,
    lines: [["Customer", found.party.name], ...lines.map((l) => [l.name, `${l.qty} x ${Number(l.price).toFixed(2)}`]), ["Paid", input.cash ? "Cash now, in full" : "On credit"]],
    body, missing: [], warnings: [`About ${currency} ${total.toFixed(2)} before tax. Offers, tax and the customer's credit are applied when you confirm.`], prefill: null,
  });
  return ok({
    prepared: true, proposal: proposal.id, for: found.party.name,
    reply: `I have prepared a sale to ${found.party.name} from ${trip.vanCode}: ${lines.map((l) => `${l.qty} x ${l.name}`).join(", ")}. Check the card and press the button to sell. Nothing is sold until you do.`,
  });
}

module.exports = { LOOKUPS, PREPARE, lookupDefinitions, prepareDefinitions, isLookup, isPrepare, runLookup, prepareSale, tripFor, isId: mongoose.isValidObjectId };
