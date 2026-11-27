// Items, found in the review of 21 Nov 2026 (docs/ERP_GAP_REVIEW_2026-11.md, section 2): what an item says about its supplier,
// the item code two items can draw at once, and a barcode the caller names. Throwaway database, dropped after.
//
//   node --require ./utils/testSetup.js --test services/__tests__/stockItemFixes.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_itm_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;

let Vendor, StockService, category;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  Vendor = require("../../models/modules/vendorModel");
  StockService = require("../stock/stockService");
  const Category = require("../../models/modules/categoryModel");
  require("../../models/modules/uomModel"); // getStockById populates the unit and a service's accounts: a populate needs its model registered
  require("../../models/modules/financial/financialModels");
  await mongoose.connection.syncIndexes();
  category = await Category.create({ name: "Rice" });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const item = (name, extra = {}) => ({ itemName: name, categoryId: category._id, unitOfMeasure: new mongoose.Types.ObjectId(), origin: "UAE", brand: "B", ...extra });

// ---------------------------------------------------------------------------------------------------------------------------------
// the supplier on an item
// ---------------------------------------------------------------------------------------------------------------------------------

// GET /stock/stock is open to every role (lookups.view: the pick lists every form fills itself from), and an item's supplier was
// populated WHOLE: bank accounts, IBANs, KYC numbers, credit limit, balance. The screens read the name and the id.
const SECRETS = [
  "9999888877776666", "AE070331234567890123456", "LEAKAEAA", "Leak Bank", // a bank account
  "LIC-87654", "licence.pdf", "TL-LEAK-1", "100234567890123", // KYC documents and the tax number
  "123456.78", // what we owe them
  "sami@gulfmill.test", "0501234567", "Sami Leaky", "Plot 4, Leak Street", // how to reach them
];

test("an item names its supplier and nothing else: no bank account, KYC number, balance or contact", { skip }, async () => {
  const vendor = await Vendor.create({
    vendorId: "V-LEAK-1", vendorName: "Gulf Mill Supplies", contactPerson: "Sami Leaky", email: "sami@gulfmill.test", phone: "0501234567", address: "Plot 4, Leak Street",
    trnNO: "100234567890123", vat: { status: "registered", trn: "100234567890123", tradeLicenseNo: "TL-LEAK-1" },
    bankAccounts: [{ bankName: "Leak Bank", accountNumber: "9999888877776666", iban: "AE070331234567890123456", swiftCode: "LEAKAEAA" }],
    documents: [{ typeName: "Trade licence", number: "LIC-87654", fileName: "licence.pdf" }],
    contacts: [{ name: "Sami Leaky", email: "sami@gulfmill.test", phone: "0501234567", isPrimary: true }],
    cashBalance: -123456.78,
  });
  const made = await StockService.createStock(item("Basmati", { sku: "RI9001", vendorId: vendor._id, status: "Active" }), "tester");

  // every way an item is read for a screen (a new item has 0 on hand and a reorder level of 0, so it is also "low")
  const reads = {
    getAllStock: await StockService.getAllStock({}),
    getStockById: await StockService.getStockById(made._id),
    getStockByItemId: await StockService.getStockByItemId(made._id),
    getStockWithMovements: (await StockService.getStockWithMovements(made.itemId)).stock,
    getLowStockItems: await StockService.getLowStockItems(),
  };
  for (const [name, result] of Object.entries(reads)) {
    const whole = JSON.stringify(result);
    for (const secret of SECRETS) assert.ok(!whole.includes(secret), `${name}: "${secret}" reached the item`);
    assert.ok(whole.includes("Gulf Mill Supplies"), `${name}: the supplier's name is still there`);
  }

  // and what the supplier object carries is an allow-list, so a field added to the vendor later does not leak by default
  const row = JSON.parse(JSON.stringify(reads.getAllStock.find((s) => String(s._id) === String(made._id))));
  assert.equal(String(row.vendorId._id), String(vendor._id), "the screens match the supplier by its id");
  assert.equal(row.vendorId.vendorName, "Gulf Mill Supplies");
  const allowed = new Set(["_id", "vendorId", "vendorName", "vat", "credit"]); // vat / credit are derived by the vendor's own toJSON, from nothing here
  assert.deepEqual(Object.keys(row.vendorId).filter((k) => !allowed.has(k)), [], "no field beyond the name and the codes");
  assert.equal(row.vendorId.vat?.trn ?? null, null, "not even the tax number");
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the item code
// ---------------------------------------------------------------------------------------------------------------------------------

// The code is the first three letters of the name and a random number, checked against nothing before it is written: among a hundred
// items whose names start alike there is about a 4 in 10 chance that two draw one, and the unique index refused the second with a bare
// duplicate-key error. The generator is a seam so the clash can be made on purpose.
test("two items that draw the same code are both saved: the second draws again", { skip }, async () => {
  const draws = ["DUP1111", "DUP1111", "DUP2222"]; // the second item's first draw clashes with the first item's code
  const original = StockService.generateItemId;
  StockService.generateItemId = (name) => draws.shift() ?? original(name);
  try {
    const first = await StockService.createStock(item("Dup A", { sku: "DU0001" }), "tester");
    const second = await StockService.createStock(item("Dup B", { sku: "DU0002" }), "tester"); // a typed SKU: the code is retried all the same
    assert.equal(first.itemId, "DUP1111");
    assert.equal(second.itemId, "DUP2222", "the clash was drawn again, not reported to the person");
    assert.deepEqual(draws, [], "exactly the three draws were used");

    // the automatic-SKU path too (the item form and a quick-add from an order use it)
    const clash = ["DUP1111", "DUP3333"];
    StockService.generateItemId = (name) => clash.shift() ?? original(name);
    const third = await StockService.createStock(item("Dup C", { sku: "DU0003", autoSku: true }), "tester");
    assert.equal(third.itemId, "DUP3333");
  } finally {
    StockService.generateItemId = original;
  }
});

test("a code that keeps clashing is given up on after a handful of tries, with the clash as the error", { skip }, async () => {
  const original = StockService.generateItemId;
  let draws = 0;
  StockService.generateItemId = () => { draws += 1; return "DUP1111"; }; // taken by the previous test's first item
  try {
    await assert.rejects(StockService.createStock(item("Dup Never", { sku: "DU0099" }), "tester"), (e) => e.code === 11000);
    assert.equal(draws, 8, "it tried eight times and no more");
  } finally {
    StockService.generateItemId = original;
  }
});

test("an item with no usable name still gets a code", { skip }, async () => {
  assert.match(StockService.generateItemId("   "), /^ITM\d{4}$/);
  assert.match(StockService.generateItemId(undefined), /^ITM\d{4}$/);
  assert.match(StockService.generateItemId("  rice flour "), /^RIC\d{4}$/);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the barcode
// ---------------------------------------------------------------------------------------------------------------------------------

// A barcode the caller names (a spreadsheet, the API) used to be thrown away and replaced by the SKU; the item form draws the SKU as a
// barcode, and still does when nothing else is given. Search did not look at it at all, so a scanner could not find the item.
test("a barcode the caller names is kept, the SKU stands in when none is given, and search finds either", { skip }, async () => {
  const typed = await StockService.createStock(item("Scanned", { sku: "SC0001", barcodeQrCode: " 6291041500213 " }), "tester");
  assert.equal(typed.barcodeQrCode, "6291041500213", "kept, trimmed");
  const blank = await StockService.createStock(item("Blank barcode", { sku: "SC0002", barcodeQrCode: "" }), "tester"); // what the item form sends
  assert.equal(blank.barcodeQrCode, "SC0002");
  const none = await StockService.createStock(item("No barcode", { sku: "SC0003" }), "tester");
  assert.equal(none.barcodeQrCode, "SC0003");

  assert.deepEqual((await StockService.getAllStock({ search: "62910415" })).map((s) => s.sku), ["SC0001"], "found by part of its barcode");
  assert.deepEqual((await StockService.getAllStock({ search: "SC0002" })).map((s) => s.sku), ["SC0002"], "and by SKU, as before");
});

// A barcode now belongs to one item: a scanner that read a shared code would have to guess which item was meant. Checked by the
// service, not a unique index, because an organisation's older items may already share one (and an index that cannot be built
// guards nothing): such an item can still be saved for any change that does not touch its barcode.
test("a barcode is one item's: a taken barcode or another item's SKU is refused, on create and on edit", { skip }, async () => {
  const first = await StockService.createStock(item("Water 19L", { sku: "WA0001", barcodeQrCode: "6291000000019" }), "tester");
  await assert.rejects(
    StockService.createStock(item("Water 19L copy", { sku: "WA0002", barcodeQrCode: "6291000000019" }), "tester"),
    (e) => e.code === "BARCODE_TAKEN" && e.statusCode === 409 && /Water 19L \(WA0001\)/.test(e.message),
  );
  await assert.rejects(
    StockService.createStock(item("Water 5L", { sku: "WA0003", barcodeQrCode: "WA0001" }), "tester"),
    (e) => e.code === "BARCODE_TAKEN",
    "another item's SKU is what a scanner finds it by",
  );
  const second = await StockService.createStock(item("Water 5L", { sku: "WA0004", barcodeQrCode: "6291000000005" }), "tester");
  await assert.rejects(StockService.updateStock(second._id, { barcodeQrCode: "6291000000019" }, "tester"), (e) => e.code === "BARCODE_TAKEN");

  // saving an item with its own barcode unchanged is never refused, and a blank goes back to the SKU
  const same = await StockService.updateStock(first._id, { barcodeQrCode: "6291000000019", salesPrice: 7 }, "tester");
  assert.equal(same.barcodeQrCode, "6291000000019");
  const cleared = await StockService.updateStock(second._id, { barcodeQrCode: "  " }, "tester");
  assert.equal(cleared.barcodeQrCode, "WA0004");
  const changed = await StockService.updateStock(second._id, { barcodeQrCode: "6291000000777" }, "tester");
  assert.equal(changed.barcodeQrCode, "6291000000777");
});

test("an item that already shares a barcode (from before the rule) can still be saved, until its barcode is changed to a taken one", { skip }, async () => {
  const Stock = require("../../models/modules/stockModel");
  const a = await StockService.createStock(item("Old A", { sku: "OL0001", barcodeQrCode: "OLDSHARED" }), "tester");
  const b = await StockService.createStock(item("Old B", { sku: "OL0002" }), "tester");
  await Stock.updateOne({ _id: b._id }, { $set: { barcodeQrCode: "OLDSHARED" } }); // what an older version could leave behind
  const saved = await StockService.updateStock(b._id, { barcodeQrCode: "OLDSHARED", salesPrice: 3 }, "tester"); // the form sends it back
  assert.equal(saved.salesPrice, 3);
  assert.equal(String(a._id) !== String(b._id), true);
});

test("a barcode never gets in the SKU's way: a typed twin SKU is still the SKU's refusal, and the automatic SKU passes over a number used as a barcode", { skip }, async () => {
  const cat = await require("../../models/modules/categoryModel").create({ name: "Oil" });
  await StockService.createStock(item("Holder", { sku: "OI0001", categoryId: cat._id, barcodeQrCode: "OI0002" }), "tester");
  await assert.rejects(StockService.createStock(item("Twin SKU", { sku: "OI0001", categoryId: cat._id }), "tester"), (e) => e.code === "DUPLICATE_SKU");
  // a typed SKU that is another item's barcode says so, on the SKU box
  await assert.rejects(
    StockService.createStock(item("Clash", { sku: "OI0002", categoryId: cat._id }), "tester"),
    (e) => e.code === "BARCODE_TAKEN" && e.details.fields[0] === "sku" && /SKU is the barcode of Holder/.test(e.message),
  );
  const auto = await StockService.createStock(item("Auto", { sku: "OI0001", categoryId: cat._id, autoSku: true }), "tester");
  assert.equal(auto.sku, "OI0003", "OI0002 is already a barcode");
  await assert.rejects(StockService.updateStock(auto._id, { sku: "OI0002" }, "tester"), (e) => e.code === "BARCODE_TAKEN" && e.details.fields[0] === "sku");
});

test("a barcode that is not plain text is refused; a service still takes none", { skip }, async () => {
  for (const bad of ["x".repeat(65), "line\nbreak", { $ne: "x" }, ["123"]]) {
    await assert.rejects(StockService.createStock(item("Bad barcode", { sku: `BB${String(Math.random()).slice(2, 8)}`, barcodeQrCode: bad }), "tester"), (e) => e.code === "INVALID_BARCODE", JSON.stringify(bad));
  }
  await assert.rejects(
    StockService.createStock(item("Delivery", { sku: "SV0001", itemType: "service", origin: undefined, brand: undefined, barcodeQrCode: "SV-1" }), "tester"),
    (e) => e.code === "SERVICE_HAS_NO_STOCK",
  );
});
