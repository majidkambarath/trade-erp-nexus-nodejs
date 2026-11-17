const mongoose = require("mongoose");
const AppError = require("../../utils/AppError");
const PriceList = require("../../models/modules/vansales/priceListModel");
const VanRoute = require("../../models/modules/vansales/vanRouteModel");
const Stock = require("../../models/modules/stockModel");
const Customer = require("../../models/modules/customerModel");
const rules = require("../../utils/priceLists");
const { todayInOrg } = require("../../utils/documentExpiry");

const isId = (v) => mongoose.isValidObjectId(v);
const fail = (message, status, code, details) => new AppError(message, status, code, details);
const wrap = (fn) => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof rules.PriceListError) throw fail(err.message, 400, err.code, err.details);
    throw err;
  }
};

// Price lists (utils/priceLists.js has the rule). Read on the van to price a sale, kept under Van sales > Vans and routes.
class PriceListService {
  static async list({ includeInactive = false } = {}) {
    const rows = await PriceList.find(includeInactive ? {} : { active: true }).sort({ name: 1 }).lean();
    return rows.map((r) => ({ ...r, id: String(r._id) }));
  }

  static async get(id) {
    if (!isId(id)) throw fail("That price list does not exist", 404, "PRICE_LIST_NOT_FOUND");
    const r = await PriceList.findById(id).lean();
    if (!r) throw fail("That price list does not exist", 404, "PRICE_LIST_NOT_FOUND");
    return { ...r, id: String(r._id) };
  }

  static async #checked(input) {
    const base = wrap(() => rules.validateList(input));
    const stockIds = base.lines.map((l) => l.stockId);
    if (stockIds.some((i) => !isId(i)) || base.customerIds.some((i) => !isId(i))) throw fail("An item or customer on the list is not valid", 400, "PRICE_LIST_INVALID");
    const [stocks, customers] = await Promise.all([
      Stock.find({ _id: { $in: stockIds } }).select("itemName").lean(),
      Customer.countDocuments({ _id: { $in: base.customerIds } }),
    ]);
    const names = new Map(stocks.map((s) => [String(s._id), s.itemName]));
    for (const l of base.lines) {
      if (!names.has(l.stockId)) throw fail("An item on the list does not exist", 400, "ITEM_NOT_FOUND");
      l.itemName = names.get(l.stockId);
    }
    if (customers !== base.customerIds.length) throw fail("A customer on the list does not exist", 400, "CUSTOMER_NOT_FOUND");
    return base;
  }

  static async create(input, createdBy) {
    const base = await this.#checked(input);
    if (await PriceList.exists({ name: base.name })) throw fail(`A price list called ${base.name} already exists`, 409, "PRICE_LIST_NAME_TAKEN");
    const r = await PriceList.create({ ...base, createdBy });
    return this.get(r._id);
  }

  static async update(id, input, updatedBy) {
    const r = await PriceList.findById(id);
    if (!r) throw fail("That price list does not exist", 404, "PRICE_LIST_NOT_FOUND");
    const base = await this.#checked(input);
    if (await PriceList.exists({ name: base.name, _id: { $ne: r._id } })) throw fail(`A price list called ${base.name} already exists`, 409, "PRICE_LIST_NAME_TAKEN");
    r.set({ ...base, updatedBy });
    if (typeof input.active === "boolean") r.active = input.active;
    await r.save();
    return this.get(r._id);
  }

  /** Every list that could price a sale to this customer on this route: the customer's own, and the route's. */
  static async candidates({ customerId, routeId, session } = {}) {
    let routeListId = null;
    if (isId(routeId)) {
      const q = VanRoute.findById(routeId).select("priceListId").lean();
      routeListId = (await (session ? q.session(session) : q))?.priceListId || null;
    }
    const or = [];
    if (isId(customerId)) or.push({ customerIds: customerId });
    if (routeListId) or.push({ _id: routeListId });
    if (!or.length) return { lists: [], routeListId };
    const q = PriceList.find({ active: true, $or: or }).lean();
    return { lists: await (session ? q.session(session) : q), routeListId };
  }

  /**
   * The price of each item for a customer, as the sell screen should offer it: Map(stockId -> {price, source, listName}).
   * `items` is [{ stockId, qty, itemPrice }].
   */
  static async pricesFor({ customerId, routeId, items, date, session }) {
    const { lists, routeListId } = await this.candidates({ customerId, routeId, session });
    const onDay = date ? String(date).slice(0, 10) : todayInOrg();
    const out = new Map();
    for (const it of items || []) {
      out.set(String(it.stockId), rules.priceFor({ stockId: it.stockId, qty: it.qty || 1, customerId, routeListId, date: onDay, lists, itemPrice: it.itemPrice }));
    }
    return out;
  }
}

module.exports = PriceListService;
