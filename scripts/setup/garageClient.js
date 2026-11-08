// Set up a LIVE garage client on an empty database: the organisation, a chart a workshop can read, the
// labour items, the bays and the service menu. It creates no customers, no vehicles and no documents -
// a paying client starts with empty books.
//
// It goes through the REAL services, exactly as scripts/demo/garageDemo.js does, so the organisation is
// made by the same path the developer console uses and every account, item and master is the record the
// app would have written itself. The difference from the demo is what is left out, and one thing put in:
// the demo points every labour item at the default chart's generic "Other Income" because there is
// nowhere else to put it, which leaves a workshop's main margin OUTSIDE Sales Income. This script adds
// the accounts first and points the items at them.
//
//   node scripts/setup/garageClient.js --env=.env.golden-arrow --code=golden-arrow --yes
//
// Flags:
//   --env=<file>          env file to load, relative to the repo root (default .env)
//   --code=<slug>         the organisation code - STAMPED ON EVERY RECORD AND LOCKED FOREVER
//   --name="..."          legal name          --trade="..."  trade name
//   --admin=<email>       the owner's sign-in  --admin-name="..."
//   --plan=<code>         default standard
//   --docs-limit=<n>      cap documents a month (standard already allows 2000; this only ever LOWERS it)
//   --features=a,b        extra feature overrides, e.g. reconciliation,ifrsStatements,multiBranch
//   --expect-host=<host>  refuse to run unless MONGO_URI names this host
//   --yes                 actually do it (without this it prints what it would do and stops)
//
// Safe to run twice: the organisation is reused, and every account, unit, item, bay, service and role
// is skipped if it already exists. A half-finished run is fixed by running it again.
const path = require("path");
const crypto = require("crypto");

const arg = (name, fallback = null) => {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

// The env file is loaded BEFORE any service is required: config/cloudinary and friends read
// process.env as they load, and a client's MONGO_URI must never come from the development .env.
const ENV_FILE = arg("env", ".env");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ENV_FILE) });

const CODE = arg("code", "golden-arrow");
const LEGAL_NAME = arg("name", "Golden Arrow Auto Garage LLC");
const TRADE_NAME = arg("trade", "Golden Arrow");
const ADMIN_EMAIL = arg("admin", `owner@${CODE}.ae`);
const ADMIN_NAME = arg("admin-name", "Workshop owner");
const PLAN = arg("plan", "standard");
const DOCS_LIMIT = arg("docs-limit", null);
const FEATURES = String(arg("features", "")).split(",").map((s) => s.trim()).filter(Boolean);
const EXPECT_HOST = arg("expect-host", null);
const BY = "setup-script";

// ---------------------------------------------------------------------------------------------------
// What a workshop needs that the default chart does not have.
//
// These are CLIENT DATA, not a change to utils/defaultChart.js: that file is the chart every new
// organisation starts with (a food trader would not want "Paint & Body Materials") and it is
// parity-mirrored in zarvia-platform. No posting KEY is added either - a labour line reaches its
// account through the service item's own incomeAccountId, which utils/itemKinds.js routeServiceLegs
// honours, so accountConfigSeed.js and its mirror are untouched too.
//
// [account name, existing group name, description]
const ACCOUNTS = [
  ["Labour Income", "Sales Income", "Repair and service labour charged to the customer"],
  ["Sublet & Outside Work Income", "Sales Income", "Outside work recharged to the customer"],
  ["Consumables & Shop Supplies Recovered", "Sales Income", "Shop supplies charged on the invoice"],
  ["Recovery & Towing Income", "Other Income", "Recovery and towing, incidental to the repair trade"],

  ["Sublet & Subcontract Charges", "Cost of Goods Sold", "What the coater, machinist or A/C shop billed us"],
  ["Consumables & Shop Supplies", "Cost of Goods Sold", "Rags, cleaners, gas, abrasives consumed in the workshop"],
  ["Paint & Body Materials", "Cost of Goods Sold", "Paint, thinner, filler and primer"],
  ["Workshop Wages - Technicians", "Cost of Goods Sold", "Direct labour cost, so gross margin is the real one"],

  ["Tools & Equipment Maintenance", "Operating Expenses", "Lifts, compressors, scanners and hand tools"],
  ["Waste Oil & Waste Disposal", "Operating Expenses", "Licensed disposal of waste oil and filters"],
  ["Workshop Insurance", "Operating Expenses", "Motor-trade and garage liability cover"],
  ["Trade Licence & Government Fees", "Operating Expenses", "Trade licence, RTA test and registration fees"],

  ["Workshop Tools & Equipment", "Fixed Assets", "The workshop plant itself, apart from furniture and vehicles"],
];

// A service item's unit. The starter units are Each / Kilogram / Litre only, and the UOM category enum
// has no "Time", so an hour is filed under Quantity.
const UNITS = [
  { unitName: "Hour", shortCode: "hr", category: "Quantity" },
  { unitName: "Job", shortCode: "job", category: "Quantity" },
];

const CATEGORY = "Workshop Services";

// Labour and sublet as SERVICE items (itemType: "service"), each naming its own income account. This is
// the mechanism the chart above exists for: routeServiceLegs moves a service line's gross to the item's
// incomeAccountId, with no inventory leg, no COGS and no stock movement.
//
// NOTE on SHOP-SUP: a job-card line's kind is one of part | labour | sublet | consumable, and
// jobCardService checks it against the item master - part and consumable need a GOODS item, labour and
// sublet need a service item (400 LINE_KIND_MISMATCH otherwise). SHOP-SUP is a service item, so it is
// billed on a LABOUR line. A true `consumable` line needs a stocked item from the client's own parts.
const ITEMS = [
  { sku: "LAB-MECH", itemName: "Labour - mechanical", unit: "Hour", salesPrice: 150, income: "Labour Income" },
  { sku: "LAB-ELEC", itemName: "Labour - electrical & diagnostics", unit: "Hour", salesPrice: 150, income: "Labour Income" },
  { sku: "LAB-AC", itemName: "Labour - air conditioning", unit: "Hour", salesPrice: 160, income: "Labour Income" },
  { sku: "LAB-BODY", itemName: "Labour - body, denting & paint", unit: "Hour", salesPrice: 180, income: "Labour Income" },
  { sku: "LAB-SERV", itemName: "Labour - periodic service", unit: "Job", salesPrice: 250, income: "Labour Income" },
  {
    sku: "SUB-WORK", itemName: "Sublet / outside work", unit: "Job", salesPrice: 0,
    income: "Sublet & Outside Work Income", expense: "Sublet & Subcontract Charges",
  },
  {
    sku: "SHOP-SUP", itemName: "Shop supplies & consumables", unit: "Job", salesPrice: 50,
    income: "Consumables & Shop Supplies Recovered", expense: "Consumables & Shop Supplies",
  },
];

const BAYS = [
  { name: "Ramp 1", code: "R1", kind: "mechanical" },
  { name: "Ramp 2", code: "R2", kind: "mechanical" },
  { name: "Body shop", code: "B1", kind: "body" },
  { name: "Paint booth", code: "PB1", kind: "paint" },
  { name: "Wash bay", code: "W1", kind: "wash" },
];

// The service menu: a standard job that fills a job card's estimate and tasks in one tap.
// defaultParts is deliberately EMPTY - this client's parts catalogue is their own, so a standard job
// fills in the labour and the tasks and the advisor adds the parts. The Setup SCREEN cannot set
// defaultTasks at all (its dialog has no field for them), so seeding them here is the only way.
const SERVICES = [
  { code: "OIL", name: "Oil & filter change", category: "Servicing", item: "LAB-SERV", standardHours: 0.5,
    defaultTasks: [{ name: "Drain oil, replace filter, refill and check", mode: "in_house", standardHours: 0.5 }] },
  { code: "BRAKE", name: "Brake pad replacement", category: "Brakes", item: "LAB-MECH", standardHours: 1,
    defaultTasks: [{ name: "Replace brake pads and bed in", mode: "in_house", standardHours: 1 }] },
  { code: "AC", name: "A/C service & gas top-up", category: "Air conditioning", item: "LAB-AC", standardHours: 1.5,
    defaultTasks: [
      { name: "Check for leaks and pressure-test", mode: "in_house", standardHours: 0.5 },
      { name: "Evacuate, recharge and test cooling", mode: "in_house", standardHours: 1 },
    ] },
  { code: "DIAG", name: "Diagnostics & scan", category: "Diagnostics", item: "LAB-ELEC", standardHours: 1,
    defaultTasks: [{ name: "Scan, read codes and report", mode: "in_house", standardHours: 1 }] },
  { code: "BATT", name: "Battery replacement", category: "Electrical", item: "LAB-ELEC", standardHours: 0.5,
    defaultTasks: [{ name: "Replace battery and test charging", mode: "in_house", standardHours: 0.5 }] },
  { code: "PANEL", name: "Panel beating & paint", category: "Body & accident", item: "LAB-BODY", standardHours: 6,
    defaultTasks: [
      { name: "Strip and assess panel damage", mode: "in_house", standardHours: 1 },
      { name: "Beat out and fill panel", mode: "in_house", standardHours: 2 },
      { name: "Prime, paint and polish", mode: "in_house", standardHours: 3 },
    ] },
  { code: "WASH", name: "Wash & polish", category: "Valeting", item: "LAB-SERV", standardHours: 1,
    defaultTasks: [{ name: "Wash, dry and polish", mode: "in_house", standardHours: 1 }] },
];

// Only the Owner and the Administrator hold any garage.* permission - Manager, Accountant, Operator,
// Sales, Purchase, Storekeeper and Viewer hold NONE - so a workshop's own people need custom roles.
// sales.create and purchase.create are here because the garage controller asserts them on top of the
// garage key: jobCardController.js:104 asserts sales.create for "raise the invoice" and :114 asserts
// purchase.create for "raise a purchase order". Without them those two buttons answer 403.
const ROLES = [
  {
    key: "service_advisor", name: "Service advisor", rank: 40,
    description: "Books the car in, prices the estimate, gets the customer's approval and invoices the job",
    permissions: ["garage.view", "garage.create", "garage.edit", "garage.approve", "garage.invoice", "sales.create"],
  },
  {
    key: "workshop_manager", name: "Workshop manager", rank: 60,
    description: "Runs the workshop: the board, the service menu, the bays, claims and parts ordering",
    permissions: [
      "garage.view", "garage.create", "garage.edit", "garage.delete", "garage.approve", "garage.invoice",
      "garage.manage", "sales.create", "purchase.create", "inventory.view",
    ],
  },
  {
    key: "technician", name: "Technician", rank: 20,
    description: "Works the tasks they are given on a job card",
    permissions: ["garage.view"],
  },
];

// ---------------------------------------------------------------------------------------------------

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exact = (s) => new RegExp(`^${esc(s)}$`, "i");

// A password nobody has seen, printed once. The owner is created with mustChangePassword, so this only
// has to survive the first sign-in.
const newPassword = () => `${crypto.randomBytes(9).toString("base64url")}-${crypto.randomInt(10, 99)}`;

const tally = [];
const note = (what, created, skipped) => tally.push({ what, created, skipped });

// Read the flags that name a plan, a feature or a limit, and refuse a typo. Called BEFORE the database
// is touched: "--features=reconcilliation" must cost nothing, not half a set-up.
function readPlanFlags() {
  const plans = require("../../utils/plans");
  if (!plans.PLAN_CODES.includes(PLAN)) {
    throw new Error(`--plan "${PLAN}" is not a known plan. One of: ${plans.PLAN_CODES.join(", ")}`);
  }
  const featureOverrides = {};
  for (const f of FEATURES) {
    if (!(f in plans.FEATURES)) {
      throw new Error(`--features: "${f}" is not a known feature. One of: ${plans.FEATURE_KEYS.join(", ")}`);
    }
    featureOverrides[f] = true;
  }
  const limitOverrides = {};
  if (DOCS_LIMIT !== null) {
    const n = Number(DOCS_LIMIT);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--docs-limit must be a whole number above 0, not "${DOCS_LIMIT}"`);
    limitOverrides.documentsPerMonth = n;
  }
  return { featureOverrides, limitOverrides };
}

async function ensureOrganisation({ featureOverrides, limitOverrides }) {
  const Organisation = require("../../models/core/organisationModel");
  const existing = await Organisation.findOne({ code: CODE }).lean();
  if (existing) {
    console.log(`  organisation "${CODE}" already exists (${existing.legalName}); reusing it`);
    note("organisation", 0, 1);
    return { organisation: existing, password: null };
  }

  const password = newPassword();
  const PlatformOrganisationService = require("../../services/platform/platformOrganisationService");
  const result = await PlatformOrganisationService.create(
    {
      code: CODE,
      legalName: LEGAL_NAME,
      tradeName: TRADE_NAME,
      // These three are 409-LOCKED the instant the organisation exists (CODE_LOCKED,
      // BASE_CURRENCY_LOCKED, COUNTRY_LOCKED). country: "AE" is also what seeds the UAE tax codes.
      country: "AE",
      baseCurrency: "AED",
      timezone: "Asia/Dubai",
      planCode: PLAN,
      moduleOverrides: { garage: true }, // an opt-in vertical: no plan carries it, not even internal
      featureOverrides,
      limitOverrides,
      firstAdmin: { name: ADMIN_NAME, email: ADMIN_EMAIL, password },
    },
    { by: { email: BY } }
  );

  if (result.firstAdminError) throw new Error(`the organisation was made but its owner was not: ${result.firstAdminError}`);
  if (!result.provisioning?.complete) {
    console.log("  provisioning did not finish; running it again");
    const OrganisationService = require("../../services/core/organisationService");
    const again = await OrganisationService.provision(CODE);
    if (!again.complete) {
      console.log(`  provisioning steps: ${JSON.stringify(again.steps, null, 2)}`);
      throw new Error("provisioning is still incomplete - fix the failing step before seeding on top of it");
    }
  }
  console.log(`  organisation created: ${CODE} (${result.organisation.legalName})`);
  note("organisation", 1, 0);
  return { organisation: result.organisation, password };
}

async function seedAccounts() {
  const AccountGroup = require("../../models/modules/financial/accountGroupModel");
  const { LedgerAccount } = require("../../models/modules/financial/financialModels");
  const Chart = require("../../services/financial/chartOfAccountsService");

  const groups = new Map((await AccountGroup.find().lean()).map((g) => [String(g.name).toLowerCase(), g]));
  let created = 0;
  let skipped = 0;
  for (const [name, groupName, description] of ACCOUNTS) {
    // The duplicate check in createAccount is company-wide and case-insensitive, so ask the same way.
    if (await LedgerAccount.findOne({ accountName: exact(name), isActive: true }).lean()) {
      skipped += 1;
      continue;
    }
    const group = groups.get(groupName.toLowerCase());
    if (!group) throw new Error(`the chart has no group named "${groupName}" - was the organisation provisioned?`);
    const made = await Chart.createAccount({ accountName: name, groupId: group._id, description }, null, BY);
    console.log(`    + ${made.accountCode}  ${name}  (${groupName})`);
    created += 1;
  }
  note("chart accounts", created, skipped);
}

async function seedUnitsAndCategory() {
  const UOM = require("../../models/modules/uomModel");
  const UOMService = require("../../services/unit/uomService");
  const Category = require("../../models/modules/categoryModel");

  let created = 0;
  let skipped = 0;
  for (const unit of UNITS) {
    if (await UOM.findOne({ unitName: exact(unit.unitName) }).lean()) {
      skipped += 1;
      continue;
    }
    await UOMService.createUOM({ ...unit, type: "Base", status: "Active" });
    created += 1;
  }
  note("units", created, skipped);

  const had = await Category.findOne({ name: exact(CATEGORY) }).lean();
  if (!had) await Category.create({ name: CATEGORY, status: "Active" });
  note("item category", had ? 0 : 1, had ? 1 : 0);
}

async function seedServiceItems() {
  const Stock = require("../../models/modules/stockModel");
  const StockService = require("../../services/stock/stockService");
  const UOM = require("../../models/modules/uomModel");
  const Category = require("../../models/modules/categoryModel");
  const { LedgerAccount } = require("../../models/modules/financial/financialModels");

  const category = await Category.findOne({ name: exact(CATEGORY) }).lean();
  const units = new Map((await UOM.find().lean()).map((u) => [String(u.unitName).toLowerCase(), u]));
  const accounts = new Map((await LedgerAccount.find().lean()).map((a) => [String(a.accountName).toLowerCase(), a]));
  const accountId = (name) => {
    const found = accounts.get(String(name).toLowerCase());
    if (!found) throw new Error(`no ledger account named "${name}" - the chart step must run first`);
    return found._id;
  };

  const made = {};
  let created = 0;
  let skipped = 0;
  for (const item of ITEMS) {
    const found = await Stock.findOne({ sku: item.sku }).lean();
    if (found) {
      made[item.sku] = found;
      skipped += 1;
      continue;
    }
    const unit = units.get(item.unit.toLowerCase());
    if (!unit) throw new Error(`no unit named "${item.unit}"`);
    made[item.sku] = await StockService.createStock(
      {
        sku: item.sku,
        itemName: item.itemName,
        categoryId: category._id,
        unitOfMeasure: unit._id,
        salesPrice: item.salesPrice,
        itemType: "service", // no quantity, no batch, no costing - and no stock leg when it is sold
        incomeAccountId: accountId(item.income),
        ...(item.expense ? { expenseAccountId: accountId(item.expense) } : {}),
      },
      BY
    );
    console.log(`    + ${item.sku}  ${item.itemName}  -> ${item.income}`);
    created += 1;
  }
  note("labour & sublet items", created, skipped);
  return made;
}

async function seedBays() {
  const Bay = require("../../models/modules/garage/bayModel");
  const Setup = require("../../services/garage/garageSetupService");
  let created = 0;
  let skipped = 0;
  for (const bay of BAYS) {
    if (await Bay.findOne({ name: exact(bay.name) }).lean()) {
      skipped += 1;
      continue;
    }
    await Setup.createBay(bay, BY);
    created += 1;
  }
  note("bays", created, skipped);
}

async function seedServiceMenu(items) {
  const GarageService = require("../../models/modules/garage/garageServiceModel");
  const Setup = require("../../services/garage/garageSetupService");
  let created = 0;
  let skipped = 0;
  for (const svc of SERVICES) {
    if (await GarageService.findOne({ code: svc.code.toUpperCase() }).lean()) {
      skipped += 1;
      continue;
    }
    const item = items[svc.item];
    if (!item) throw new Error(`the service menu names item "${svc.item}", which was not created`);
    await Setup.createService(
      {
        code: svc.code,
        name: svc.name,
        category: svc.category,
        serviceItemId: item._id,
        standardHours: svc.standardHours,
        defaultTasks: svc.defaultTasks,
        // defaultParts stays empty: the client's own parts catalogue is not seeded.
      },
      BY
    );
    created += 1;
  }
  note("service menu", created, skipped);
}

async function seedRoles() {
  const Role = require("../../models/core/roleModel");
  const RoleService = require("../../services/core/roleService");
  const perms = require("../../utils/permissions");

  // RoleService reads the actor off a request to check "you cannot grant what you do not hold" and the
  // rank rules. The script acts as the owner, which is who would be making these roles by hand.
  const asOwner = {
    admin: {
      email: BY,
      role: { key: "super_admin", rank: perms.TOP_RANK, active: true },
      grants: perms.ALL_KEYS,
    },
  };

  let created = 0;
  let skipped = 0;
  for (const role of ROLES) {
    if (await Role.exists({ key: role.key })) {
      skipped += 1;
      continue;
    }
    await RoleService.create(role, asOwner);
    console.log(`    + ${role.name} (rank ${role.rank})`);
    created += 1;
  }
  note("roles", created, skipped);
}

function hostOf(uri) {
  const match = /@([^/?]+)/.exec(String(uri || ""));
  return match ? match[1] : "(could not read the host)";
}

// runMigrations looks models up by name (`mongoose.model("Transaction")`), so every schema has to be
// registered before it runs. server.js gets that for free by requiring all its routers at the top;
// a script has to ask. Requiring a model file only defines its schema, so this is safe in any order.
function registerModels() {
  const fs = require("fs");
  const root = path.resolve(__dirname, "..", "..", "models");
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) require(full);
    }
  };
  walk(root);
  return require("mongoose").modelNames().length;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error(`MONGO_URI is not set. Is ${ENV_FILE} there, and does it have one?`);
  if (process.env.NODE_ENV === "test") throw new Error("refusing to run with NODE_ENV=test");
  const host = hostOf(uri);
  if (EXPECT_HOST && !host.includes(EXPECT_HOST)) {
    throw new Error(`MONGO_URI names ${host}, not ${EXPECT_HOST}. Refusing to touch the wrong cluster.`);
  }
  const overrides = readPlanFlags();

  console.log("");
  console.log("  Set up a garage client");
  console.log(`  env file     ${ENV_FILE}`);
  console.log(`  cluster      ${host}`);
  console.log(`  organisation ${CODE}  (${LEGAL_NAME})`);
  console.log(`  owner        ${ADMIN_EMAIL}`);
  console.log(`  plan         ${PLAN} + garage${FEATURES.length ? ` + ${FEATURES.join(", ")}` : ""}`);
  console.log(`  documents    ${DOCS_LIMIT === null ? "the plan's own limit" : `${DOCS_LIMIT} a month (an override)`}`);
  console.log("");

  if (!flag("yes")) {
    console.log("  Nothing was done. Add --yes to go ahead.");
    console.log("");
    return;
  }

  const mongoose = require("mongoose");
  await mongoose.connect(uri);
  try {
    // On an empty cluster this is what creates the collections and the per-organisation unique
    // indexes (syncIndexes over 21 models) - the uniqueness that stops two documents sharing a
    // number. Idempotent, and it means the cluster needs no server boot before this script.
    console.log("  Indexes and collections...");
    console.log(`    ${registerModels()} models registered`);
    const { runMigrations } = require("../../utils/migrations");
    const changed = await runMigrations();
    if (changed && Object.keys(changed).length) console.log(`    ${JSON.stringify(changed)}`);

    console.log("  Organisation...");
    const { organisation, password } = await ensureOrganisation(overrides);

    // create() warms the locale itself, but a REUSED organisation never goes through create, and
    // without the warm every figure below is computed in the wrong zone and currency.
    require("../../utils/orgLocale").warm(organisation);

    const { runWithTenant } = require("../../utils/tenantContext");
    await runWithTenant({ companyId: CODE, branchId: "main" }, async () => {
      console.log("  Chart of accounts...");
      await seedAccounts();
      console.log("  Units and category...");
      await seedUnitsAndCategory();
      console.log("  Labour and sublet items...");
      const items = await seedServiceItems();
      console.log("  Bays...");
      await seedBays();
      console.log("  Service menu...");
      await seedServiceMenu(items);
      console.log("  Roles...");
      await seedRoles();
    });

    console.log("");
    console.log("  What was done");
    for (const row of tally) {
      console.log(`    ${row.what.padEnd(24)} ${String(row.created).padStart(3)} created, ${String(row.skipped).padStart(3)} already there`);
    }

    if (password) {
      console.log("");
      console.log("  ---------------------------------------------------------------------");
      console.log(`  Sign in as   ${ADMIN_EMAIL}`);
      console.log(`  Password     ${password}`);
      console.log("  Shown once and stored nowhere. A new password is asked for at the first sign-in.");
      console.log("  ---------------------------------------------------------------------");
    }

    console.log("");
    console.log("  Worth knowing");
    console.log("   - Technician wages: HRMS payroll posts to Salaries & Wages through the salary-expense");
    console.log("     key. To make them land in Workshop Wages - Technicians and show inside gross profit,");
    console.log("     remap salary-expense in Accounting setup > Posting accounts, or move it by journal.");
    console.log("   - SHOP-SUP is a service item, so bill it on a LABOUR line. A `consumable` line needs a");
    console.log("     stocked goods item, which arrives with the client's own parts catalogue.");
    console.log("   - A standard job fills in the labour and the tasks but NO parts: defaultParts is empty");
    console.log("     until the client's parts exist. The Setup screen cannot set them; the API can.");
    console.log("");
    console.log("  Still to do by hand");
    console.log("   1. Settings > Company: real legal name, trade name, address, logo.");
    console.log("   2. Settings > Business rules > Tax identity: the 15-digit TRN and the emirate.");
    console.log("      Without a TRN an approved sale prints \"Invoice\", not \"Tax invoice\".");
    console.log("   3. First sign-in as the owner, then two-factor (only once SECRET_BOX_KEY is final).");
    console.log("   4. People: the real users, on the three roles above.");
    console.log("   5. Parts, customers, insurers (tick Insurer) and staff: the client's own.");
    console.log("   6. Opening balances, if they are moving from existing books.");
    console.log("   7. Schedule `npm run backup` against this cluster and rehearse one restore.");
    console.log("");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error("");
  console.error(`  setup failed: ${error.message}`);
  if (error.code) console.error(`  code: ${error.code}`);
  console.error("");
  process.exit(1);
});
