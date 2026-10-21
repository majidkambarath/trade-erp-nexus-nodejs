// What the developer console is offered when it sells an organisation its modules (pure: no Mongoose, no request).
//
// The entitlement rules live in utils/plans.js (what an ORGANISATION may use) and utils/permissions.js (what a PERSON may do);
// this file adds nothing to them. It only ARRANGES what already exists so a person can choose it without knowing the keys:
//   - where each optional feature belongs (Production under Inventory, Quotations under Sales), because a feature is one
//     screen of a module and the console should show it there, not in a separate flat list;
//   - the screens a module always includes, so "Sales" reads as a list of things and not as a word;
//   - which ready-made roles will hold what, so "who gets this" can be answered before the customer is made;
//   - the time zones the books can be kept in, by their current names.
// It is the console's own arrangement, so it is NOT mirrored in zarvia-platform (the parity suites cover the rules, not this).
const tz = require("./tz");
const plans = require("./plans");
const perms = require("./permissions");
const countryRules = require("./countryRules");

// The groups the console draws the modules under, in order. `core` is what no plan can take away.
const GROUPS = [
  { key: "crm", label: "CRM workspace" },
  { key: "trade", label: "Buying, selling and stock" },
  { key: "money", label: "Money and books" },
  { key: "organisation", label: "People and settings" },
  { key: "core", label: "Always on" },
];

// A section is a screen the module includes. `{ feature }` is one that can be sold apart (it is a feature flag, so it can be
// switched on or off for a customer); a plain string is part of the module and goes with it. This is the navigation's own
// arrangement (trade erp/src/config/navigation.js), kept short and in the words a customer would use.
const MODULE_INFO = {
  crm: { group: "crm", sections: ["Dashboard", "Leads", "Contacts", "Pipeline", "Communications", "Follow-ups", "Calendar", "Reports", "Setup"] },
  sales: { group: "trade", sections: [{ feature: "quotations" }, "Orders", { feature: "deliveryNotes" }, "Invoices", "Returns", "Customers", { feature: "messaging" }] },
  purchase: { group: "trade", sections: ["Orders", "Goods received", "Invoices", "Returns", "Vendors"] },
  inventory: { group: "trade", sections: ["Stock items", "Movements", "Categories", "Units", { feature: "batches" }, { feature: "production" }] },
  finance: { group: "money", sections: ["Receipts", "Payments", "Journal", "Contra", "Expenses", "Debit and credit notes", "Ledger"] },
  banking: { group: "money", sections: [{ feature: "banking" }, { feature: "reconciliation" }] },
  accounts: { group: "money", sections: ["Chart of accounts", "Accounting setup and tax codes", "Opening balances", "Period lock", "KYC documents", { feature: "currencies" }] },
  reports: { group: "money", sections: ["Dashboard", "Financial statements", "Ledger reports", "Trade analysis", "Ageing", "Stock reports", { feature: "ifrsStatements" }, { feature: "vatReturn" }, { feature: "einvoicing" }] },
  users: { group: "organisation", sections: ["Users", "Roles and permissions"] },
  staff: { group: "organisation", sections: ["Staff records"] },
  settings: { group: "organisation", sections: ["Company profile", "Business rules", "Security", { feature: "multiBranch" }] },
  audit: { group: "organisation", sections: ["Activity trail"] },
  lookups: { group: "core", sections: [] },
};

// One sentence for each optional feature, and a shorter name where the plan's own label is a sentence already.
const FEATURE_INFO = {
  quotations: { hint: "Price offers that the customer accepts and that turn into orders" },
  deliveryNotes: { hint: "Delivery notes, signed for on delivery and invoiced afterwards" },
  batches: { hint: "Batch numbers, expiry dates and first-expiry-first-out stock" },
  banking: { hint: "Bank and card masters, cheques, and card and bank payment modes" },
  reconciliation: { hint: "Import a bank statement and match it to the books" },
  currencies: { hint: "Receipts and payments in a foreign currency, with exchange rates" },
  vatReturn: { hint: "The VAT 201 return, built from the approved documents" },
  ifrsStatements: { hint: "Statement of financial position, profit or loss, cash flows and notes" },
  einvoicing: { hint: "Electronic tax invoices sent to the tax authority" },
  messaging: { hint: "Email or WhatsApp an invoice to the customer with a secure link" },
  multiBranch: { hint: "More than one branch, each with its own documents and numbering" },
  production: { label: "Production", hint: "Materials and expenses moved into a product's cost, job work and process orders. Off for everyone unless switched on here" },
};

const SECTION_HOME = Object.fromEntries(
  Object.entries(MODULE_INFO).flatMap(([module, info]) => info.sections.filter((s) => typeof s === "object").map((s) => [s.feature, module]))
);

/** The optional features, each filed under the module it belongs to, with what it does and where it applies. */
function featureCatalogue() {
  return Object.entries(plans.FEATURES).map(([key, f]) => ({
    key,
    label: FEATURE_INFO[key]?.label || f.label,
    hint: FEATURE_INFO[key]?.hint || "",
    module: SECTION_HOME[key] || null,
    optIn: Boolean(f.optIn),
    // a feature the organisation's country can switch off whatever was sold (the UAE's own return and e-invoicing)
    onlyIn: countryRules.UAE_ONLY_FEATURES.includes(key) ? ["AE"] : null,
  }));
}

/**
 * The modules, each with its actions (named and explained), what can never be switched off, the screens it includes and the
 * group it is drawn under. `sections` is in navigation order; a `{ feature }` entry names a feature filed under this module.
 */
function moduleCatalogue() {
  const described = new Map(perms.catalogue().map((m) => [m.key, m]));
  return plans.MODULE_KEYS.map((key) => {
    const info = MODULE_INFO[key] || { group: "organisation", sections: [] };
    const actions = (described.get(key)?.actions || []).map((a) => ({ action: a.action, label: a.label, short: a.short, read: a.read }));
    return {
      key,
      label: perms.MODULES[key].label,
      hint: perms.MODULES[key].hint,
      group: info.group,
      actions,
      alwaysOn: plans.ALWAYS_ON.filter((k) => k.startsWith(`${key}.`)).map((k) => k.slice(key.length + 1)),
      sections: info.sections,
    };
  });
}

/**
 * What each ready-made role holds in each module, so the console can say who gets a module. A role the customer makes later
 * can only hold what is sold, so the ready-made ones are the honest preview. -> [{ key, name, rank, description, modules: { sales: ["view", ...] } }]
 */
function roleCatalogue() {
  return perms.BUILT_IN_KEYS.map((key) => {
    const role = perms.BUILT_IN[key];
    const modules = {};
    for (const grant of perms.grantsOf({ ...role, isActive: true })) {
      const [module, action] = grant.split(".");
      (modules[module] ||= []).push(action);
    }
    return { key, name: role.name, rank: role.rank, description: role.description, modules };
  });
}

// The names an engine's time-zone list still carries from before the IANA database renamed them. Only zones the books can be
// kept in matter (never west of UTC), so only those are listed. Both names are valid to store; the current one is what a person expects.
const ZONE_ALIASES = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Rangoon": "Asia/Yangon",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Africa/Asmera": "Africa/Asmara",
  "Europe/Kiev": "Europe/Kyiv",
  "Asia/Thimbu": "Asia/Thimphu",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Asia/Macao": "Asia/Macau",
  "Asia/Ujung_Pandang": "Asia/Makassar",
  "Asia/Dacca": "Asia/Dhaka",
  "Asia/Ulan_Bator": "Asia/Ulaanbaatar",
  "Asia/Chongqing": "Asia/Shanghai",
  "Asia/Harbin": "Asia/Shanghai",
  "Asia/Kashgar": "Asia/Urumqi",
  "Asia/Istanbul": "Europe/Istanbul",
  "Asia/Tel_Aviv": "Asia/Jerusalem",
  "Europe/Belfast": "Europe/London",
};
const canonicalZone = (zone) => ZONE_ALIASES[zone] || zone;

/**
 * The time zones an organisation can be made in: this runtime's own list under their current names, without the ones the
 * server would refuse (west of UTC), each once, in order. `raw` is for tests.
 */
function zoneList(raw = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []) {
  const seen = new Set();
  for (const name of raw) {
    const zone = canonicalZone(name);
    if (!seen.has(zone) && tz.supportedZone(zone).ok) seen.add(zone);
  }
  return [...seen].sort();
}

module.exports = { GROUPS, MODULE_INFO, FEATURE_INFO, ZONE_ALIASES, canonicalZone, featureCatalogue, moduleCatalogue, roleCatalogue, zoneList };
