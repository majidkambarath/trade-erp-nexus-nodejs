// The category list and its cards: the model keeps "Active" / "Inactive" as the form writes them, and the stats and the status
// filter compared with "ACTIVE" - so the Active card read 0 for every category the screen ever made, and "status:active" in the
// search found nothing. The list also reports its true total (the footer showed the unfiltered one during a search).
// Throwaway database.
//
//   node --require ./utils/testSetup.js --test services/__tests__/categoryList.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let CategoryService;
let Category;

test.before(async () => {
  if (skip) return;
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  CategoryService = require("../stock/categoryService");
  Category = require("../../models/modules/categoryModel");
  await mongoose.connection.syncIndexes();
  await require("../core/organisationService").ensureDefault();
  await Category.create([
    { name: "Rice", description: "basmati and long grain", status: "Active" },
    { name: "Oils", description: "cooking oils", status: "Active" },
    { name: "Spices", description: "whole and ground", status: "Inactive" },
    { name: "Legacy", description: "written by an older version", status: "ACTIVE" },
    { name: "Old stock", description: "no longer sold", status: "INACTIVE" },
  ]);
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("the cards count Active and Inactive whatever case they were written in", { skip }, async () => {
  const s = await CategoryService.getCategoryStats();
  assert.equal(s.totalCategories, 5);
  assert.equal(s.activeCategories, 3, "Rice, Oils and the upper-case Legacy");
  assert.equal(s.inactiveCategories, 2, "Spices and the upper-case Old stock");
});

test("the status filter matches the stored words, ignoring case", { skip }, async () => {
  const active = await CategoryService.getAllCategories({ status: "Active" });
  assert.equal(active.total, 3);
  const inactive = await CategoryService.getAllCategories({ status: "inactive" });
  assert.equal(inactive.total, 2);
});

test("status:active in the search is a filter, and the rest of the text still searches", { skip }, async () => {
  const onlyToken = await CategoryService.getAllCategories({ search: "status:active" });
  assert.equal(onlyToken.total, 3);
  const withText = await CategoryService.getAllCategories({ search: "oil status:active" });
  assert.deepEqual(withText.categories.map((c) => c.name), ["Oils"]);
  const inactiveText = await CategoryService.getAllCategories({ search: "STATUS:INACTIVE spice" });
  assert.deepEqual(inactiveText.categories.map((c) => c.name), ["Spices"]);
});

test("the list reports the true total of what matched, and its pages follow it", { skip }, async () => {
  const all = await CategoryService.getAllCategories({ limit: 2 });
  assert.equal(all.total, 5);
  assert.equal(all.totalPages, 3);
  assert.equal(all.categories.length, 2);
  const some = await CategoryService.getAllCategories({ search: "rice", limit: 2 });
  assert.equal(some.total, 1, "not the unfiltered five");
  assert.equal(some.totalPages, 1);
});

test("a search is text, not a pattern", { skip }, async () => {
  assert.equal((await CategoryService.getAllCategories({ search: ".*" })).total, 0);
  assert.equal((await CategoryService.getAllCategories({ status: ".*" })).total, 0);
});
