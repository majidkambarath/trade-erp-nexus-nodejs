// What Zarvia AI PREPARES when a person asks it to pay, receive, record an expense or invoice.
// Pure: no database, no clock (the caller passes today), so every rule is a test.
//
// The rule everything rests on: the assistant prepares, the person saves. A proposal is the exact body
// the product's own route takes (POST /vouchers/vouchers, POST /transactions/transactions), plus readable
// lines for a card. Nothing here writes anything, and the body is posted by the person's own browser with
// their own sign-in, so every existing rule (permissions, approval limits, the period lock, reference
// numbers, allocation checks) applies exactly as if they had typed it on the screen.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const MAX_AMOUNT = 1e11;
const MAX_CHOICES = 5;

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Find one thing by the name a person typed. Exact beats "starts with" beats "contains"; the best tier
 * that has anything decides. One in that tier is the match, several are CHOICES for the person to pick
 * from (never a guess: paying the wrong vendor is the mistake this exists to prevent).
 * -> { match } | { choices: [{ id, name }] } | { none: true }
 */
function rankByName(items, query, nameOf = (x) => x.name, idOf = (x) => x._id) {
  const q = norm(query);
  if (!q) return { none: true };
  const tiers = [[], [], []];
  for (const item of items || []) {
    const n = norm(nameOf(item));
    if (!n) continue;
    if (n === q) tiers[0].push(item);
    else if (n.startsWith(q)) tiers[1].push(item);
    else if (n.includes(q)) tiers[2].push(item);
  }
  const best = tiers.find((t) => t.length);
  if (!best) return { none: true };
  if (best.length === 1) return { match: best[0] };
  // Alphabetical, so the same question always offers the same list in the same order (the services return newest first).
  const ordered = [...best].sort((a, b) => String(nameOf(a)).localeCompare(String(nameOf(b))));
  return { choices: ordered.slice(0, MAX_CHOICES).map((x) => ({ id: String(idOf(x)), name: String(nameOf(x)) })), more: Math.max(0, best.length - MAX_CHOICES) };
}

/** A positive money amount with at most two decimals. A figure typed with commas ("5,000.50") is read as 5000.5. */
function checkAmount(value) {
  const text = typeof value === "string" ? value.replace(/[,\s]/g, "") : value;
  const n = Number(text);
  if (text === "" || text === null || text === undefined || !Number.isFinite(n)) return { ok: false, reason: "How much should it be?" };
  if (n <= 0) return { ok: false, reason: "The amount must be more than zero." };
  if (n > MAX_AMOUNT) return { ok: false, reason: "That amount is too large." };
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return { ok: false, reason: "An amount has at most two decimals." };
  return { ok: true, amount: round2(n) };
}

/** A real calendar day as "YYYY-MM-DD"; nothing given means today. */
function checkDate(value, today) {
  if (value === undefined || value === null || value === "") return { ok: true, date: today };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (!m) return { ok: false, reason: "A date is written year-month-day, for example 2026-11-16." };
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    return { ok: false, reason: "That date does not exist." };
  }
  return { ok: true, date: `${m[1]}-${m[2]}-${m[3]}` };
}

/**
 * Settle the oldest bills first, the way the voucher form does. `invoices` are
 * { id, number, outstanding, date }; the result's `balance` is what each bill will still owe, which the
 * server checks against the stored figure (it refuses a stale one).
 * -> { allocations: [{ invoiceId, number, amount, balance }], onAccount }
 */
function allocateOldestFirst(invoices, amount) {
  let left = round2(amount);
  const allocations = [];
  // A date may arrive as a Date or an ISO string. Compared as moments: the text of a Date ("Tue Oct 07...")
  // does not sort in time order, which would settle the newer bill before the older one.
  const when = (d) => {
    const t = new Date(d).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const ordered = [...(invoices || [])]
    .filter((i) => Number(i.outstanding) > 0.005)
    .sort((a, b) => when(a.date) - when(b.date) || String(a.number || "").localeCompare(String(b.number || "")));
  for (const inv of ordered) {
    if (left <= 0.004) break;
    const owed = round2(inv.outstanding);
    const pay = round2(Math.min(left, owed));
    allocations.push({ invoiceId: String(inv.id), number: inv.number || "", amount: pay, balance: round2(owed - pay) });
    left = round2(left - pay);
  }
  return { allocations, onAccount: round2(left) };
}

const CASH_LIKE = new Set(["cash"]);
const REFERENCE_MODES = new Set(["bank", "transfer"]);
const SUPPORTED_MODES = new Set(["cash", "bank", "transfer"]);

/** Words a person uses, mapped to the product's payment modes. null = a mode the assistant does not prepare. */
function normaliseMode(value) {
  const v = norm(value);
  if (!v) return { ok: true, mode: "cash", assumed: true };
  if (["cash", "in cash"].includes(v)) return { ok: true, mode: "cash" };
  if (["bank", "bank payment", "bank deposit", "deposit"].includes(v)) return { ok: true, mode: "bank" };
  if (["transfer", "bank transfer", "online", "wire", "neft", "rtgs", "upi", "iban"].includes(v)) return { ok: true, mode: "transfer" };
  if (["cheque", "check", "card", "credit card", "debit card"].includes(v)) {
    return { ok: false, reason: `Cheques and cards need more details than I can prepare. Open the payment screen and choose ${v} there.` };
  }
  return { ok: false, reason: "Choose cash, bank or bank transfer." };
}

/** { paymentMode, paymentDetails, missing[] } for a method, the account chosen and the reference given. */
function modeFields({ mode, accountId, reference }) {
  const paymentDetails = {};
  if (accountId) paymentDetails.accountId = String(accountId);
  const ref = String(reference ?? "").trim();
  if (ref) paymentDetails.reference = ref.slice(0, 60);
  const missing = [];
  if (REFERENCE_MODES.has(mode) && !ref) missing.push("reference");
  return { paymentMode: mode, paymentDetails, missing };
}

const narrationOf = (note, fallback) => String(note || fallback || "").trim().slice(0, 200);

function paymentBody({ vendorId, date, amount, allocations = [], mode, accountId, reference, note, vendorName }) {
  const f = modeFields({ mode, accountId, reference });
  return {
    body: {
      voucherType: "payment",
      vendorId: String(vendorId),
      date,
      totalAmount: round2(amount),
      narration: narrationOf(note, `Payment to ${vendorName}`),
      linkedInvoices: allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount, balance: a.balance })),
      paymentMode: f.paymentMode,
      paymentDetails: f.paymentDetails,
    },
    missing: f.missing,
  };
}

function receiptBody({ customerId, date, amount, allocations = [], mode, accountId, reference, note, customerName }) {
  const f = modeFields({ mode, accountId, reference });
  return {
    body: {
      voucherType: "receipt",
      customerId: String(customerId),
      date,
      totalAmount: round2(amount),
      narration: narrationOf(note, `Receipt from ${customerName}`),
      linkedInvoices: allocations.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount, balance: a.balance })),
      paymentMode: f.paymentMode,
      paymentDetails: f.paymentDetails,
    },
    missing: f.missing,
  };
}

function expenseBody({ accountId, date, amount, description, mode, payAccountId, reference, taxCodeId }) {
  const f = modeFields({ mode, accountId: payAccountId, reference });
  const body = {
    voucherType: "expense",
    ledgerBased: true,
    date,
    expenseAccountId: String(accountId),
    description: String(description).trim().slice(0, 200),
    amount: round2(amount),
    paymentMode: f.paymentMode,
    paymentDetails: f.paymentDetails,
  };
  if (taxCodeId) body.taxCodeId = String(taxCodeId);
  return { body, missing: f.missing };
}

/** `lines` are { itemId, name, qty, price }. The tax code is left to the server's default for the organisation. */
function invoiceBody({ customerId, date, lines, note }) {
  return {
    body: {
      type: "sales_order",
      partyId: String(customerId),
      partyType: "Customer",
      date,
      items: lines.map((l) => ({ itemId: String(l.itemId), description: String(l.name).slice(0, 200), qty: l.qty, price: round2(l.price) })),
      notes: narrationOf(note, ""),
    },
    missing: [],
  };
}

const money = (n, currency) => `${currency ? `${currency} ` : ""}${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What the card shows: label / value rows, in the order a person checks them. */
function proposalLines(kind, d, currency = "") {
  const rows = [];
  if (kind === "payment" || kind === "receipt") {
    rows.push([kind === "payment" ? "Pay" : "Receive from", d.partyName]);
    rows.push(["Amount", money(d.amount, currency)]);
    rows.push(["How", d.methodLabel]);
    if (d.accountName) rows.push(["Account", d.accountName]);
    if (d.reference) rows.push(["Reference", d.reference]);
    rows.push(["Date", d.date]);
    if (d.allocations?.length) {
      rows.push(["Settles", d.allocations.map((a) => `${a.number || "bill"} (${money(a.amount)})`).join(", ")]);
    }
    if (d.onAccount > 0.004) rows.push(["On account", money(d.onAccount, currency)]);
  } else if (kind === "expense") {
    rows.push(["Expense", d.accountName]);
    rows.push(["Description", d.description]);
    rows.push(["Amount", money(d.amount, currency)]);
    rows.push(["How", d.methodLabel]);
    if (d.payAccountName) rows.push(["Paid from", d.payAccountName]);
    if (d.reference) rows.push(["Reference", d.reference]);
    rows.push(["Date", d.date]);
  } else if (kind === "invoice") {
    rows.push(["Customer", d.partyName]);
    for (const l of d.lines) rows.push([l.name, `${l.qty} x ${money(l.price, currency)}`]);
    rows.push(["Date", d.date]);
    rows.push(["Saved as", "a draft: nothing is posted until it is approved"]);
  }
  return rows;
}

const METHOD_LABEL = { cash: "Cash", bank: "Bank", transfer: "Bank transfer" };

const ACTION_WORDS = /\b(pay|paid|paying|payment|receive|received|receipt|invoice|invoiced|bill|expense|spent|spend|record|transfer|settle|settled)\b/i;
const HELP_OPENERS = /^(how|what|why|where|when|which|can|could|is|are|does|do|explain)\b/i;

/**
 * Does this read as a request to DO something ("pay Al Noor 5,000") rather than a question about how something works
 * ("how do I pay a vendor?")? Used only to send fewer help topics with it, because a free AI plan allows a few thousand
 * tokens a minute. A wrong answer here costs nothing but a little context: the tools are offered either way.
 */
function looksLikeAction(question) {
  const t = String(question || "").trim();
  if (!t || HELP_OPENERS.test(t)) return false;
  return ACTION_WORDS.test(t);
}

module.exports = {
  rankByName, checkAmount, checkDate, allocateOldestFirst, normaliseMode, modeFields,
  paymentBody, receiptBody, expenseBody, invoiceBody, proposalLines, METHOD_LABEL, looksLikeAction,
  CASH_LIKE, REFERENCE_MODES, SUPPORTED_MODES, MAX_CHOICES, round2,
};
