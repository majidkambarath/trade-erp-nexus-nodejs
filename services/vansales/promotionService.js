const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const Promotion = require("../../models/modules/vansales/promotionModel");
const Stock = require("../../models/modules/stockModel");
const rules = require("../../utils/promotions");
const { todayInOrg } = require("../../utils/documentExpiry");

const isId = (v) => mongoose.isValidObjectId(v);
const fail = (message, status, code, details) => new AppError(message, status, code, details);
const withSession = (q, session) => (session ? q.session(session) : q);
const shape = (r) => ({ ...r, id: String(r._id), freeStockId: r.freeStockId ? String(r.freeStockId) : "" });

// Promotions on van sales (utils/promotions.js has the rule). Kept under Van sales > Vans and routes > Promotions.
class PromotionService {
  static async list({ includeInactive = false } = {}) {
    const rows = await Promotion.find(includeInactive ? {} : { active: true }).sort({ priority: -1, name: 1 }).lean();
    return rows.map(shape);
  }

  static async get(id) {
    if (!isId(id)) throw fail("That promotion does not exist", 404, "PROMOTION_NOT_FOUND");
    const r = await Promotion.findById(id).lean();
    if (!r) throw fail("That promotion does not exist", 404, "PROMOTION_NOT_FOUND");
    return shape(r);
  }

  static async #checked(input) {
    let base;
    try {
      base = rules.validatePromotion(input);
    } catch (err) {
      if (err instanceof rules.PromotionError) throw fail(err.message, 400, err.code, err.details);
      throw err;
    }
    const all = [...base.stockIds, ...base.categoryIds, ...base.customerIds, ...base.routeIds, ...(base.freeStockId ? [base.freeStockId] : [])];
    if (all.some((i) => !isId(i))) throw fail("An item, category, customer or route on the offer is not valid", 400, "PROMOTION_INVALID");
    const items = [...base.stockIds, ...(base.freeStockId ? [base.freeStockId] : [])];
    if (items.length && (await Stock.countDocuments({ _id: { $in: items } })) !== new Set(items).size) throw fail("An item on the offer does not exist", 400, "ITEM_NOT_FOUND");
    if (!base.freeStockId) delete base.freeStockId;
    return base;
  }

  static async create(input, createdBy) {
    const base = await this.#checked(input);
    if (await Promotion.exists({ name: base.name })) throw fail(`A promotion called ${base.name} already exists`, 409, "PROMOTION_NAME_TAKEN");
    const r = await Promotion.create({ ...base, createdBy });
    return this.get(r._id);
  }

  static async update(id, input, updatedBy) {
    const r = await Promotion.findById(id);
    if (!r) throw fail("That promotion does not exist", 404, "PROMOTION_NOT_FOUND");
    const base = await this.#checked(input);
    if (await Promotion.exists({ name: base.name, _id: { $ne: r._id } })) throw fail(`A promotion called ${base.name} already exists`, 409, "PROMOTION_NAME_TAKEN");
    for (const k of ["percent", "minQty", "minValue", "buyQty", "freeQty", "freeStockId"]) r[k] = undefined;
    r.set({ ...base, updatedBy });
    if (typeof input.active === "boolean") r.active = input.active;
    await r.save();
    return this.get(r._id);
  }

  /** The promotions switched on, as the rule reads them (the rule decides days, customers and routes). */
  static async live({ session } = {}) {
    return withSession(Promotion.find({ active: true }).lean(), session);
  }

  /**
   * Price a van sale's lines through the promotions: lines [{ itemId, qty, price, discountPercent }].
   * -> the rule's { lines, free, applied }, the lines carrying each item's category.
   */
  static async apply(lines, { customerId, routeId, date, session } = {}) {
    const promos = await this.live({ session });
    if (!promos.length) return { lines: lines.map((l) => ({ ...l, promoIds: [] })), free: [], applied: [] };
    const cats = await withSession(Stock.find({ _id: { $in: lines.map((l) => l.itemId) } }).select("category").lean(), session);
    const catOf = new Map(cats.map((s) => [String(s._id), s.category ? String(s.category) : ""]));
    const withCat = lines.map((l) => ({ ...l, categoryId: catOf.get(String(l.itemId)) || "" }));
    return rules.apply(withCat, promos, { customerId, routeId, date: date ? String(date).slice(0, 10) : todayInOrg() });
  }
}

module.exports = PromotionService;
