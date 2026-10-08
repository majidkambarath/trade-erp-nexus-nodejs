// What each person inside a customer's company may do: the catalogue of permissions, the built-in roles, and the
// rules for combining and granting them. Pure - no Mongoose, no request - so the whole table is tested without a
// server, in the same way as utils/plans.js beside it. (That file decides what an ORGANISATION may use; this one
// decides what a PERSON in it may do. Both must say yes.)
//
// A permission is "<module>.<action>", for example sales.approve. The modules are the product's own sidebar modules,
// so a role reads the way the product does. `view` is implied by every other action in its module.

const MODULES = {
  sales: {
    label: "Sales",
    hint: "Quotations, sales orders, delivery notes, sales returns and customers",
    actions: {
      view: "See sales documents and customers",
      create: "Create and edit quotations, orders, delivery notes, returns and customers",
      approve: "Approve, reject or cancel a sales document; dispatch and deliver goods",
      delete: "Delete a sales document or a customer",
      send: "Send a document to a customer by email or WhatsApp",
      creditOverride: "Approve a sale for a customer over their credit limit",
    },
  },
  purchase: {
    label: "Purchase",
    hint: "Purchase orders, purchase returns and vendors",
    actions: {
      view: "See purchase documents and vendors",
      create: "Create and edit purchase orders, returns and vendors",
      approve: "Approve, reject or cancel a purchase document (receives the goods)",
      delete: "Delete a purchase document or a vendor",
    },
  },
  inventory: {
    label: "Inventory",
    hint: "Items, categories, units, batches and stock movements",
    actions: {
      view: "See items, stock and batches",
      create: "Create and edit items, categories and units",
      delete: "Delete an item, category or unit",
      adjust: "Change a quantity on hand, write off a batch, record a stock movement",
    },
  },
  finance: {
    label: "Finance",
    hint: "Receipts, payments, journals, contra, expenses, notes and cheques",
    actions: {
      view: "See vouchers and the ledger entries behind them",
      create: "Create and edit receipts, payments, journals, contra, expenses and notes",
      approve: "Approve or reject a voucher; clear, bounce or cancel a cheque",
      delete: "Delete a voucher",
    },
  },
  banking: {
    label: "Banking",
    hint: "Bank and card masters, statements and reconciliation",
    actions: {
      view: "See banks, cards and reconciliations",
      manage: "Create and edit banks, card types and cards",
      reconcile: "Import statements, match, and finish or reopen a reconciliation",
    },
  },
  accounts: {
    label: "Accounts",
    hint: "Chart of accounts, posting accounts, tax codes, numbering, opening balances and the period lock",
    actions: {
      view: "See the chart of accounts and the accounting setup",
      manage: "Change the chart, posting accounts, tax codes and numbering; post opening balances",
      close: "Close or reopen a fiscal year (the period lock)",
    },
  },
  reports: {
    label: "Reports",
    hint: "The dashboard and reports",
    actions: {
      view: "See the dashboard, stock reports and ageing",
      financial: "See profit and loss, balance sheet, trial balance, ledger and IFRS statements",
      vat: "Finalise, file or delete a VAT return",
    },
  },
  users: {
    label: "Users and roles",
    hint: "The people who sign in, and what each may do",
    actions: {
      view: "See the people in the organisation and their roles",
      manage: "Add, change, switch off and reset the password of people with a lower role; create roles",
    },
  },
  settings: {
    label: "Settings",
    hint: "Company profile, sending, e-invoicing and business rules",
    actions: {
      view: "See the company settings",
      manage: "Change the company profile, credit control, sending and e-invoicing settings",
    },
  },
  audit: {
    label: "Activity trail",
    hint: "Who did what",
    actions: { view: "Read the organisation's activity trail" },
  },
  // Reference data a form needs to be filled in: the pick lists of customers, vendors, items, tax codes, accounts and
  // currencies. Without it a person who may raise an invoice could not choose a customer. Granted automatically to
  // anyone who may do anything beyond looking (see IMPLIES), and shown in the editor as ticked and locked.
  lookups: {
    label: "Pick lists",
    hint: "The lists a form chooses from: customers, vendors, items, tax codes, accounts",
    actions: { view: "Choose from the organisation's reference data when filling in a form" },
  },
};

const MODULE_KEYS = Object.keys(MODULES);

// Permissions that only LOOK, although they are not called "view": they read more, but change nothing and need no form.
const READS = new Set(["reports.financial"]);
const isRead = (k) => k.endsWith(".view") || READS.has(k);
const KEYS = MODULE_KEYS.flatMap((m) => Object.keys(MODULES[m].actions).map((a) => `${m}.${a}`));
const KEY_SET = new Set(KEYS);
const isKey = (k) => KEY_SET.has(k);

// What a permission brings with it. `view` of the same module comes with every other action there (added in
// expand()); these are the cross-module needs, found by asking what the screen reads to do its job.
const IMPLIES = {
  "sales.approve": ["inventory.view"],
  "purchase.approve": ["inventory.view"],
  "finance.create": ["sales.view", "purchase.view"], // a receipt is allocated against invoices, so they must be visible
  "finance.approve": ["sales.view", "purchase.view"],
  "reports.vat": ["reports.financial"],
  "reports.financial": ["reports.view"],
  "banking.reconcile": ["banking.view", "finance.view"],
  "accounts.close": ["accounts.view"],
};

/**
 * Whatever a role names, widened to what it really grants, as a sorted list of valid keys. Idempotent: expanding an
 * expanded set changes nothing. An unknown key is dropped (it can grant nothing), never guessed at.
 */
function expand(keys) {
  const out = new Set();
  const add = (k) => {
    if (!isKey(k) || out.has(k)) return;
    out.add(k);
    for (const more of IMPLIES[k] || []) add(more);
    const [module, action] = k.split(".");
    if (action !== "view") add(`${module}.view`); // doing anything in a module means being able to see it
    if (!isRead(k)) add("lookups.view"); // and anything beyond looking means filling in forms, which needs the pick lists
  };
  for (const k of keys || []) add(k);
  return [...out].sort();
}

/** Keys a role names that are not in the catalogue (a typo, or one a newer version removed). */
const unknownKeys = (keys) => (keys || []).filter((k) => !isKey(k));

const ALL_KEYS = expand(KEYS);
const only = (...keys) => expand(keys);
const modules = (...names) => KEYS.filter((k) => names.includes(k.split(".")[0]));

// The roles every organisation starts with. They are code, not rows: they cannot drift between customers, they need
// no migration, and improving one improves it for everybody. The first five are the account types the system already
// had, so every existing account keeps exactly the role it has today (Admin.roleKey falls back to its type).
const BUILT_IN = {
  super_admin: {
    key: "super_admin",
    name: "Owner",
    rank: 100,
    description: "Everything, including changing administrators.",
    permissions: ALL_KEYS,
  },
  admin: {
    key: "admin",
    name: "Administrator",
    rank: 80,
    description: "Everything, and manages the people below administrator.",
    permissions: ALL_KEYS,
  },
  manager: {
    key: "manager",
    name: "Manager",
    rank: 60,
    description: "Approves sales, purchases and vouchers, and runs stock. Does not manage people, settings or the books' setup.",
    permissions: only(
      ...modules("sales", "purchase", "inventory"),
      "finance.view", "finance.create", "finance.approve", "finance.delete",
      "banking.view", "accounts.view", "reports.view", "reports.financial"
    ),
  },
  accountant: {
    key: "accountant",
    name: "Accountant",
    rank: 50,
    description: "Keeps the books: vouchers, banking, the chart and tax codes, and financial reports. Cannot close a period or manage people.",
    permissions: only(
      ...modules("finance", "banking"),
      "accounts.view", "accounts.manage",
      "reports.view", "reports.financial", "reports.vat",
      "sales.view", "purchase.view", "inventory.view", "audit.view"
    ),
  },
  operator: {
    key: "operator",
    name: "Operator",
    rank: 40,
    description: "Enters documents and stock. Cannot approve or delete anything.",
    permissions: only("sales.create", "purchase.create", "inventory.create", "inventory.adjust", "finance.create", "reports.view"),
  },
  sales: {
    key: "sales",
    name: "Sales executive",
    rank: 40,
    description: "Raises quotations, orders and delivery notes and sends them to customers. Cannot approve.",
    permissions: only("sales.create", "sales.send", "inventory.view", "reports.view"),
  },
  purchase: {
    key: "purchase",
    name: "Purchase officer",
    rank: 40,
    description: "Raises purchase orders and returns. Cannot approve.",
    permissions: only("purchase.create", "inventory.view", "reports.view"),
  },
  storekeeper: {
    key: "storekeeper",
    name: "Storekeeper",
    rank: 40,
    description: "Looks after items and stock, including adjustments. Sees sales and purchase documents but cannot raise them.",
    permissions: only("inventory.create", "inventory.adjust", "sales.view", "purchase.view", "reports.view"),
  },
  viewer: {
    key: "viewer",
    name: "Viewer",
    rank: 20,
    description: "Can look at everything except people, settings and the activity trail. Cannot change anything.",
    permissions: only("sales.view", "purchase.view", "inventory.view", "finance.view", "banking.view", "accounts.view", "reports.view", "reports.financial"),
  },
};
const BUILT_IN_KEYS = Object.keys(BUILT_IN);
const isBuiltIn = (key) => Object.prototype.hasOwnProperty.call(BUILT_IN, key);
const TOP_RANK = BUILT_IN.super_admin.rank;
// The account types that existed before roles: an Admin with no roleKey is the role of its type.
const LEGACY_TYPES = ["super_admin", "admin", "manager", "operator", "viewer"];

/** A role object (built-in, or a custom one from the database) as { key, name, rank, permissions, builtIn }. */
function resolveRole(key, customRoles = []) {
  if (isBuiltIn(key)) return { ...BUILT_IN[key], permissions: [...BUILT_IN[key].permissions], builtIn: true, isActive: true };
  const custom = (customRoles || []).find((r) => r && r.key === key);
  if (!custom) return null;
  return { key: custom.key, name: custom.name, rank: Number(custom.rank) || 0, description: custom.description || "", permissions: expand(custom.permissions), builtIn: false, isActive: custom.isActive !== false };
}

/**
 * What a person holds. A role that is missing or switched off holds NOTHING - never a default - so a deleted role
 * cannot quietly hand its people something they should not have.
 */
function grantsOf(role) {
  if (!role || role.isActive === false) return [];
  return expand(role.permissions);
}

/** The role key of an account: its explicit role, else the type it has always had. */
const roleKeyOf = (account) => account?.roleKey || account?.type || null;

/** Does a set of granted keys include this one? `granted` is any array or Set of keys. */
const can = (granted, key) => {
  if (!granted) return false;
  return granted instanceof Set ? granted.has(key) : granted.includes(key);
};

/** Holds at least one of the keys. An empty list asks for nothing and is refused: a guard must name what it wants. */
const canAny = (granted, keys) => Array.isArray(keys) && keys.length > 0 && keys.some((k) => can(granted, k));

/**
 * May `actor` do `action` to an account holding role `target`, moving it to role `next`? -> { ok } or { ok:false, code, message }.
 * Actor and target are roles ({ rank, permissions }) or the key of a built-in role. Rules:
 *   - the actor must hold users.manage at all;
 *   - they may only touch someone of a LOWER rank than their own (the top rank may also touch its equals, so an
 *     owner can make another owner), and may not move anyone to a rank at or above their own;
 *   - nobody removes their own account.
 */
function mayManage({ actor, target, next, self = false, action = "update" }) {
  const a = typeof actor === "string" ? resolveRole(actor) : actor;
  const t = typeof target === "string" ? resolveRole(target) : target;
  const n = typeof next === "string" ? resolveRole(next) : next;
  if (!a || !can(grantsOf(a), "users.manage")) {
    return { ok: false, code: "INSUFFICIENT_ROLE", message: "Only an administrator can manage user accounts." };
  }
  if (self && action === "delete") return { ok: false, code: "CANNOT_REMOVE_SELF", message: "You cannot remove your own account." };
  const top = a.rank >= TOP_RANK;
  const above = (r) => top || r.rank < a.rank;
  const privileged = (r) => r.rank >= BUILT_IN.admin.rank;
  if (t && !above(t)) {
    return privileged(t)
      ? { ok: false, code: "SUPER_ADMIN_REQUIRED", message: "Only a super administrator can change an administrator account." }
      : { ok: false, code: "RANK_TOO_LOW", message: "You can only change people whose role is below yours." };
  }
  if (n && !above(n)) {
    return privileged(n)
      ? { ok: false, code: "SUPER_ADMIN_REQUIRED", message: "Only a super administrator can make someone an administrator." }
      : { ok: false, code: "RANK_TOO_LOW", message: "You can only give a role that is below yours." };
  }
  return { ok: true };
}

const KEY_FORMAT = /^[a-z][a-z0-9_]{1,29}$/;

/**
 * Is this a role an actor may save? A custom role may not be built like a built-in one, may not name a permission that
 * does not exist, may not sit at or above the actor's own rank, and may not grant what the actor does not hold - so
 * nobody can build a role more powerful than themselves. -> { ok, errors: { field: message } }.
 */
function validateCustomRole({ key, name, rank, permissions }, actor, { isNew = true } = {}) {
  const errors = {};
  const actorRole = typeof actor === "string" ? resolveRole(actor) : actor;
  if (isNew) {
    if (!KEY_FORMAT.test(String(key || ""))) errors.key = "A role key is 2 to 30 lower-case letters, digits or underscores, starting with a letter";
    else if (isBuiltIn(key)) errors.key = "That key belongs to a built-in role";
  }
  if (!String(name || "").trim()) errors.name = "The role needs a name";
  else if (String(name).trim().length > 60) errors.name = "A role name is at most 60 characters";
  const r = Number(rank);
  if (!Number.isInteger(r) || r < 10 || r > 90) errors.rank = "A rank is a whole number from 10 to 90";
  else if (actorRole && actorRole.rank < TOP_RANK && r >= actorRole.rank) errors.rank = "A role cannot rank at or above your own";
  else if (actorRole && actorRole.rank >= TOP_RANK && r >= TOP_RANK) errors.rank = "A custom role ranks below the owner";
  const wrong = unknownKeys(permissions);
  if (wrong.length) errors.permissions = `Not a known permission: ${wrong.join(", ")}`;
  else if (actorRole) {
    const held = new Set(grantsOf(actorRole));
    const beyond = expand(permissions).filter((k) => !held.has(k));
    if (beyond.length) errors.permissions = `You cannot grant what you do not hold: ${beyond.join(", ")}`;
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

// One router serves all four trade documents, so what a person may do to one depends on its TYPE, not its address.
const DOCUMENT_MODULE = { sales_order: "sales", sales_return: "sales", purchase_order: "purchase", purchase_return: "purchase" };

/** The module a trade document belongs to. An unknown type is treated as sales: the request is refused further on anyway. */
const moduleOfType = (type) => DOCUMENT_MODULE[type] || "sales";

/** The document types a person may look at, from what they hold: sales.view brings the sales ones, purchase.view the purchase ones. */
const viewableTypes = (granted) => Object.keys(DOCUMENT_MODULE).filter((t) => can(granted, `${DOCUMENT_MODULE[t]}.view`));

/** The seven coarse permissions the access token has always carried, derived from the real grants. */
function legacyPermissions(grants, rank = 0) {
  const g = new Set(grants || []);
  const any = (...keys) => keys.some((k) => g.has(k));
  const out = [];
  if (g.has("users.manage")) out.push("users_manage");
  if (any("inventory.create", "inventory.adjust")) out.push("inventory_manage");
  if (any("sales.create", "purchase.create", "finance.create")) out.push("transactions_manage");
  if (any("sales.approve", "purchase.approve", "finance.approve")) out.push("transactions_approve");
  if (g.has("reports.financial")) out.push("financial_reports");
  if (g.has("settings.manage")) out.push("system_settings");
  if (rank >= TOP_RANK) out.push("backup_restore");
  return out;
}

/** What the role editor draws: every module, with its actions, labelled. Sent by the server so the screen never keeps its own copy. */
const catalogue = () =>
  MODULE_KEYS.map((m) => ({
    key: m,
    label: MODULES[m].label,
    hint: MODULES[m].hint,
    automatic: m === "lookups", // ticked for you whenever a role does anything beyond looking
    actions: Object.entries(MODULES[m].actions).map(([action, label]) => ({ key: `${m}.${action}`, action, label })),
  }));

module.exports = {
  MODULES, MODULE_KEYS, KEYS, ALL_KEYS, IMPLIES, BUILT_IN, BUILT_IN_KEYS, LEGACY_TYPES, TOP_RANK,
  isKey, isRead, isBuiltIn, expand, unknownKeys, resolveRole, grantsOf, roleKeyOf, can, canAny, mayManage,
  validateCustomRole, legacyPermissions, catalogue, DOCUMENT_MODULE, moduleOfType, viewableTypes,
};
