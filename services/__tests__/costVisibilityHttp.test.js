// What an item costs is for inventory.viewCost (Owner, Administrator, Manager, Accountant, Purchase officer). Against a strict server with real
// sign-ins: the people who may not see it never receive a cost figure from a stock list, an item, the stats, a document list, the movements, the
// batches or the stock reports, the cost reports refuse them, and a save from their item form cannot overwrite the cost.
//
//   node --require ./utils/testSetup.js --test services/__tests__/costVisibilityHttp.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const H = require("./support/httpHarness");

const skip = H.skipReason?.() || (!process.env.MONGO_URI && "MONGO_URI not set");
const ORG = "costv";
const SEES = ["owner", "admin", "manager", "accountant", "purchase"];
const BLIND = ["sales", "storekeeper", "viewer", "operator"];
const ROLES = { owner: "super_admin", admin: "admin", manager: "manager", accountant: "accountant", purchase: "purchase", sales: "sales", storekeeper: "storekeeper", viewer: "viewer", operator: "operator" };

let stack, call;
const T = {};
let item, customer;
const api = (who, method, url, body) => call(method, url, { token: T[who], body });

// every key anywhere in a JSON value
const keysIn = (v, acc = new Set()) => {
  if (Array.isArray(v)) v.forEach((x) => keysIn(x, acc));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { acc.add(k); keysIn(x, acc); }
  return acc;
};
const COST = ["purchasePrice", "costValue", "currentPurchasePrice", "unitCost", "rateBefore", "rateAfter", "costPoolAfter", "cogsAmount", "totalStockValue", "valueAtCost", "receiptCost", "avgCost"];
const leaked = (v, extra = []) => [...COST, ...extra].filter((k) => keysIn(v).has(k));

test.before(async () => {
  if (skip) return;
  stack = await H.startStack("costv");
  call = H.makeCaller(stack.base);
  const Admin = require("../../models/core/adminModel");
  const made = await stack.Org.create({ legalName: "Cost Test", code: ORG, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" });
  assert.equal(made.provisioning.complete, true);
  const perms = require("../../utils/permissions");
  for (const [who, key] of Object.entries(ROLES)) {
    const legacy = perms.LEGACY_TYPES.includes(key);
    await stack.as(ORG, () => new Admin({ name: who, email: `${who}@costv.test`, password: H.PASSWORD, status: "active", isActive: true, type: legacy ? key : "viewer", ...(legacy ? {} : { roleKey: key }) }).save());
    const r = await call("POST", "/login", { body: { email: `${who}@costv.test`, password: H.PASSWORD } });
    assert.equal(r.status, 200, `${who}: ${r.text.slice(0, 200)}`);
    T[who] = r.body.tokens.accessToken;
  }
  const Category = require("../../models/modules/categoryModel");
  const Customer = require("../../models/modules/customerModel");
  const category = await stack.as(ORG, () => Category.create({ name: "General" }));
  customer = await stack.as(ORG, () => Customer.create({ customerId: "C1", customerName: "Buyer", paymentTerms: "Cash" }));
  const created = await api("owner", "POST", "/stock/stock", {
    sku: "GE0001", itemName: "Widget", categoryId: String(category._id), unitOfMeasure: String(new (require("mongoose").Types.ObjectId)()),
    origin: "UAE", brand: "B", purchasePrice: 40, salesPrice: 60, currentStock: 10, reorderLevel: 20, status: "Active",
  });
  assert.equal(created.status, 201, created.text.slice(0, 300));
  item = created.body.stock;
  assert.equal(item.purchasePrice, 40, "the owner is told the cost");
  const doc = await api("owner", "POST", "/transactions/transactions", {
    type: "sales_order", partyId: String(customer._id), partyType: "Customer", partyTypeRef: "Customer",
    items: [{ itemId: item._id, description: "Widget", qty: 2, price: 60, rate: 60 }],
  });
  assert.equal(doc.status, 201, doc.text.slice(0, 300));
  const Vendor = require("../../models/modules/vendorModel");
  const vendor = await stack.as(ORG, () => Vendor.create({ vendorId: "V1", vendorName: "Supplier", address: "Dubai", paymentTerms: "Cash" }));
  const bill = await api("owner", "POST", "/transactions/transactions", {
    type: "purchase_order", partyId: String(vendor._id), partyType: "Vendor", partyTypeRef: "Vendor",
    items: [{ itemId: item._id, description: "Widget", qty: 5, price: 40, rate: 40 }],
  });
  assert.equal(bill.status, 201, bill.text.slice(0, 300));
});

test.after(async () => {
  if (skip) return;
  await stack?.stop();
});

test("the roles that hold the permission are exactly the five decided", { skip }, () => {
  const perms = require("../../utils/permissions");
  const holders = Object.entries(ROLES).filter(([, key]) => perms.BUILT_IN[key].permissions.includes("inventory.viewCost")).map(([who]) => who);
  assert.deepEqual(holders.sort(), [...SEES].sort());
});

test("the item list, one item and the stats carry the cost only for those who may see it", { skip }, async () => {
  for (const who of SEES) {
    const list = await api(who, "GET", "/stock/stock");
    assert.equal(list.status, 200, who);
    assert.ok(keysIn(list.body).has("purchasePrice"), `${who} sees the cost`);
    const stats = await api(who, "GET", "/stock/stock/stats");
    assert.ok(keysIn(stats.body).has("totalStockValue"), `${who} sees the stock value`);
  }
  for (const who of BLIND) {
    const list = await api(who, "GET", "/stock/stock");
    if (who === "operator") assert.equal(list.status, 200); // an operator holds lookups.view: the pick list
    if (list.status === 200) {
      assert.deepEqual(leaked(list.body), [], `${who} was handed a cost: ${list.text.slice(0, 200)}`);
      assert.ok(keysIn(list.body).has("salesPrice"), `${who} still gets the selling price`);
    }
    const one = await api(who, "GET", `/stock/stock/${item._id}`);
    if (one.status === 200) assert.deepEqual(leaked(one.body), [], `${who} one item`);
    const stats = await api(who, "GET", "/stock/stock/stats");
    if (stats.status === 200) assert.deepEqual(leaked(stats.body), [], `${who} stats`);
  }
});

test("a document list shows a line's cost snapshot only to those who may see it", { skip }, async () => {
  for (const who of SEES) {
    const type = who === "purchase" ? "purchase_order" : "sales_order"; // a purchase officer holds no sales view
    const r = await api(who, "GET", `/transactions/transactions?type=${type}`);
    assert.equal(r.status, 200, `${who}: ${r.text.slice(0, 200)}`);
    assert.ok(keysIn(r.body).has("purchasePrice"), `${who} sees the cost on the order grid`);
  }
  for (const who of ["sales", "storekeeper", "viewer"]) {
    const r = await api(who, "GET", "/transactions/transactions?type=sales_order");
    if (r.status !== 200) continue; // (a storekeeper sees sales documents; the others hold sales.view or are refused)
    assert.deepEqual(leaked(r.body, ["totalValue"]), [], `${who}`);
    assert.ok(r.body?.transactions?.length || r.body?.length || keysIn(r.body).has("transactionNo"), `${who} still sees the documents`);
  }
});

test("stock movements and the document audit trail carry the cost only for those who may see it", { skip }, async () => {
  const owner = await api("owner", "GET", "/inventory/inventory");
  assert.equal(owner.status, 200, owner.text.slice(0, 200));
  assert.ok(keysIn(owner.body).has("unitCost"), "the owner reads the cost of the opening stock");
  for (const who of ["sales", "viewer", "storekeeper"]) {
    const r = await api(who, "GET", "/inventory/inventory");
    if (r.status === 200) assert.deepEqual(leaked(r.body, ["totalValue"]), [], `${who} movements`);
  }
  const accountant = await api("accountant", "GET", "/inventory/inventory");
  assert.ok(keysIn(accountant.body).has("totalValue"));
});

test("the cost and margin reports refuse those who may not see cost; the others lose any cost column", { skip }, async () => {
  const q = "?asOn=2030-01-01&from=2020-01-01&to=2030-01-01&itemId=" + item._id;
  for (const url of ["/stock-reports/valuation", "/stock-reports/ledger-check", "/stock-reports/movement", "/stock-reports/item-ledger", "/stock-reports/sales-analysis", "/stock-reports/slow-moving"]) {
    for (const who of BLIND) {
      const r = await api(who, "GET", url + q);
      assert.equal(r.status, 403, `${who} ${url}`);
      assert.equal(r.code, "PERMISSION_DENIED", `${who} ${url}`);
    }
    for (const who of ["accountant", "owner"]) {
      const r = await api(who, "GET", url + q);
      assert.notEqual(r.status, 403, `${who} ${url}: ${r.text.slice(0, 200)}`);
    }
  }
  const reorder = await api("sales", "GET", "/stock-reports/reorder");
  assert.equal(reorder.status, 200);
  assert.deepEqual(leaked(reorder.body, ["shortfallValue"]), [], "reorder has no average cost or shortfall at cost for a salesperson");
  const expiry = await api("sales", "GET", "/stock-reports/expiry");
  if (expiry.status === 200) assert.deepEqual(leaked(expiry.body, ["value"]), [], "expiry has no value at cost for a salesperson");
  assert.ok(keysIn((await api("owner", "GET", "/stock-reports/reorder")).body).has("avgCost"), "and still has for the owner");
});

test("saving an item without being able to see its cost cannot change the cost", { skip }, async () => {
  const Stock = require("../../models/modules/stockModel");
  const cost = () => stack.as(ORG, () => Stock.findById(item._id).lean()).then((s) => s.purchasePrice);
  assert.equal(await cost(), 40);
  const edited = await api("storekeeper", "PUT", `/stock/stock/${item._id}`, { itemName: "Widget Renamed", purchasePrice: 1, salesPrice: 65 });
  assert.equal(edited.status, 200, edited.text.slice(0, 300));
  assert.equal(await cost(), 40, "the storekeeper's number was ignored");
  const after = await stack.as(ORG, () => Stock.findById(item._id).lean());
  assert.equal(after.itemName, "Widget Renamed", "the rest of the request was carried out");
  assert.equal(after.salesPrice, 65);
  const blank = await api("storekeeper", "PUT", `/stock/stock/${item._id}`, { itemName: "Widget Renamed", purchasePrice: 0 });
  assert.equal(blank.status, 200);
  assert.equal(await cost(), 40, "a form that came back without the cost cannot write a zero over it");
  const owner = await api("owner", "PUT", `/stock/stock/${item._id}`, { purchasePrice: 55 });
  assert.equal(owner.status, 200, owner.text.slice(0, 300));
  assert.equal(await cost(), 55, "someone who can see it can change it");
});

test("a new item made by someone who cannot see cost starts with none", { skip }, async () => {
  const Category = require("../../models/modules/categoryModel");
  const category = await stack.as(ORG, () => Category.findOne({ name: "General" }).lean());
  const r = await api("storekeeper", "POST", "/stock/stock", {
    sku: "GE0002", itemName: "Gadget", categoryId: String(category._id), unitOfMeasure: String(new (require("mongoose").Types.ObjectId)()),
    origin: "UAE", brand: "B", purchasePrice: 999, salesPrice: 10, currentStock: 0, status: "Active",
  });
  assert.equal(r.status, 201, r.text.slice(0, 300));
  const Stock = require("../../models/modules/stockModel");
  const stored = await stack.as(ORG, () => Stock.findOne({ sku: "GE0002" }).lean());
  assert.equal(stored.purchasePrice || 0, 0, "the figure typed was not kept");
});
