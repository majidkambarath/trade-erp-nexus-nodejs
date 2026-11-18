// The automatic SKU is chosen by the server (StockService.nextSkuFor), so two people adding an item to one category at
// the same moment get two numbers, not a "SKU already used" refusal for one of them. Throwaway database, dropped after.
//
//   node --require ./utils/testSetup.js --test services/__tests__/stockAutoSku.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_sku_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;

let Stock, StockService, category;
test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  Stock = require("../../models/modules/stockModel");
  StockService = require("../stock/stockService");
  const Category = require("../../models/modules/categoryModel");
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

test("the server numbers an automatic SKU after the highest one in the category, whatever the form previewed", { skip }, async () => {
  await StockService.createStock(item("Manual", { sku: "RI0041" }), "tester");
  const made = await StockService.createStock(item("Auto", { sku: "RI0001", autoSku: true }), "tester");
  assert.equal(made.sku, "RI0042");
  // without autoSku the typed SKU is taken as it is, and a clash is still refused
  await assert.rejects(StockService.createStock(item("Typed twin", { sku: "RI0041" }), "tester"), (e) => e.code === "DUPLICATE_SKU");
});

test("items added at the same moment each get their own SKU", { skip }, async () => {
  const made = await Promise.all(
    Array.from({ length: 4 }, (_, i) => StockService.createStock(item(`Race ${i}`, { sku: "RI0043", autoSku: true }), "tester"))
  );
  const skus = made.map((s) => s.sku).sort();
  assert.equal(new Set(skus).size, 4, skus.join(", "));
  assert.deepEqual(skus, ["RI0043", "RI0044", "RI0045", "RI0046"]);
});
