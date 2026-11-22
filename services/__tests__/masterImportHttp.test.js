// A spreadsheet of customers, vendors and items, over HTTP against a strict server with real sign-ins (utils/masterImport.js,
// services/masters/partyImportService.js, services/stock/itemImportService.js).
//
// What is proved: a file is PREVIEWED and nothing is written until `dryRun: false`; a written row is the form's own save (its number, its ledger
// account, its VAT block and terms); the same file twice makes nothing the second time; each import needs the create permission of its OWN
// module; a person who may not see what items cost cannot set it, and no import can set a quantity; the audit row says how many and which file,
// never the rows; another organisation's records are not duplicates and are not touched; and a hostile or oversized body is a clean refusal.
//
//   node --require ./utils/testSetup.js --test services/__tests__/masterImportHttp.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { startStack, makeCaller, PASSWORD, skipReason } = require("./support/httpHarness");

const skip = skipReason();
let S, call, M;
const T = {};

const api = (who, method, url, body) => call(method, url, { token: T[who], body: method === "GET" || method === "DELETE" ? undefined : body });
const login = async (email) => (await call("POST", "/login", { body: { email, password: PASSWORD } })).body?.tokens?.accessToken;
const as = (code, fn) => S.as(code, fn);

async function organisation(code, planCode = "premium") {
  const made = await S.Org.create({ legalName: `${code} works`, code, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode });
  assert.equal(made.provisioning.complete, true, `${code} is provisioned`);
  await as(code, () => new M.Admin({ name: `${code} owner`, email: `${code}_owner@${code}.test`, password: PASSWORD, status: "active", isActive: true, type: "super_admin" }).save());
  T[`${code}_owner`] = await login(`${code}_owner@${code}.test`);
  assert.ok(T[`${code}_owner`], `${code} owner signs in`);
}

// A person with exactly these permissions
async function person(org, key, permissions) {
  const role = `${org}_${key}`;
  const made = await api(`${org}_owner`, "POST", "/access/roles", { key: role, name: role.replace(/_/g, " "), rank: 50, permissions });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const added = await api(`${org}_owner`, "POST", "/access/users", { name: role, email: `${role}@${org}.test`, password: PASSWORD, role });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  await as(org, () => M.Admin.updateOne({ email: `${role}@${org}.test` }, { $set: { mustChangePassword: false } }));
  T[role] = await login(`${role}@${org}.test`);
  assert.ok(T[role], `${role} signs in`);
  T[key] = T[role]; // the tests name a person by what they are ("seller"); only one organisation has such people
}

test.before(async () => {
  if (skip) return;
  S = await startStack("imp");
  call = makeCaller(S.base);
  M = {
    Admin: require("../../models/core/adminModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Stock: require("../../models/modules/stockModel"),
    Category: require("../../models/modules/categoryModel"),
    UOM: require("../../models/modules/uomModel"),
    InventoryMovement: require("../../models/modules/inventoryMovementModel"),
    ActivityLog: require("../../models/modules/financial/activityLogModel"),
    LedgerAccount: require("../../models/modules/financial/financialModels").LedgerAccount,
  };
});

test.after(async () => {
  if (skip) return;
  await S?.stop();
});

const rowsOf = (n, make) => Array.from({ length: n }, (_, i) => make(i));

test("two organisations, and the people each needs", { skip }, async () => {
  await organisation("imp");
  await organisation("imptwo");
  await person("imp", "seller", ["sales.create"]);
  await person("imp", "buyer", ["purchase.create"]);
  await person("imp", "viewer", ["sales.view", "purchase.view", "inventory.view"]);
  await person("imp", "stocker", ["inventory.create"]); // adds items, may not see what they cost
  await person("imp", "coster", ["inventory.create", "inventory.viewCost"]);
});

// ---- customers -------------------------------------------------------------------------------------------------------------------

const CUSTOMERS = [
  { line: 2, name: "Al Noor Trading", contactPerson: "Ali", email: "ali@alnoor.ae", phone: "050 123 4567", trn: "100123456700003", paymentTerms: "net 30", creditLimit: "AED 12,500", billingAddress: "Deira", country: "UAE", emirate: "dxb", salesPerson: "Sami" },
  { line: 3, name: "Gulf Foods", email: "accounts@gulffoods.ae", billingAddress: "Al Quoz", city: "Sharjah" },
  { line: 4, name: "Bad Email Co", email: "nope" },
];

test("a preview writes nothing, whatever 'not false' looks like: a missing flag, the word false, zero", { skip }, async () => {
  for (const flag of [undefined, "false", 0, null, "no"]) {
    const r = await api("seller", "POST", "/customers/import", { rows: CUSTOMERS, ...(flag === undefined ? {} : { dryRun: flag }) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.body.dryRun, true, `dryRun: ${JSON.stringify(flag)} is still the preview`);
    assert.deepEqual(r.body.summary, { total: 3, create: 2, invalid: 1, duplicate: 0, skipped: 0 });
  }
  const r = await api("seller", "POST", "/customers/import", { rows: CUSTOMERS, dryRun: true });
  assert.equal(r.body.issues.find((i) => i.line === 4).errors[0].code, "INVALID_EMAIL");
  assert.equal(r.body.sample.length, 2);
  assert.equal(await as("imp", () => M.Customer.countDocuments({})), 0, "nothing was written");
});

test("a written row is the form's own save: its number, its ledger account, its VAT block and its terms", { skip }, async () => {
  const r = await api("seller", "POST", "/customers/import", { rows: CUSTOMERS, dryRun: false, fileName: "customers-2026.xlsx" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.body.dryRun, false);
  assert.equal(r.body.summary.created, 2);
  assert.equal(r.body.summary.invalid, 1);
  assert.equal(r.body.failed.length, 0, JSON.stringify(r.body.failed));
  assert.ok(r.body.created.every((c) => /^CUST\d{4}\d{3}$/.test(c.code)), JSON.stringify(r.body.created));

  const noor = await as("imp", () => M.Customer.findOne({ customerName: "Al Noor Trading" }).lean());
  assert.equal(noor.vat.status, "registered");
  assert.equal(noor.vat.trn, "100123456700003");
  assert.equal(noor.trnNumber, "100123456700003", "the legacy field is kept in step, as the form does");
  assert.equal(noor.paymentTerms, "Net 30");
  assert.equal(noor.credit.days, 30);
  assert.equal(noor.creditLimit, 12500);
  assert.equal(noor.country, "AE");
  assert.equal(noor.emirate, "Dubai");
  assert.equal(noor.phone, "0501234567", "the service squeezes the spaces out, as it does for a typed number");
  const gulf = await as("imp", () => M.Customer.findOne({ customerName: "Gulf Foods" }).lean());
  assert.equal(gulf.emirate, "Sharjah", "a city that names an emirate filled it");
  for (const name of ["Al Noor Trading", "Gulf Foods"]) {
    assert.ok(await as("imp", () => M.LedgerAccount.findOne({ accountName: `Customer - ${name}` }).lean()), `${name} has its account in the chart`);
  }
  assert.equal(await as("imp", () => M.Customer.countDocuments({ customerName: "Bad Email Co" })), 0, "an invalid row is not made");
});

test("the same file again makes nothing: every row is a duplicate, and nothing is doubled", { skip }, async () => {
  const before = await as("imp", () => M.Customer.countDocuments({}));
  const r = await api("seller", "POST", "/customers/import", { rows: CUSTOMERS.slice(0, 2), dryRun: false });
  assert.equal(r.body.summary.created, 0);
  assert.equal(r.body.summary.duplicate, 2);
  assert.deepEqual(r.body.issues.map((i) => i.duplicateOf.by), ["name", "name"]);
  assert.equal(await as("imp", () => M.Customer.countDocuments({})), before);
  // the tax number alone is enough, whatever the name
  const trn = await api("seller", "POST", "/customers/import", { rows: [{ name: "Renamed Co", trn: "100123456700003" }], dryRun: false });
  assert.equal(trn.body.summary.duplicate, 1);
  assert.equal(trn.body.issues[0].duplicateOf.by, "trn");
});

test("the audit row says how many and which file - never a customer's name or number", { skip }, async () => {
  const rows = await as("imp", () => M.ActivityLog.find({ action: "CUSTOMERS_IMPORTED" }).lean());
  assert.ok(rows.length >= 1);
  const first = rows.find((r) => r.after?.fileName === "customers-2026.xlsx");
  assert.ok(first, JSON.stringify(rows.map((r) => r.after)));
  assert.equal(first.after.created, 2);
  const whole = JSON.stringify(rows);
  for (const secret of ["Al Noor", "Gulf Foods", "100123456700003", "ali@alnoor.ae", "0501234567"]) assert.ok(!whole.includes(secret), `"${secret}" is in the audit trail`);
});

test("each import needs the create permission of its OWN module", { skip }, async () => {
  const refused = async (who, url) => {
    const r = await api(who, "POST", url, { rows: [{ name: "X" }], dryRun: false });
    assert.equal(r.status, 403, `${who} ${url}: ${r.status} ${JSON.stringify(r.data)?.slice(0, 150)}`);
    assert.equal(r.code, "PERMISSION_DENIED");
  };
  await refused("viewer", "/customers/import"); // may look at everything, may add nothing
  await refused("viewer", "/vendors/vendors/import");
  await refused("viewer", "/stock/stock/import");
  await refused("buyer", "/customers/import"); // purchase.create is not sales.create
  await refused("seller", "/vendors/vendors/import");
  await refused("seller", "/stock/stock/import");
  await refused("stocker", "/customers/import");
  assert.equal((await api("buyer", "POST", "/vendors/vendors/import", { rows: [{ name: "V", address: "x" }] })).status, 200);
  assert.equal((await api("stocker", "POST", "/stock/stock/import", { rows: [{ name: "X", category: "C", unit: "Kg" }] })).status, 200);
  assert.equal(await as("imp", () => M.Customer.countDocuments({ customerName: "X" })), 0, "a refusal wrote nothing");
});

// ---- vendors ---------------------------------------------------------------------------------------------------------------------

test("vendors: an address is required, a vendor gets its number and its payable account, a second run is all duplicates", { skip }, async () => {
  const rows = [
    { line: 2, name: "Gulf Mills", address: "Jebel Ali", email: "sales@gulfmills.ae", paymentTerms: "30 days", trn: "100999999900001" },
    { line: 3, name: "No Address Ltd" },
  ];
  const preview = await api("buyer", "POST", "/vendors/vendors/import", { rows });
  assert.deepEqual(preview.body.summary, { total: 2, create: 1, invalid: 1, duplicate: 0, skipped: 0 });
  assert.equal(preview.body.issues[0].errors[0].code, "ADDRESS_REQUIRED");
  assert.equal(await as("imp", () => M.Vendor.countDocuments({})), 0);

  const written = await api("buyer", "POST", "/vendors/vendors/import", { rows, dryRun: false, fileName: "vendors.csv" });
  assert.equal(written.body.summary.created, 1, JSON.stringify(written.body));
  assert.match(written.body.created[0].code, /^VEND\d{4}\d{3}$/);
  const mills = await as("imp", () => M.Vendor.findOne({ vendorName: "Gulf Mills" }).lean());
  assert.equal(mills.paymentTerms, "30 days", "'30 days' is one of a vendor's own standard terms, so it is kept as typed");
  assert.equal(mills.trnNO, "100999999900001");
  assert.ok(await as("imp", () => M.LedgerAccount.findOne({ accountName: "Vendor - Gulf Mills" }).lean()));

  const again = await api("buyer", "POST", "/vendors/vendors/import", { rows: [rows[0]], dryRun: false });
  assert.equal(again.body.summary.duplicate, 1);
  assert.equal(await as("imp", () => M.Vendor.countDocuments({})), 1);
});

// ---- items -----------------------------------------------------------------------------------------------------------------------

test("items: categories are listed and made, a unit is never made, SKUs are numbered, and no quantity is ever set", { skip }, async () => {
  // a new organisation is provisioned with starter units (Each, Kilogram, Litre ...), matched here by name or short code
  const unitsBefore = await as("imp", () => M.UOM.countDocuments({}));
  assert.ok(await as("imp", () => M.UOM.findOne({ unitName: "Kilogram" }).lean()), "the starter set has Kilogram");
  const rows = [
    { line: 2, name: "Basmati Rice 5kg", category: "Rice", unit: "kg", salesPrice: "24.50", purchasePrice: "18", reorderLevel: "10", supplier: "gulf mills", quantity: "500", currentStock: "500", origin: "India", brand: "Royal" },
    { line: 3, name: "Brown Rice", category: "rice", unit: "Kg" },
    { line: 4, name: "Oddly Packed", category: "Spices", unit: "Bunch" },
  ];
  const preview = await api("coster", "POST", "/stock/stock/import", { rows });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(preview.body.summary, { total: 3, create: 2, invalid: 1, duplicate: 0, skipped: 0 });
  assert.deepEqual(preview.body.newCategories, ["Rice"], "one new category, once, for the rows that will be made");
  assert.deepEqual(preview.body.missing.units, ["Bunch"], "the unit to add first");
  assert.equal(await as("imp", () => M.Category.countDocuments({})), 0, "the preview made no category");

  const r = await api("coster", "POST", "/stock/stock/import", { rows, dryRun: false, fileName: "items.xlsx" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.body.summary.created, 2, JSON.stringify(r.body));
  assert.equal(r.body.failed.length, 0, JSON.stringify(r.body.failed));
  assert.equal(await as("imp", () => M.Category.countDocuments({ name: "Rice" })), 1);
  assert.equal(await as("imp", () => M.Category.countDocuments({ name: "Spices" })), 0, "a category only the refused row named is not made");
  assert.equal(await as("imp", () => M.UOM.countDocuments({})), unitsBefore, "a unit is never made");

  const rice = await as("imp", () => M.Stock.findOne({ itemName: "Basmati Rice 5kg" }).lean());
  assert.match(rice.sku, /^RI\d{4}$/, "numbered by the server, as the item form's automatic SKU is");
  assert.equal(rice.purchasePrice, 18, "a person who may see costs set it");
  assert.equal(rice.salesPrice, 24.5);
  assert.equal(rice.reorderLevel, 10);
  assert.equal(rice.currentStock, 0, "no quantity is ever imported, whatever a column says");
  assert.equal(await as("imp", () => M.InventoryMovement.countDocuments({})), 0, "and so no movement was written");
  const brown = await as("imp", () => M.Stock.findOne({ itemName: "Brown Rice" }).lean());
  assert.notEqual(brown.sku, rice.sku, "two items, two SKUs");

  const again = await api("coster", "POST", "/stock/stock/import", { rows: rows.slice(0, 2), dryRun: false });
  assert.equal(again.body.summary.duplicate, 2);
  assert.equal(await as("imp", () => M.Stock.countDocuments({})), 2);
});

test("a person who may not see what items cost cannot set it, and is told", { skip }, async () => {
  const r = await api("stocker", "POST", "/stock/stock/import", { rows: [{ line: 2, name: "Cheap Rice", category: "Rice", unit: "Kg", purchasePrice: "9", salesPrice: "12" }], dryRun: false });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.body.summary.created, 1);
  assert.deepEqual(r.body.notes, ["The Purchase price column was left out: you may not set what items cost."]);
  const item = await as("imp", () => M.Stock.findOne({ itemName: "Cheap Rice" }).lean());
  assert.equal(item.purchasePrice, 0, "the cost was left out");
  assert.equal(item.salesPrice, 12, "the rest of the row was carried out");
  assert.ok(!JSON.stringify(r.body).includes('"purchasePrice"'), "and no cost reaches their answer");
});

// ---- isolation and bad bodies ----------------------------------------------------------------------------------------------------

test("another organisation's records are not duplicates, and an import touches only its own", { skip }, async () => {
  await as("imptwo", () => M.Customer.create({ customerId: "CUST2026001", customerName: "Shared Name Trading", contactPerson: "x", billingAddress: "y" }));
  const r = await api("seller", "POST", "/customers/import", { rows: [{ name: "Shared Name Trading" }], dryRun: false });
  assert.equal(r.body.summary.created, 1, "a name held by another organisation is not a duplicate here");
  assert.equal(await as("imptwo", () => M.Customer.countDocuments({})), 1, "the other organisation still holds exactly its own");
  assert.equal(await as("imp", () => M.Customer.countDocuments({ customerName: "Shared Name Trading" })), 1);
});

test("a body that is too big or not to be trusted is a clean refusal, never a 500", { skip }, async () => {
  const big = await api("seller", "POST", "/customers/import", { rows: rowsOf(201, (i) => ({ name: `Bulk ${i}` })) });
  assert.equal(big.status, 400);
  assert.equal(big.code, "IMPORT_TOO_MANY");

  const lot = await api("seller", "POST", "/customers/import", { rows: rowsOf(51, (i) => ({ name: `Lot ${i}` })), dryRun: false });
  assert.equal(lot.status, 400, "a write lot is at most 50 rows");
  assert.equal(lot.code, "IMPORT_TOO_MANY");
  assert.equal(await as("imp", () => M.Customer.countDocuments({ customerName: /^Lot / })), 0, "and nothing of it was written");
  const preview51 = await api("seller", "POST", "/customers/import", { rows: rowsOf(51, (i) => ({ name: `Lot ${i}` })) });
  assert.equal(preview51.status, 200, "but a preview may carry 200");

  for (const body of [{}, { rows: [] }, { rows: "not a list" }, { rows: { $ne: 1 } }, { rows: [null, "x", 5, { name: { $ne: "x" } }, { name: ["a"] }] }]) {
    const r = await api("seller", "POST", "/customers/import", body);
    assert.ok([200, 400].includes(r.status), `${JSON.stringify(body)} -> ${r.status} ${JSON.stringify(r.data)?.slice(0, 150)}`);
    assert.notEqual(r.status, 500);
  }
  const hostile = await api("seller", "POST", "/customers/import", { rows: [null, "x", 5, { name: { $ne: "x" } }] });
  assert.equal(hostile.body.summary.create, 0);
  assert.equal(hostile.body.summary.invalid, 4);
});
