// The tools that let Zarvia AI PREPARE a payment, a receipt, an expense or a draft invoice.
//
// THE RULE: the assistant prepares, the person saves. Nothing in this file writes anything. A tool reads
// through the product's own services - as the signed-in person, inside their organisation - and returns a
// PROPOSAL: the exact body the normal route takes, plus readable lines for a card in the chat. The card's
// button posts that body to the normal route from the person's own browser, with their own sign-in, so every
// existing rule applies unchanged (permissions, approval limits, the period lock, reference numbers, bill
// allocation checks, plan limits, audit). A tampered body is no worse than the person calling the route.
//
// toolkit.js stays pure and keeps its "no database query" test: this is the one place that reads the books,
// and it is only OFFERED to the model when the organisation switched it on and the person holds the keys.
//
// The server resolves everything it can (the vendor by name, the bills, the account) so a small open model
// needs ONE call per document. When a name matches several things the answer is CHOICES, never a guess.
const roles = require("../../utils/permissions");
const rules = require("../../utils/assistantProposals");
const orgLocale = require("../../utils/orgLocale");
const { live, choiceReply, findParty, sameName } = require("./partyLookup");
const StockService = require("../stock/stockService");
const AgeingService = require("../financial/ageingService");
const PaymentModeService = require("../banking/paymentModeService");
const ChartOfAccountsService = require("../financial/chartOfAccountsService");
const TaxCodeService = require("../financial/taxCodeService");
const { getTenant } = require("../../utils/tenant");
const van = require("./vanTools");

const MAX_PROPOSALS_PER_TURN = 3;
const MAX_INVOICE_LINES = 20;

const ok = (data) => ({ ok: true, data });
const refused = (error) => ({ ok: false, error });
const fmt = (n, currency) => `${currency} ${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the answer says about a prepared document. Written here, from the books, never by the model. */
const READY = "Check the details below and press the button to confirm. Nothing is saved until you do.";
const readyReply = (what, missing, extra = "") =>
  `I have prepared ${what}.${extra ? ` ${extra}` : ""} ${missing.length ? `Enter the ${missing.join(" and ")} on the card first, then check the details and press the button to confirm.` : READY}`;

const paymentSchema = (party) => ({
  type: "object",
  properties: {
    [party]: { type: "string", description: `The ${party}'s name as the person said it. A part of the name is enough.` },
    amount: { type: "number", description: "The amount in the organisation's own currency. Leave out if the person did not say." },
    method: { type: "string", description: "cash, bank, or bank transfer. Leave out if the person did not say; it defaults to cash." },
    account: { type: "string", description: "Which bank or cash account, only if the person named one." },
    reference: { type: "string", description: "The transfer or deposit slip reference. Needed for bank and transfer: ask for it." },
    date: { type: "string", description: "YYYY-MM-DD. Leave out for today." },
    note: { type: "string", description: "A note for the narration, only if the person gave one." },
  },
  required: [party],
  additionalProperties: false,
});

const partySchema = (kind) => ({
  type: "object",
  properties: {
    name: { type: "string", description: `The new ${kind}'s name exactly as the person said it.` },
    contact_person: { type: "string", description: "Who to deal with there, only if the person said." },
    phone: { type: "string", description: "Phone number, only if the person gave one." },
    email: { type: "string", description: "Email address, only if the person gave one." },
    address: { type: "string", description: "Address, only if the person gave one." },
    tax_number: { type: "string", description: "Tax registration number (TRN or GSTIN), only if the person gave one." },
  },
  required: ["name"],
  additionalProperties: false,
});

const DEFINITIONS = [
  {
    name: "prepare_payment",
    description:
      "Prepare a payment to a vendor for the person to check and confirm. Use it when they ask to pay, settle or clear a vendor. " +
      "It finds the vendor and their open bills itself. It saves NOTHING: the person confirms on a card.",
    input_schema: paymentSchema("vendor"),
    strict: true,
    needs: ["finance.create"],
    needsAny: ["purchase.view", "accounts.view"],
  },
  {
    name: "prepare_receipt",
    description:
      "Prepare a receipt of money from a customer for the person to check and confirm. Use it when they say a customer paid or ask to record money received. " +
      "It finds the customer and their open invoices itself. It saves NOTHING: the person confirms on a card.",
    input_schema: paymentSchema("customer"),
    strict: true,
    needs: ["finance.create"],
    needsAny: ["sales.view", "accounts.view"],
  },
  {
    name: "prepare_expense",
    description:
      "Prepare an expense (fuel, rent, a repair, office supplies) for the person to check and confirm. Pick the expense account by the name they used. " +
      "It saves NOTHING: the person confirms on a card.",
    input_schema: {
      type: "object",
      properties: {
        account: { type: "string", description: "The kind of expense, for example fuel, rent, repairs. A part of the account name is enough." },
        amount: { type: "number", description: "The amount before tax. Leave out if the person did not say." },
        description: { type: "string", description: "What it was for, in a few words. Leave out if the person did not say." },
        method: { type: "string", description: "cash, bank, or bank transfer. Defaults to cash." },
        paid_from: { type: "string", description: "Which bank or cash account paid it, only if the person named one." },
        reference: { type: "string", description: "The reference, needed for bank and transfer." },
        date: { type: "string", description: "YYYY-MM-DD. Leave out for today." },
        with_vat: { type: "boolean", description: "True only if the person said VAT or tax applies on top." },
      },
      required: ["account"],
      additionalProperties: false,
    },
    strict: true,
    needs: ["finance.create"],
    needsAny: [],
  },
  {
    name: "prepare_customer",
    description:
      "Prepare a NEW customer for the person to check and confirm. Use it when they ask to add or create a customer. " +
      "It saves NOTHING: the person confirms on a card.",
    input_schema: partySchema("customer"),
    strict: true,
    needs: ["sales.create"],
    needsAny: [],
  },
  {
    name: "prepare_vendor",
    description:
      "Prepare a NEW vendor (supplier) for the person to check and confirm. Use it when they ask to add or create a vendor or supplier. " +
      "It saves NOTHING: the person confirms on a card.",
    input_schema: partySchema("vendor"),
    strict: true,
    needs: ["purchase.create"],
    needsAny: [],
  },
  {
    name: "prepare_invoice",
    description:
      "Prepare a sales invoice for a customer, as a DRAFT, for the person to check and confirm. Use it when they ask to invoice or bill a customer. " +
      "Nothing is posted until the invoice is approved on the Sales invoices screen. It saves NOTHING by itself.",
    input_schema: {
      type: "object",
      properties: {
        customer: { type: "string", description: "The customer's name as the person said it." },
        lines: {
          type: "array",
          description: "What is being sold.",
          items: {
            type: "object",
            properties: {
              item: { type: "string", description: "The item's name as the person said it." },
              qty: { type: "number", description: "How many." },
              price: { type: "number", description: "The unit price, only if the person gave one. Otherwise the item's own price is used." },
            },
            required: ["item", "qty"],
            additionalProperties: false,
          },
        },
        date: { type: "string", description: "YYYY-MM-DD. Leave out for today." },
        note: { type: "string", description: "A note for the invoice, only if the person gave one." },
      },
      required: ["customer", "lines"],
      additionalProperties: false,
    },
    strict: true,
    needs: ["sales.create"],
    needsAny: [],
  },
];

const grantsOf = (req) => req?.admin?.grants;
const mayUse = (def, req) => roles.can(grantsOf(req), def.needs[0]) && (!def.needsAny.length || roles.canAny(grantsOf(req), def.needsAny));

/** The tools to OFFER this person right now: none unless the organisation switched actions on, and only those they hold the keys for. */
function definitionsFor(req, settings) {
  if (!settings?.actionsEnabled) return [];
  return [...DEFINITIONS.filter((d) => mayUse(d, req)).map(({ needs, needsAny, ...def }) => def), ...van.prepareDefinitions(req)];
}

const names = () => [...DEFINITIONS.map((d) => d.name), ...van.PREPARE.map((d) => d.name)];
const isActionTool = (name) => names().includes(name);

// ---- lookups, all through the product's own services --------------------------------------------

async function findAccount(req, mode, hint) {
  const opts = await PaymentModeService.options(req);
  const list = mode === "cash" ? opts.cashAccounts : opts.bankAccounts;
  if (!list.length) {
    if (mode === "cash") return { account: null };
    return { error: "There is no bank account set up. Add one under Banks, or pay in cash." };
  }
  if (hint) {
    const r = rules.rankByName(list, hint, (a) => a.accountName, (a) => a._id);
    if (r.match) return { account: { id: String(r.match._id), name: r.match.accountName } };
    if (r.choices) return { choices: r.choices.map((c) => c.name) };
    return { error: `No ${mode === "cash" ? "cash" : "bank"} account matches "${hint}". Available: ${list.slice(0, 5).map((a) => a.accountName).join(", ")}.` };
  }
  if (list.length === 1 || mode === "cash") return { account: { id: String(list[0]._id), name: list[0].accountName } };
  return { choices: list.slice(0, rules.MAX_CHOICES).map((a) => a.accountName), ask: "Which bank account should it come from?" };
}

async function openBills(kind, partyId) {
  const rows = await AgeingService.openInvoices({ type: kind === "vendor" ? "payable" : "receivable", partyId });
  return rows
    .filter((r) => String(r.partyId) === String(partyId))
    .map((r) => ({ id: String(r.transactionId), number: r.transactionNo, outstanding: r.outstanding, date: r.date }));
}

// ---- the tools ---------------------------------------------------------------------------------

const push = (ctx, proposal) => {
  const p = { id: `p${ctx.proposals.length + 1}`, ...proposal };
  ctx.proposals.push(p);
  return p;
};

const todayOf = () => orgLocale.today();
const currencyOf = () => orgLocale.baseCurrency();

const needRoom = (ctx) => (ctx.proposals.length >= MAX_PROPOSALS_PER_TURN ? "That is enough to check at once. Confirm these first, then ask for the next." : null);

async function preparePartyVoucher(kind, input, ctx) {
  const side = kind === "payment" ? "vendor" : "customer";
  const room = needRoom(ctx);
  if (room) return refused(room);
  const amount = rules.checkAmount(input.amount);
  if (!amount.ok) return refused(amount.reason);
  const date = rules.checkDate(input.date, todayOf());
  if (!date.ok) return refused(date.reason);
  const mode = rules.normaliseMode(input.method);
  if (!mode.ok) return refused(mode.reason);

  const found = await findParty(side, input[side]);
  if (found.error) return refused(found.error);
  if (found.choices) return ok({ needsChoice: true, choices: found.choices, more: found.more || 0, reply: choiceReply(`Which ${side} do you mean?`, found.choices, found.more) });
  const acct = await findAccount(ctx.req, mode.mode, input.account);
  if (acct.error) return refused(acct.error);
  if (acct.choices) return ok({ needsChoice: true, choices: acct.choices, reply: choiceReply(acct.ask || "Which account should it be?", acct.choices) });

  const bills = await openBills(side, found.party.id);
  const { allocations, onAccount } = rules.allocateOldestFirst(bills, amount.amount);
  const make = kind === "payment" ? rules.paymentBody : rules.receiptBody;
  const built = make({
    [`${side}Id`]: found.party.id, [`${side}Name`]: found.party.name,
    date: date.date, amount: amount.amount, allocations, mode: mode.mode,
    accountId: acct.account?.id, reference: input.reference, note: input.note,
  });
  const currency = currencyOf();
  const reference = built.body.paymentDetails.reference || "";
  const warnings = [];
  if (!bills.length) warnings.push(`${found.party.name} has no open ${kind === "payment" ? "bills" : "invoices"}, so the whole amount would go on account.`);
  else if (onAccount > 0.004) warnings.push(`${fmt(onAccount, currency)} is more than they have open, so it would go on account.`);
  const verb = kind === "payment" ? `Pay ${fmt(amount.amount, currency)} to ${found.party.name}` : `Record ${fmt(amount.amount, currency)} from ${found.party.name}`;
  const proposal = push(ctx, {
    kind, endpoint: "voucher", title: kind === "payment" ? "Payment" : "Receipt", confirm: verb,
    lines: rules.proposalLines(kind, { partyName: found.party.name, amount: amount.amount, methodLabel: rules.METHOD_LABEL[mode.mode], accountName: acct.account?.name, reference, date: date.date, allocations, onAccount }, currency),
    body: built.body, missing: built.missing, warnings,
    // What the full form needs to open already filled in.
    prefill: { partyId: found.party.id, amount: amount.amount, date: date.date, mode: mode.mode, accountId: acct.account?.id || "", reference, narration: built.body.narration, allocations },
  });
  const what = kind === "payment" ? `a payment of ${fmt(amount.amount, currency)} to ${found.party.name}` : `a receipt of ${fmt(amount.amount, currency)} from ${found.party.name}`;
  const settles = allocations.length ? `It settles ${allocations.map((a) => a.number).filter(Boolean).join(" and ")}.` : "";
  return ok({
    prepared: true, proposal: proposal.id, for: found.party.name, amount: amount.amount, how: rules.METHOD_LABEL[mode.mode],
    account: acct.account?.name || null, settles: allocations.map((a) => `${a.number} ${a.amount}`), onAccount,
    stillNeeded: built.missing, warnings,
    reply: readyReply(what, built.missing, settles),
  });
}

async function prepareExpense(input, ctx) {
  const room = needRoom(ctx);
  if (room) return refused(room);
  const amount = rules.checkAmount(input.amount);
  if (!amount.ok) return refused(amount.reason);
  const date = rules.checkDate(input.date, todayOf());
  if (!date.ok) return refused(date.reason);
  const mode = rules.normaliseMode(input.method);
  if (!mode.ok) return refused(mode.reason);

  const accounts = (await ChartOfAccountsService.listPostable(ctx.req)).filter((a) => a.category === "EXPENSE");
  const r = rules.rankByName(accounts, input.account, (a) => a.accountName, (a) => a._id);
  if (r.choices) return ok({ needsChoice: true, choices: r.choices.map((c) => c.name), reply: choiceReply("Which expense account do you mean?", r.choices.map((c) => c.name)) });
  if (!r.match) return refused(`I could not find an expense account called "${input.account}". What kind of expense is it?`);
  // "fuel 150" says what it was for: the account is the description unless the person gave a better one.
  const description = String(input.description || "").trim() || r.match.accountName;
  const acct = await findAccount(ctx.req, mode.mode, input.paid_from);
  if (acct.error) return refused(acct.error);
  if (acct.choices) return ok({ needsChoice: true, choices: acct.choices, reply: choiceReply(acct.ask || "Which account paid it?", acct.choices) });

  let taxCodeId;
  if (input.with_vat) {
    const code = await TaxCodeService.defaultStandard(getTenant(ctx.req).companyId);
    if (!code) return refused("There is no standard tax code set up, so VAT cannot be added. Leave VAT out or set one up in Accounting setup.");
    taxCodeId = code._id;
  }
  const built = rules.expenseBody({ accountId: r.match._id, date: date.date, amount: amount.amount, description, mode: mode.mode, payAccountId: acct.account?.id, reference: input.reference, taxCodeId });
  const currency = currencyOf();
  const reference = built.body.paymentDetails.reference || "";
  const proposal = push(ctx, {
    kind: "expense", endpoint: "voucher", title: "Expense", confirm: `Record ${fmt(amount.amount, currency)} ${r.match.accountName}`,
    lines: rules.proposalLines("expense", { accountName: r.match.accountName, description, amount: amount.amount, methodLabel: rules.METHOD_LABEL[mode.mode], payAccountName: acct.account?.name, reference, date: date.date }, currency),
    body: built.body, missing: built.missing, warnings: taxCodeId ? ["VAT will be added on top of this amount."] : [],
    prefill: { accountId: String(r.match._id), amount: amount.amount, date: date.date, description, mode: mode.mode, payAccountId: acct.account?.id || "", reference },
  });
  return ok({
    prepared: true, proposal: proposal.id, expense: r.match.accountName, amount: amount.amount, how: rules.METHOD_LABEL[mode.mode], stillNeeded: built.missing,
    reply: readyReply(`an expense of ${fmt(amount.amount, currency)} for ${r.match.accountName}`, built.missing),
  });
}

async function prepareParty(kind, input, ctx) {
  const room = needRoom(ctx);
  if (room) return refused(room);
  const name = String(input.name || "").replace(/\s+/g, " ").trim();
  if (name.length < 2) return refused(`What is the ${kind}'s name?`);
  if (name.length > 100) return refused("A name can be at most 100 characters.");
  const same = await sameName(kind, name);
  if (same.exact) {
    return ok({ exists: true, reply: `There is already a ${kind} called ${same.exact}, so I have not prepared another. Ask me about it, or give the new one a different name.` });
  }
  const built = rules.partyBody(kind, { name, contactPerson: input.contact_person, phone: input.phone, email: input.email, address: input.address, trn: input.tax_number });
  const warnings = same.similar.length ? [`Similar names already exist: ${same.similar.join(", ")}. Check this is not a duplicate.`] : [];
  const proposal = push(ctx, {
    kind, endpoint: "party", title: kind === "vendor" ? "New vendor" : "New customer", confirm: `Add ${kind} ${name}`,
    lines: rules.partyLines(kind, built.body), body: built.body, missing: built.missing, warnings, prefill: null,
  });
  return ok({
    prepared: true, proposal: proposal.id, for: name, stillNeeded: built.missing,
    reply: readyReply(`a new ${kind}, ${name}`, built.missing),
  });
}

async function prepareInvoice(input, ctx) {
  const room = needRoom(ctx);
  if (room) return refused(room);
  const date = rules.checkDate(input.date, todayOf());
  if (!date.ok) return refused(date.reason);
  const wanted = Array.isArray(input.lines) ? input.lines : [];
  if (!wanted.length) return refused("What should the invoice be for?");
  if (wanted.length > MAX_INVOICE_LINES) return refused(`An invoice prepared here has at most ${MAX_INVOICE_LINES} lines.`);

  const found = await findParty("customer", input.customer);
  if (found.error) return refused(found.error);
  if (found.choices) return ok({ needsChoice: true, choices: found.choices, more: found.more || 0, reply: choiceReply("Which customer do you mean?", found.choices, found.more) });

  const lines = [];
  for (const w of wanted) {
    const qty = Number(w.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1e7) return refused(`How many ${w.item}?`);
    const rows = live(await StockService.getAllStock({ search: String(w.item || "").trim() }));
    const r = rules.rankByName(rows, w.item, (s) => s.itemName);
    if (r.choices) return ok({ needsChoice: true, choices: r.choices.map((c) => c.name), reply: choiceReply(`Which item is "${w.item}"?`, r.choices.map((c) => c.name)) });
    if (!r.match) return refused(`I could not find an item called "${w.item}". Tell me the name as it appears in Zarvia.`);
    let price = w.price;
    if (price === undefined || price === null || price === "") price = r.match.salesPrice;
    const p = rules.checkAmount(price);
    if (!p.ok) return refused(`"${r.match.itemName}" has no selling price. What price should I use?`);
    lines.push({ itemId: String(r.match._id), name: r.match.itemName, qty, price: p.amount });
  }
  const built = rules.invoiceBody({ customerId: found.party.id, date: date.date, lines, note: input.note });
  const currency = currencyOf();
  const total = rules.round2(lines.reduce((t, l) => t + l.qty * l.price, 0));
  const proposal = push(ctx, {
    kind: "invoice", endpoint: "transaction", title: "Invoice (draft)", confirm: `Create draft invoice for ${found.party.name}`,
    lines: rules.proposalLines("invoice", { partyName: found.party.name, lines, date: date.date }, currency),
    body: built.body, missing: [], warnings: [`About ${fmt(total, currency)} before tax. The system adds tax when it prices the invoice.`],
    prefill: null,
  });
  return ok({
    prepared: true, proposal: proposal.id, for: found.party.name, lines: lines.map((l) => `${l.qty} x ${l.name} at ${l.price}`),
    reply: `I have prepared a draft invoice for ${found.party.name}: ${lines.map((l) => `${l.qty} x ${l.name}`).join(", ")}. It is only a draft until it is approved. ${READY}`,
  });
}

/** Run one action tool for this person. Always resolves to { ok, data } or { ok: false, error }: a refusal is a result, not a throw. */
async function run(name, input, ctx, settings) {
  if (!settings?.actionsEnabled) return refused("Preparing documents is switched off for this organisation.");
  if (van.isPrepare(name)) {
    if (!roles.canAny(grantsOf(ctx.req), ["vansales.sell"])) return refused("Your role cannot do that. Ask an administrator.");
    const room = needRoom(ctx);
    if (room) return refused(room);
    try {
      return await van.prepareSale(input && typeof input === "object" ? input : {}, ctx, push);
    } catch (err) {
      return refused(`That did not work: ${String(err?.message || err).slice(0, 160)}. Nothing was prepared.`);
    }
  }
  const def = DEFINITIONS.find((d) => d.name === name);
  if (!def) return refused(`There is no tool called ${name}.`);
  if (!mayUse(def, ctx.req)) return refused("Your role cannot do that. Ask an administrator.");
  const args = input && typeof input === "object" ? input : {};
  try {
    if (name === "prepare_payment") return await preparePartyVoucher("payment", args, ctx);
    if (name === "prepare_receipt") return await preparePartyVoucher("receipt", args, ctx);
    if (name === "prepare_expense") return await prepareExpense(args, ctx);
    if (name === "prepare_customer") return await prepareParty("customer", args, ctx);
    if (name === "prepare_vendor") return await prepareParty("vendor", args, ctx);
    return await prepareInvoice(args, ctx);
  } catch (err) {
    return refused(`That did not work: ${String(err?.message || err).slice(0, 160)}. Nothing was prepared.`);
  }
}

module.exports = { definitionsFor, isActionTool, run, names, MAX_PROPOSALS_PER_TURN, DEFINITIONS };
