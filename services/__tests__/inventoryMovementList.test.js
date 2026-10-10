// The stock movement screen's list and cards: the value is signed by direction (a sale's cost is stored positive, so a plain sum
// added what went out to what came in), rows carry the item's name and the person's NAME (not their account id), the search finds
// a reference number, and paging is stable when many movements share one date. Throwaway database.
//
//   node --require ./utils/testSetup.js --test services/__tests__/inventoryMovementList.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let svc;
let person;
const day = (d) => new Date(`${d}T00:00:00.000Z`);

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    List: require("../stock/inventoryMovementService"),
    Movement: require("../../models/modules/inventoryMovementModel"),
    Stock: require("../../models/modules/stockModel"),
    Category: require("../../models/modules/categoryModel"),
    Admin: require("../../models/core/adminModel"),
  };
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault();

  const category = await svc.Category.create({ name: "Grains" });
  await svc.Stock.create([
    { itemId: "RICE", sku: "RICE-5KG", itemName: "Basmati Rice", category: category._id },
    { itemId: "OIL", sku: "OIL-1L", itemName: "Sunflower Oil", category: category._id },
  ]);
  person = await svc.Admin.create({ name: "Mariam Haddad", email: `mariam.${Date.now()}@test.uae`, password: "12312312", type: "manager" });

  const move = (o) => ({
    stockId: "RICE", previousStock: 0, newStock: 0, referenceType: "Transaction", referenceId: new mongoose.Types.ObjectId(),
    createdBy: String(person._id), date: day("2026-10-05"), ...o,
  });
  await svc.Movement.create([
    move({ quantity: 100, totalValue: 1000, unitCost: 10, eventType: "PURCHASE_RECEIVE", referenceNumber: "PO-2026-0001" }),
    // a sale stores its cost positive, exactly like a purchase
    move({ quantity: -40, totalValue: 400, unitCost: 10, eventType: "SALES_DISPATCH", referenceNumber: "SO-2026-0001" }),
    move({ stockId: "OIL", quantity: 10, totalValue: 250.5, unitCost: 25.05, eventType: "PURCHASE_RECEIVE", referenceNumber: "PO-2026-0002", createdBy: "system" }),
    move({ quantity: -5, totalValue: 50, unitCost: 10, eventType: "DAMAGED_STOCK", referenceNumber: "WO-2026-0001", date: day("2026-09-01"), createdBy: String(new mongoose.Types.ObjectId()) }),
  ]);
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("signedValue: out is negative, in is positive, whatever sign totalValue was stored with", { skip }, () => {
  const { signedValue } = svc.List;
  assert.equal(signedValue({ quantity: 5, totalValue: 100 }), 100);
  assert.equal(signedValue({ quantity: -5, totalValue: 100 }), -100);
  assert.equal(signedValue({ quantity: -5, totalValue: -100 }), -100);
  assert.equal(signedValue({ quantity: 0, totalValue: 100 }), 0);
});

test("the cards: total value is the NET value moved, not the sum of in and out", { skip }, async () => {
  const s = await svc.List.stats({});
  assert.equal(s.totalMovements, 4);
  assert.equal(s.stockIn, 2);
  assert.equal(s.stockOut, 2);
  assert.equal(s.valueIn, 1250.5);
  assert.equal(s.valueOut, 450);
  assert.equal(s.totalValue, 800.5, "1,250.50 in less 450.00 out; the old sum read 1,700.50");
});

test("the cards follow the date range, and an empty range is zeroes", { skip }, async () => {
  const october = await svc.List.stats({ startDate: "2026-10-01T00:00:00.000Z", endDate: "2026-10-31T23:59:59.999Z" });
  assert.equal(october.totalMovements, 3);
  assert.equal(october.totalValue, 850.5, "1,250.50 in less 400.00 out; the September write-off is outside October");
  const none = await svc.List.stats({ startDate: "2020-01-01", endDate: "2020-01-31" });
  assert.deepEqual([none.totalMovements, none.valueIn, none.valueOut, none.totalValue], [0, 0, 0, 0]);
});

test("rows carry the item's name and the person's name, never a bare account id", { skip }, async () => {
  const { movements } = await svc.List.list({ limit: 50 });
  const purchase = movements.find((m) => m.referenceNumber === "PO-2026-0001");
  assert.equal(purchase.itemName, "Basmati Rice");
  assert.equal(purchase.createdByName, "Mariam Haddad");
  assert.equal(movements.find((m) => m.referenceNumber === "PO-2026-0002").createdByName, "System");
  assert.equal(movements.find((m) => m.referenceNumber === "WO-2026-0001").createdByName, null, "an account that no longer exists has no name to show");
});

test("search finds an item by name or SKU and a movement by its reference number", { skip }, async () => {
  const byName = await svc.List.list({ search: "sunflower" });
  assert.deepEqual(byName.movements.map((m) => m.referenceNumber), ["PO-2026-0002"]);
  const bySku = await svc.List.list({ search: "rice-5kg" });
  assert.equal(bySku.total, 3);
  const byReference = await svc.List.list({ search: "SO-2026-0001" });
  assert.deepEqual(byReference.movements.map((m) => m.referenceNumber), ["SO-2026-0001"]);
  const regexy = await svc.List.list({ search: ".*" });
  assert.equal(regexy.total, 0, "typed characters are text, not a pattern");
});

test("direction and event filters", { skip }, async () => {
  assert.equal((await svc.List.list({ movementType: "OUT" })).total, 2);
  assert.equal((await svc.List.list({ movementType: "IN" })).total, 2);
  assert.equal((await svc.List.list({ eventType: "SALES_DISPATCH" })).total, 1);
});

test("paging is stable when movements share a date: every row once, none twice", { skip }, async () => {
  const seen = [];
  for (let page = 1; page <= 4; page += 1) {
    const r = await svc.List.list({ page, limit: 1 });
    seen.push(...r.movements.map((m) => String(m._id)));
  }
  assert.equal(new Set(seen).size, 4);
});

test("a date that is not a date is a 400, not a 500", { skip }, async () => {
  await assert.rejects(() => svc.List.list({ startDate: "not-a-date" }), (e) => e.statusCode === 400 && e.code === "INVALID_DATE");
});
