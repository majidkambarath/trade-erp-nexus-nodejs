// A spreadsheet of items (utils/masterImport.js decides each row; services/core/importService.js runs the loop). Every item is made through the
// SAME service the item form saves through (StockService.createStock), so it gets its code, its automatic SKU, its HSN check and its goods or
// service rules exactly as a typed one does.
//
// What an import deliberately does NOT do:
//   - It sets no quantity on hand. An opening quantity has to reach the books (an inventory movement, a ledger voucher against Opening Balance
//     Equity), which Opening balances > Stock does and an item's own form does not (CLAUDE.md "Integrity gaps").
//   - It never makes a unit. A unit's kind (weight, volume, quantity ...) cannot be guessed from a name, so a row naming an unknown unit is
//     refused and the unit is listed for the person to add first.
//   - It never updates an item that exists (add only).
// It makes a CATEGORY the file names when the person has not switched that off: a category is only a name, and the preview lists every one that
// would be made.
const AppError = require("../../utils/AppError");
const masterImport = require("../../utils/masterImport");
const R = require("../../utils/importRules");
const ImportService = require("../core/importService");

class ItemImportService {
  /** What the organisation already holds, as the lists the planner matches names against. */
  static async held() {
    const Category = require("../../models/modules/categoryModel");
    const UOM = require("../../models/modules/uomModel");
    const Vendor = require("../../models/modules/vendorModel");
    const Stock = require("../../models/modules/stockModel");
    const [categories, units, vendors, stocks] = await Promise.all([
      Category.find({}).select("name").lean(),
      UOM.find({ status: { $ne: "Inactive" } }).select("unitName shortCode").lean(),
      Vendor.find({}).select("vendorName").limit(50000).lean(),
      Stock.find({}).select("sku itemName barcodeQrCode").limit(100000).lean(),
    ]);
    return {
      categories: categories.map((c) => ({ id: c._id, name: c.name })),
      units: units.map((u) => ({ id: u._id, unitName: u.unitName, shortCode: u.shortCode })),
      vendors: vendors.map((v) => ({ id: v._id, name: v.vendorName })),
      existing: {
        skus: new Set(stocks.map((s) => String(s.sku ?? "").trim().toLowerCase()).filter(Boolean)),
        names: new Set(stocks.map((s) => masterImport.same(s.itemName)).filter(Boolean)),
        // every code a scanner could already find an item by (its barcode and its SKU), matched exactly
        codes: new Set(stocks.flatMap((s) => [s.barcodeQrCode, s.sku]).map((v) => String(v ?? "").trim()).filter(Boolean)),
      },
    };
  }

  /**
   * Make the categories the file names and we do not hold, once each, before any item that needs one. Another person may have made the same
   * one a moment ago (the category service refuses a name that exists): that one is then simply read back. -> Map(norm(name) -> id)
   */
  static async makeCategories(names, by) {
    const Category = require("../../models/modules/categoryModel");
    const CategoryService = require("./categoryService");
    const made = new Map();
    const failed = new Map();
    for (const name of names) {
      try {
        const doc = await CategoryService.createCategory({ name, status: "Active" }, by);
        made.set(R.norm(name), String(doc._id));
      } catch (error) {
        const again = await Category.findOne({ name }).select("_id").lean();
        if (again) made.set(R.norm(name), String(again._id));
        else failed.set(R.norm(name), error);
      }
    }
    return { made, failed };
  }

  /** `rows` are the screen's mapped rows. Previews unless `dryRun === false`. `canSeeCost` is the caller's: without it no cost is ever set. */
  static async run(rows, { dryRun = true, addCategories = true, canSeeCost = true, by = "system" } = {}) {
    const { categories, units, vendors, existing } = await this.held();
    const plan = masterImport.planItemImport(rows, { existing, categories, units, vendors, addCategories, canSeeCost });
    if (plan.error) throw new AppError(plan.error.message, 400, plan.error.code);
    const extra = { newCategories: plan.newCategories, missing: plan.missing, notes: plan.notes };
    if (dryRun !== false) return ImportService.run(plan, { dryRun: true, extra });

    // a lot may be written once and only once: refuse before anything is made, not after the categories exist
    if (plan.rows.length > R.MAX_WRITE_ROWS) throw new AppError(R.tooMany(R.MAX_WRITE_ROWS).message, 400, "IMPORT_TOO_MANY");
    const { made, failed } = await this.makeCategories(plan.newCategories, by);
    const result = await ImportService.run(plan, {
      dryRun: false,
      extra,
      create: async (fields) => {
        let categoryId = fields.categoryId;
        if (fields.categoryName) {
          const key = R.norm(fields.categoryName);
          if (failed.has(key)) throw failed.get(key); // the category could not be made, so this item cannot be filed
          categoryId = made.get(key);
        }
        const { categoryName: _name, categoryId: _id, ...rest } = fields;
        return require("./stockService").createStock({ ...rest, categoryId }, by);
      },
      describe: (doc) => ({ id: String(doc._id), code: doc.itemId, sku: doc.sku, name: doc.itemName }),
    });
    return { ...result, categoriesAdded: [...made.keys()].length };
  }
}

module.exports = ItemImportService;
