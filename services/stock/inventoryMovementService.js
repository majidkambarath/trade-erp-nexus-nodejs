const mongoose = require("mongoose");
const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const Stock = require("../../models/modules/stockModel");
const Admin = require("../../models/core/adminModel");
const AppError = require("../../utils/AppError");
const { searchRegex } = require("../../utils/regex");

// The movement screen's list and its figures.
//
// `totalValue` on a movement is the COST that moved with the stock and is stored positive for both directions (a sale of 358
// units carries +24,018.22, exactly like a purchase), so a plain sum of it adds what came in to what went out and means nothing.
// Its worth is signed by the quantity - the same rule the stock valuation uses (`stockReportsService`: sign(quantity) x |totalValue|)
// - which makes the card "net value moved" and lets it be read against the Inventory account.

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100 || 0; // `|| 0` turns -0 into 0

/** What one movement is worth, with its direction: + when stock came in, - when it went out, 0 for a zero quantity. */
const signedValue = (m) => Math.sign(Number(m.quantity) || 0) * Math.abs(Number(m.totalValue) || 0);

const MAX_LIMIT = 200;
const isObjectIdText = (v) => /^[0-9a-f]{24}$/i.test(String(v));

function asDate(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new AppError(`${label} is not a valid date`, 400, "INVALID_DATE");
  return d;
}

class InventoryMovementService {
  /** The Mongo filter for a date range, an event type and a direction (not the search, which needs a lookup). */
  static filterFor({ startDate, endDate, eventType, movementType } = {}) {
    const query = {};
    const from = asDate(startDate, "Start date");
    const to = asDate(endDate, "End date");
    if (from || to) {
      query.date = {};
      if (from) query.date.$gte = from;
      if (to) query.date.$lte = to;
    }
    if (eventType) query.eventType = String(eventType);
    if (movementType === "IN") query.quantity = { $gt: 0 };
    else if (movementType === "OUT") query.quantity = { $lt: 0 };
    return query;
  }

  /**
   * One page of movements, newest first, each with the item's name and the name of the person who recorded it.
   * `search` matches an item's id, SKU or name, or the movement's reference number (the field says so).
   */
  static async list({ search, page = 1, limit = 10, ...filters } = {}) {
    const query = InventoryMovementService.filterFor(filters);
    const take = Math.min(Math.max(Math.floor(Number(limit)) || 10, 1), MAX_LIMIT);
    const at = Math.max(Math.floor(Number(page)) || 1, 1);

    const text = typeof search === "string" ? search.trim() : "";
    if (text) {
      const rx = searchRegex(text);
      const items = await Stock.find({ $or: [{ itemId: rx }, { sku: rx }, { itemName: rx }] }).select("itemId").lean();
      query.$or = [{ stockId: { $in: items.map((s) => s.itemId) } }, { referenceNumber: rx }];
    }

    const [rows, total] = await Promise.all([
      // `_id` breaks the tie between movements of one date: without it a page boundary inside a day could repeat or skip rows
      InventoryMovement.find(query).sort({ date: -1, _id: -1 }).skip((at - 1) * take).limit(take).lean(),
      InventoryMovement.countDocuments(query),
    ]);

    const names = await InventoryMovementService.names(rows);
    return {
      movements: rows.map((m) => ({
        ...m,
        itemName: names.items.get(m.stockId) || null,
        createdByName: InventoryMovementService.who(m.createdBy, names.people),
      })),
      total,
      totalPages: Math.ceil(total / take),
    };
  }

  /** Item names and people's names for a page of rows, in two queries (not one per row). */
  static async names(rows) {
    const itemIds = [...new Set(rows.map((m) => m.stockId).filter(Boolean))];
    const adminIds = [...new Set(rows.map((m) => String(m.createdBy || "")).filter(isObjectIdText))];
    const [items, admins] = await Promise.all([
      itemIds.length ? Stock.find({ itemId: { $in: itemIds } }).select("itemId itemName").lean() : [],
      adminIds.length ? Admin.find({ _id: { $in: adminIds.map((id) => new mongoose.Types.ObjectId(id)) } }).select("name email").lean() : [],
    ]);
    return {
      items: new Map(items.map((s) => [s.itemId, s.itemName])),
      people: new Map(admins.map((a) => [String(a._id), a.name || a.email || null])),
    };
  }

  /** `createdBy` holds an account id for a person, or a word ("system") for something the system did. */
  static who(createdBy, people) {
    const raw = String(createdBy ?? "").trim();
    if (!raw) return null;
    if (isObjectIdText(raw)) return people.get(raw) || null; // an account that has since been removed has no name to show
    return raw.toLowerCase() === "system" ? "System" : raw;
  }

  /**
   * The cards above the list: how many movements, how many in and out, and what they were worth.
   * `totalValue` is the NET value moved (in minus out); `valueIn` and `valueOut` are its two halves.
   */
  static async stats({ startDate, endDate } = {}) {
    const match = InventoryMovementService.filterFor({ startDate, endDate });
    const cost = { $abs: { $ifNull: ["$totalValue", 0] } };
    const [s] = await InventoryMovement.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalMovements: { $sum: 1 },
          stockIn: { $sum: { $cond: [{ $gt: ["$quantity", 0] }, 1, 0] } },
          stockOut: { $sum: { $cond: [{ $lt: ["$quantity", 0] }, 1, 0] } },
          valueIn: { $sum: { $cond: [{ $gt: ["$quantity", 0] }, cost, 0] } },
          valueOut: { $sum: { $cond: [{ $lt: ["$quantity", 0] }, cost, 0] } },
          recentMovements: { $sum: { $cond: [{ $gte: ["$date", new Date(Date.now() - 24 * 60 * 60 * 1000)] }, 1, 0] } },
        },
      },
    ]);
    const valueIn = round2(s?.valueIn);
    const valueOut = round2(s?.valueOut);
    return {
      totalMovements: s?.totalMovements || 0,
      stockIn: s?.stockIn || 0,
      stockOut: s?.stockOut || 0,
      valueIn,
      valueOut,
      totalValue: round2(valueIn - valueOut),
      recentMovements: s?.recentMovements || 0,
    };
  }
}

InventoryMovementService.signedValue = signedValue;
module.exports = InventoryMovementService;
