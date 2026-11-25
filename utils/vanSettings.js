// The rules an organisation can set for its vans (CompanySettings.vanSales), and the five a single van can override
// (Van.rules). Pure: no database, so the same functions serve the services, the offline pack and the tests.
//
// THE RULE: every default below is what van sales did BEFORE it had settings, so an organisation that never opens the
// screen sees nothing change. A stored document from an older version is read through normaliseSettings, which fills
// whatever is missing with these defaults and clamps whatever is out of range.

// The ways money can be taken on the road. The DEFAULT is still cash and cheque (nobody's van changes until they tick a
// box); card needs the van's own card machine and, like a cheque, the banking part of the plan; a transfer waits for the
// office to see it in the bank (financialService.createVoucher, holdFor "van_transfer").
const SUPPORTED_MODES = ["cash", "cheque", "card", "transfer"];

const CUSTOMERS = ["any", "route"];
const CREDIT_SALES = ["allowed", "cashTerms", "never"];
const PRICE_CHANGE = ["up_only", "locked", "free"];
const EXPIRY_CHECK = ["warn", "off", "block"];
const PAPER = ["80mm", "58mm"];

// Why goods come back. An organisation edits the list; a return stores the reason in the list's own wording at the time,
// so renaming one later never rewrites what was recorded.
const RETURN_REASONS = Object.freeze(["Expired", "Damaged", "Wrong item delivered", "Not selling", "Customer complaint", "Other"]);
const MAX_REASONS = 20;
const REASON_LENGTH = 40;
const tidyReason = (r) => (typeof r === "string" ? r.trim().replace(/\s+/g, " ") : "");

const DEFAULTS = Object.freeze({
  // selling
  customers: "any", // any active customer, or only the ones on the trip's route
  creditSales: "allowed", // allowed | cashTerms (a cash customer pays at the door) | never
  priceChange: "up_only", // a higher price is the salesman's call; lower needs a supervisor (locked: neither)
  maxDiscountPercent: 0, // the most a salesman may type as a discount without a supervisor
  paymentModes: ["cash", "cheque"],
  returnsAllowed: true,
  returnsWithoutInvoice: false, // goods taken back with no invoice named (a supervisor always may)
  maxReturnWithoutInvoice: 500, // above this total (tax included) only a supervisor takes goods back with no invoice
  returnReasons: RETURN_REASONS,
  // loading
  suggestRuns: 4,
  suggestExtraPercent: 0,
  expiryCheck: "warn",
  transfersAllowed: true,
  // on the road
  captureLocation: true,
  farMetres: 300,
  quietHours: 2,
  // settlement
  cashTolerance: 0,
  // the printed slip
  slipPaper: "80mm",
  alwaysFullTaxInvoice: false,
  slipFooter: "Thank you",
  // the customer's own link
  customerOrdering: true,
  maxOpenRequests: 3,
});

/** The settings a van may override for itself (Van.rules). Everything else is the organisation's alone. */
const PER_VAN_KEYS = Object.freeze(["customers", "creditSales", "priceChange", "maxDiscountPercent", "paymentModes"]);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined); // never an inherited key
const num = (v) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN);

/** One value for one key: { ok: true, value } or { ok: false, message }. Strict: a wrong type is refused, never coerced. */
function checkValue(key, raw) {
  const oneOf = (list, what) => (typeof raw === "string" && list.includes(raw) ? { ok: true, value: raw } : { ok: false, message: `${what} must be one of: ${list.join(", ")}` });
  const range = (min, max, what, whole = false) => {
    const n = typeof raw === "number" || typeof raw === "string" ? num(raw) : NaN;
    if (!Number.isFinite(n) || n < min || n > max || (whole && !Number.isInteger(n))) return { ok: false, message: `${what} must be ${whole ? "a whole number " : "a number "}from ${min} to ${max}` };
    return { ok: true, value: n };
  };
  const bool = (what) => (typeof raw === "boolean" ? { ok: true, value: raw } : { ok: false, message: `${what} must be on or off` });
  switch (key) {
    case "customers": return oneOf(CUSTOMERS, "Who the van may sell to");
    case "creditSales": return oneOf(CREDIT_SALES, "Credit sales");
    case "priceChange": return oneOf(PRICE_CHANGE, "Changing the price");
    case "maxDiscountPercent": return range(0, 100, "The discount a salesman may give");
    case "paymentModes": {
      if (!Array.isArray(raw) || !raw.length) return { ok: false, message: "Choose at least one way of taking money" };
      if (!raw.every((m) => typeof m === "string" && SUPPORTED_MODES.includes(m))) return { ok: false, message: `Money on the road can be taken by: ${SUPPORTED_MODES.join(", ")}` };
      return { ok: true, value: SUPPORTED_MODES.filter((m) => raw.includes(m)) }; // one of each, in a steady order
    }
    case "returnsAllowed": return bool("Taking goods back");
    case "returnsWithoutInvoice": return bool("Taking goods back without an invoice");
    case "maxReturnWithoutInvoice": return range(1, 1000000, "The most taken back without an invoice");
    case "returnReasons": {
      if (!Array.isArray(raw) || !raw.length) return { ok: false, message: "Keep at least one reason for a return" };
      if (raw.length > MAX_REASONS) return { ok: false, message: `At most ${MAX_REASONS} reasons for a return` };
      const out = [];
      for (const r of raw) {
        const t = tidyReason(r);
        if (!t || t.length > REASON_LENGTH) return { ok: false, message: `Each reason is text of 1 to ${REASON_LENGTH} characters` };
        if (out.some((o) => o.toLowerCase() === t.toLowerCase())) return { ok: false, message: `"${t}" is in the list twice` };
        out.push(t);
      }
      return { ok: true, value: out };
    }
    case "suggestRuns": return range(1, 12, "The runs the suggested load looks at", true);
    case "suggestExtraPercent": return range(0, 100, "The extra on the suggested load");
    case "expiryCheck": return oneOf(EXPIRY_CHECK, "The expiry check");
    case "transfersAllowed": return bool("Van-to-van transfers");
    case "captureLocation": return bool("Reading the phone's location");
    case "farMetres": return range(50, 5000, "The 'far from the shop' distance", true);
    case "quietHours": return range(1, 12, "The 'quiet' time", true);
    case "cashTolerance": return range(0, 1000000, "The cash difference that needs no tick");
    case "slipPaper": return oneOf(PAPER, "The slip paper");
    case "alwaysFullTaxInvoice": return bool("Always printing the full tax invoice");
    case "slipFooter": return typeof raw === "string" && raw.length <= 120 ? { ok: true, value: raw.trim() } : { ok: false, message: "The slip footer must be text of 120 characters or fewer" };
    case "customerOrdering": return bool("Orders from the customer's link");
    case "maxOpenRequests": return range(1, 10, "The requests a customer may have waiting", true);
    default: return { ok: false, message: "Unknown setting" };
  }
}

/** The problems with a settings request: [{ field, code, message }], empty when fine. Unknown keys are ignored. */
function validateSettings(input) {
  if (!isObject(input)) return [{ field: "", code: "VAN_SETTING_INVALID", message: "Send the settings as an object" }];
  const errors = [];
  for (const key of Object.keys(DEFAULTS)) {
    if (own(input, key) === undefined) continue;
    const r = checkValue(key, own(input, key));
    if (!r.ok) errors.push({ field: key, code: "VAN_SETTING_INVALID", message: r.message });
  }
  return errors;
}

/** Whatever was stored, read as a full, valid set: a missing or out-of-range key is the default. */
function normaliseSettings(stored) {
  const src = isObject(stored) ? stored : {};
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const r = own(src, key) === undefined ? { ok: false } : checkValue(key, own(src, key));
    out[key] = r.ok ? r.value : Array.isArray(DEFAULTS[key]) ? [...DEFAULTS[key]] : DEFAULTS[key];
  }
  return out;
}

/**
 * A van's own overrides. A key that is null, "" or "org" means "as the organisation" and is dropped. -> { errors, rules }
 * where rules holds only the keys the van really sets.
 */
function cleanVanRules(input) {
  if (input === undefined || input === null) return { errors: [], rules: {} };
  if (!isObject(input)) return { errors: [{ field: "rules", code: "VAN_SETTING_INVALID", message: "Send the van's rules as an object" }], rules: {} };
  const errors = [];
  const rules = {};
  for (const key of PER_VAN_KEYS) {
    const raw = own(input, key);
    if (raw === undefined || raw === null || raw === "" || raw === "org") continue;
    const r = checkValue(key, raw);
    if (r.ok) rules[key] = r.value;
    else errors.push({ field: `rules.${key}`, code: "VAN_SETTING_INVALID", message: r.message });
  }
  return { errors, rules };
}

/** The rules in force for one van: the organisation's, with the van's own five laid over them. */
function effective(orgStored, vanRules) {
  const base = normaliseSettings(orgStored);
  const { rules } = cleanVanRules(vanRules);
  return { ...base, ...rules };
}

// ---- the decisions ----------------------------------------------------------------------------------------------

const EPS = 0.005;
const refuse = (code, message, status = 403, details) => ({ code, message, status, ...(details ? { details } : {}) });

/**
 * Terms that mean "pays at once": no days, or one of the words for it. "Net 30" is credit; a term nobody can read
 * ("Credit") is NOT assumed to be cash, so the rule never refuses a sale over a word it does not understand.
 */
function isCashTerms(terms) {
  const text = String(terms ?? "").trim();
  if (!text) return true; // the master's default is Cash
  if (/(\d+)/.test(text)) return Number(/(\d+)/.exec(text)[1]) === 0;
  return /cash|cod|prepaid|advance|immediate|on receipt|upfront/i.test(text);
}

/** True when this sale has to be paid in full at the door under these rules. */
function mustPayNow(rules, { cashCustomer = false } = {}) {
  if (rules.creditSales === "never") return true;
  return rules.creditSales === "cashTerms" && Boolean(cashCustomer);
}

/**
 * The price and discount a salesman typed on one line. `typedPrice` is whether he typed a price at all (else the list
 * price is used and there is nothing to judge). A supervisor (`mayOverride`) is never refused. -> null, or a refusal.
 *   up_only  today's rule: below the list price needs a supervisor, above is free
 *   locked   the list price only
 *   free     any price
 * A typed discount is capped by maxDiscountPercent whatever the price rule says; promotions are not typed and are not judged.
 */
function checkLine({ name = "That item", price, list, typedPrice, discountPercent = 0, listName = "", rules, mayOverride = false }) {
  if (mayOverride) return null;
  if (typedPrice && rules.priceChange !== "free") {
    const below = price + EPS < list;
    const above = price > list + EPS;
    if (rules.priceChange === "locked" && (below || above)) {
      return refuse("PRICE_LOCKED", `${name} is ${list.toFixed(2)} for this customer${listName ? ` (${listName})` : ""}. The price cannot be changed on the van.`, 403, { listPrice: list });
    }
    if (rules.priceChange === "up_only" && below) {
      return refuse("PRICE_BELOW_LIST", `${name} is ${list.toFixed(2)} for this customer${listName ? ` (${listName})` : ""}. Selling it for less needs a supervisor.`, 403, { listPrice: list });
    }
  }
  const d = Number(discountPercent) || 0;
  if (d > 0 && d > Number(rules.maxDiscountPercent) + 1e-9) {
    const cap = Number(rules.maxDiscountPercent) || 0;
    return refuse("DISCOUNT_TOO_HIGH", cap > 0 ? `A discount above ${cap}% needs a supervisor.` : "A discount on the van needs a supervisor.", 403, { maxDiscountPercent: cap });
  }
  return null;
}

/** Is this way of taking money allowed on the van? -> null, or a refusal. */
function checkMode(rules, mode) {
  if (!rules.paymentModes.includes(mode)) {
    return refuse("VAN_MODE_NOT_ALLOWED", `This van takes money by ${rules.paymentModes.join(" or ")}, not by ${mode}`, 400, { allowed: rules.paymentModes });
  }
  return null;
}

/**
 * The money taken with a sale. `total` is known once the invoice is priced; before that, pass none and only the intent
 * ("is he taking any money at all?") is judged. -> null, or a refusal.
 */
function checkPayment({ rules, payNow, cashCustomer = false, total }) {
  const taking = Boolean(payNow) && (payNow.full === true || Number(payNow.amount) > 0);
  if (taking) {
    const bad = checkMode(rules, payNow.mode || "cash");
    if (bad) return bad;
  }
  if (!mustPayNow(rules, { cashCustomer })) return null;
  if (!taking) return refuse("VAN_PAYMENT_REQUIRED", rules.creditSales === "never" ? "This van sells for payment at the door. Take the money with the sale." : "This customer is on cash terms, so the money is taken with the sale.", 409);
  if (total !== undefined && payNow.full !== true && Number(payNow.amount) + EPS < Number(total)) {
    return refuse("VAN_PAYMENT_REQUIRED", "The whole amount is taken at the door for this sale.", 409);
  }
  return null;
}

/** May this van sell to a customer on or off the trip's route? `onRoute` is whether the customer is one of its stops. */
function checkCustomer({ rules, onRoute, hasRoute, mayOverride = false }) {
  if (rules.customers !== "route" || onRoute || mayOverride) return null;
  return refuse("CUSTOMER_NOT_ON_ROUTE", hasRoute ? "This van sells only to the customers on its route" : "This van sells only to the customers on its route, and this trip has no route", 403);
}

/** The reason as the organisation's list words it today, or null when it is not on the list. */
function matchReason(rules, raw) {
  const t = tidyReason(raw).toLowerCase();
  if (!t) return null;
  return (rules.returnReasons || []).find((r) => r.toLowerCase() === t) || null;
}

/** The settings the phone needs to behave the same with no signal: the whole effective set, nothing secret in it. */
const forPhone = (eff) => ({ ...eff });

module.exports = {
  SUPPORTED_MODES, RETURN_REASONS, CUSTOMERS, CREDIT_SALES, PRICE_CHANGE, EXPIRY_CHECK, PAPER, DEFAULTS, PER_VAN_KEYS,
  checkValue, validateSettings, normaliseSettings, cleanVanRules, effective,
  isCashTerms, mustPayNow, checkLine, checkMode, checkPayment, checkCustomer, matchReason, forPhone,
};
