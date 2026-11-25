// The rules an organisation sets for its vans (utils/vanSettings.js), tested without a database. The first test is the
// one everything rests on: an organisation that never opens the screen behaves exactly as van sales did before.
const test = require("node:test");
const assert = require("node:assert/strict");
const v = require("../vanSettings");

test("with nothing stored every rule is what van sales did before it had settings", () => {
  const s = v.normaliseSettings(undefined);
  assert.deepEqual(s, {
    customers: "any", creditSales: "allowed", priceChange: "up_only", maxDiscountPercent: 0, paymentModes: ["cash", "cheque"], returnsAllowed: true,
    suggestRuns: 4, suggestExtraPercent: 0, expiryCheck: "warn", transfersAllowed: true,
    captureLocation: true, farMetres: 300, quietHours: 2, cashTolerance: 0,
    slipPaper: "80mm", alwaysFullTaxInvoice: false, slipFooter: "Thank you", customerOrdering: true, maxOpenRequests: 3,
  });
  assert.deepEqual(v.normaliseSettings(null), s);
  assert.deepEqual(v.normaliseSettings([]), s, "an array is not a settings document");
  assert.deepEqual(v.normaliseSettings("x"), s);
});

test("the defaults are the same constants the rest of the module already used", () => {
  const rules = require("../vanSales");
  assert.equal(v.DEFAULTS.farMetres, rules.FAR_METRES);
  assert.equal(v.DEFAULTS.quietHours, rules.QUIET_HOURS);
});

test("a stored document with a missing or out-of-range key reads as the default for that key only", () => {
  const s = v.normaliseSettings({ customers: "route", farMetres: 99999, quietHours: "soon", paymentModes: ["online"], slipFooter: "x".repeat(500), creditSales: "never" });
  assert.equal(s.customers, "route");
  assert.equal(s.creditSales, "never");
  assert.equal(s.farMetres, 300, "out of range: the default");
  assert.equal(s.quietHours, 2, "not a number: the default");
  assert.deepEqual(s.paymentModes, ["cash", "cheque"], "a mode the van cannot post is not kept");
  assert.equal(s.slipFooter, "Thank you");
  // the defaults are never shared by reference
  s.paymentModes.push("x");
  assert.deepEqual(v.normaliseSettings({}).paymentModes, ["cash", "cheque"]);
});

test("every setting is validated: type, choice and range", () => {
  const bad = (input) => v.validateSettings(input).map((e) => e.field);
  assert.deepEqual(v.validateSettings({}), []);
  assert.deepEqual(v.validateSettings({ customers: "route", paymentModes: ["cash"], farMetres: 50, quietHours: 12, cashTolerance: 0.5, slipFooter: "" }), []);
  assert.deepEqual(bad({ customers: "everyone" }), ["customers"]);
  assert.deepEqual(bad({ creditSales: "sometimes" }), ["creditSales"]);
  assert.deepEqual(bad({ priceChange: "down" }), ["priceChange"]);
  assert.deepEqual(bad({ maxDiscountPercent: 101 }), ["maxDiscountPercent"]);
  assert.deepEqual(bad({ maxDiscountPercent: -1 }), ["maxDiscountPercent"]);
  assert.deepEqual(bad({ paymentModes: [] }), ["paymentModes"], "at least one way of taking money");
  assert.deepEqual(bad({ paymentModes: ["online"] }), ["paymentModes"], "online is the voucher's old name for a transfer, not a van mode");
  assert.deepEqual(v.validateSettings({ paymentModes: ["card", "transfer", "cash", "cheque"] }), [], "all four ways of taking money are valid");
  assert.deepEqual(bad({ paymentModes: "cash" }), ["paymentModes"]);
  assert.deepEqual(bad({ suggestRuns: 0 }), ["suggestRuns"]);
  assert.deepEqual(bad({ suggestRuns: 2.5 }), ["suggestRuns"], "whole runs only");
  assert.deepEqual(bad({ suggestExtraPercent: 101 }), ["suggestExtraPercent"]);
  assert.deepEqual(bad({ expiryCheck: "maybe" }), ["expiryCheck"]);
  assert.deepEqual(bad({ farMetres: 49 }), ["farMetres"]);
  assert.deepEqual(bad({ quietHours: 0 }), ["quietHours"]);
  assert.deepEqual(bad({ slipPaper: "a4" }), ["slipPaper"]);
  assert.deepEqual(bad({ slipFooter: "x".repeat(121) }), ["slipFooter"]);
  assert.deepEqual(bad({ maxOpenRequests: 11 }), ["maxOpenRequests"]);
  assert.deepEqual(bad({ returnsAllowed: "yes" }), ["returnsAllowed"], "a switch is on or off, not a word");
  assert.deepEqual(bad({ transfersAllowed: 1 }), ["transfersAllowed"]);
});

test("hostile input is refused cleanly, never thrown on", () => {
  for (const evil of [null, [], "x", 5, undefined]) assert.equal(v.validateSettings(evil).length, 1);
  assert.ok(v.validateSettings({ customers: { $ne: "x" } }).length, "an object where a word is expected");
  assert.ok(v.validateSettings({ farMetres: { $gt: 0 } }).length);
  assert.ok(v.validateSettings({ farMetres: [300] }).length, "an array is not a number");
  assert.ok(v.validateSettings({ slipFooter: { toString() { throw new Error("boom"); } } }).length);
  assert.deepEqual(v.validateSettings({ __proto__: { customers: "bad" } }), [], "inherited keys are not read");
});

test("payment modes are kept once each, in a steady order", () => {
  assert.deepEqual(v.checkValue("paymentModes", ["cheque", "cash", "cash"]).value, ["cash", "cheque"]);
  assert.deepEqual(v.checkValue("paymentModes", ["transfer", "card", "cheque", "cash"]).value, ["cash", "cheque", "card", "transfer"]);
});

test("a van's own rules: only the five it may override, a blank means 'as the organisation'", () => {
  const ok = v.cleanVanRules({ customers: "route", creditSales: "never", priceChange: "locked", maxDiscountPercent: 5, paymentModes: ["cash"], farMetres: 100, expiryCheck: "off" });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.rules, { customers: "route", creditSales: "never", priceChange: "locked", maxDiscountPercent: 5, paymentModes: ["cash"] }, "organisation-only keys are not stored on a van");
  assert.deepEqual(v.cleanVanRules({ customers: "org", creditSales: "", priceChange: null }).rules, {});
  assert.deepEqual(v.cleanVanRules(undefined), { errors: [], rules: {} });
  assert.deepEqual(v.cleanVanRules(null), { errors: [], rules: {} });
  assert.equal(v.cleanVanRules({ customers: "everyone" }).errors[0].field, "rules.customers");
  assert.equal(v.cleanVanRules("x").errors.length, 1);
  assert.equal(v.cleanVanRules([]).errors.length, 1);
  assert.deepEqual(v.PER_VAN_KEYS, ["customers", "creditSales", "priceChange", "maxDiscountPercent", "paymentModes"]);
});

test("the rules in force for a van are the organisation's with the van's own laid over them", () => {
  const org = { customers: "route", creditSales: "never", farMetres: 500 };
  const e = v.effective(org, { creditSales: "allowed", paymentModes: ["cash"] });
  assert.equal(e.customers, "route", "not overridden: the organisation's");
  assert.equal(e.creditSales, "allowed", "the van's own wins");
  assert.deepEqual(e.paymentModes, ["cash"]);
  assert.equal(e.farMetres, 500, "organisation-only keys come from the organisation");
  assert.deepEqual(v.effective(org, undefined), v.normaliseSettings(org));
  assert.equal(v.effective(org, { customers: "garbage" }).customers, "route", "a bad override on a van is ignored, not trusted");
});

test("cash terms: no days, or a word for paying at once; a term nobody can read is not assumed to be cash", () => {
  for (const t of ["Cash", "cash on delivery", "COD", "Prepaid", "Advance", "Net 0", "", null, undefined, "Due on receipt"]) assert.equal(v.isCashTerms(t), true, `${t}`);
  for (const t of ["Net 30", "30 days", "Net 7", "60"]) assert.equal(v.isCashTerms(t), false, `${t}`);
  assert.equal(v.isCashTerms("Credit"), false, "an unreadable word never refuses a sale");
});

const R = (o = {}) => v.normaliseSettings(o);

test("a typed price: up_only is today's rule, locked allows the list price only, free allows anything", () => {
  const base = { name: "Rice", list: 20, typedPrice: true, listName: "North" };
  // up_only (the default)
  assert.equal(v.checkLine({ ...base, price: 25, rules: R() }), null, "higher is the salesman's call");
  assert.equal(v.checkLine({ ...base, price: 20, rules: R() }), null);
  assert.equal(v.checkLine({ ...base, price: 20 - 0.004, rules: R() }), null, "inside the half-fils tolerance");
  const low = v.checkLine({ ...base, price: 19, rules: R() });
  assert.equal(low.code, "PRICE_BELOW_LIST");
  assert.equal(low.status, 403);
  assert.match(low.message, /20\.00 for this customer \(North\)/);
  assert.equal(low.details.listPrice, 20);
  // locked
  const locked = R({ priceChange: "locked" });
  assert.equal(v.checkLine({ ...base, price: 20, rules: locked }), null, "typing the list price changes nothing");
  assert.equal(v.checkLine({ ...base, price: 25, rules: locked }).code, "PRICE_LOCKED", "even higher is refused");
  assert.equal(v.checkLine({ ...base, price: 19, rules: locked }).code, "PRICE_LOCKED");
  // free
  const free = R({ priceChange: "free" });
  assert.equal(v.checkLine({ ...base, price: 1, rules: free }), null);
  assert.equal(v.checkLine({ ...base, price: 99, rules: free }), null);
  // no price typed: the list is used, nothing to judge
  assert.equal(v.checkLine({ ...base, price: 5, typedPrice: false, rules: locked }), null);
  // a supervisor is never refused
  assert.equal(v.checkLine({ ...base, price: 1, rules: locked, mayOverride: true }), null);
});

test("a typed discount is capped, whatever the price rule says, and a supervisor is not held to it", () => {
  const base = { name: "Rice", price: 20, list: 20, typedPrice: false };
  assert.equal(v.checkLine({ ...base, discountPercent: 0, rules: R() }), null);
  const none = v.checkLine({ ...base, discountPercent: 1, rules: R() });
  assert.equal(none.code, "DISCOUNT_TOO_HIGH", "the default is no discount without a supervisor");
  assert.match(none.message, /needs a supervisor/);
  const capped = R({ maxDiscountPercent: 5 });
  assert.equal(v.checkLine({ ...base, discountPercent: 5, rules: capped }), null);
  const over = v.checkLine({ ...base, discountPercent: 5.5, rules: capped });
  assert.equal(over.code, "DISCOUNT_TOO_HIGH");
  assert.match(over.message, /above 5%/);
  assert.equal(v.checkLine({ ...base, discountPercent: 50, rules: R({ priceChange: "free" }) }).code, "DISCOUNT_TOO_HIGH", "free pricing is not free discounting");
  assert.equal(v.checkLine({ ...base, discountPercent: 50, rules: R(), mayOverride: true }), null);
});

test("the defect: a list-price line with a big typed discount no longer slips past the below-list check", () => {
  // before: price 20 against list 20 passed PRICE_BELOW_LIST, and discountPercent 50 was never judged
  assert.equal(v.checkLine({ name: "Rice", price: 20, list: 20, typedPrice: true, discountPercent: 50, rules: R() }).code, "DISCOUNT_TOO_HIGH");
});

test("which sales must be paid at the door", () => {
  assert.equal(v.mustPayNow(R(), { cashCustomer: true }), false, "allowed: never");
  assert.equal(v.mustPayNow(R({ creditSales: "never" }), { cashCustomer: false }), true);
  assert.equal(v.mustPayNow(R({ creditSales: "cashTerms" }), { cashCustomer: true }), true);
  assert.equal(v.mustPayNow(R({ creditSales: "cashTerms" }), { cashCustomer: false }), false, "a credit customer may still buy on credit");
});

test("the money taken with a sale: modes, the requirement to pay, and the amount", () => {
  const never = R({ creditSales: "never" });
  assert.equal(v.checkPayment({ rules: R(), payNow: undefined }), null, "credit is allowed by default");
  assert.equal(v.checkPayment({ rules: R(), payNow: { full: true } }), null);
  assert.equal(v.checkPayment({ rules: never, payNow: undefined }).code, "VAN_PAYMENT_REQUIRED");
  assert.equal(v.checkPayment({ rules: never, payNow: {} }).code, "VAN_PAYMENT_REQUIRED", "no money named");
  assert.equal(v.checkPayment({ rules: never, payNow: { amount: 0 } }).code, "VAN_PAYMENT_REQUIRED");
  assert.equal(v.checkPayment({ rules: never, payNow: { full: true } }), null);
  assert.equal(v.checkPayment({ rules: never, payNow: { amount: 50 } }), null, "intent only until the total is known");
  assert.equal(v.checkPayment({ rules: never, payNow: { amount: 50 }, total: 100 }).code, "VAN_PAYMENT_REQUIRED", "part of it is not the whole");
  assert.equal(v.checkPayment({ rules: never, payNow: { amount: 99.996 }, total: 100 }), null, "inside the half-fils tolerance");
  assert.equal(v.checkPayment({ rules: never, payNow: { full: true }, total: 100 }), null);
  const cashTerms = R({ creditSales: "cashTerms" });
  assert.equal(v.checkPayment({ rules: cashTerms, payNow: undefined, cashCustomer: true }).code, "VAN_PAYMENT_REQUIRED");
  assert.match(v.checkPayment({ rules: cashTerms, payNow: undefined, cashCustomer: true }).message, /cash terms/);
  assert.equal(v.checkPayment({ rules: cashTerms, payNow: undefined, cashCustomer: false }), null);
  // modes
  const cashOnly = R({ paymentModes: ["cash"] });
  assert.equal(v.checkPayment({ rules: cashOnly, payNow: { full: true, mode: "cheque" } }).code, "VAN_MODE_NOT_ALLOWED");
  assert.equal(v.checkPayment({ rules: cashOnly, payNow: { full: true } }), null, "cash is the default mode");
  assert.equal(v.checkMode(R(), "cheque"), null);
  assert.equal(v.checkMode(cashOnly, "cheque").status, 400);
  assert.deepEqual(v.checkMode(cashOnly, "cheque").details, { allowed: ["cash"] });
});

test("only the customers on the route: a supervisor and a free van are never refused", () => {
  const route = R({ customers: "route" });
  assert.equal(v.checkCustomer({ rules: R(), onRoute: false, hasRoute: true }), null);
  assert.equal(v.checkCustomer({ rules: route, onRoute: true, hasRoute: true }), null);
  assert.equal(v.checkCustomer({ rules: route, onRoute: false, hasRoute: true, mayOverride: true }), null);
  const off = v.checkCustomer({ rules: route, onRoute: false, hasRoute: true });
  assert.equal(off.code, "CUSTOMER_NOT_ON_ROUTE");
  assert.equal(off.status, 403);
  assert.match(v.checkCustomer({ rules: route, onRoute: false, hasRoute: false }).message, /no route/);
});
