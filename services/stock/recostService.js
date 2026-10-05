const Stock = require("../../models/modules/stockModel");
const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const Transaction = require("../../models/modules/transactionModel");
const FiscalYear = require("../../models/modules/financial/fiscalYearModel");
const costing = require("../../utils/inventoryCosting");
const { getTenant } = require("../../utils/tenant");

// Basis for movements that predate the cost audit fields.
const BASIS_BY_EVENT = {
  PURCHASE_RECEIVE: "purchase",
  OPENING_STOCK: "purchase", // go-live stock keeps the cost it was entered at
  PURCHASE_RETURN: "purchaseReturn",
  SALES_DISPATCH: "sale",
  SALES_RETURN: "salesReturn",
};

class RecostService {
  // Called after a document is approved or an approved one is reversed. If the document's date
  // is earlier than other movements of the same item, those later movements were costed
  // against the wrong pool and are replayed in document-date order.
  static async recostAfterChange(transaction, { session } = {}) {
    const PostingService = require("../financial/postingService"); // avoids a require cycle
    const touched = [];
    for (const item of transaction.items || []) {
      const stock = await Stock.findById(item.itemId).session(session);
      if (!stock) continue;
      const later = await InventoryMovement.exists({
        stockId: stock.itemId,
        referenceType: "Transaction",
        isReversed: false,
        referenceId: { $ne: transaction._id },
        date: { $gt: transaction.date || new Date() },
      }).session(session);
      if (later) touched.push(stock._id);
    }
    for (const stockId of [...new Set(touched.map(String))]) {
      const deltas = await this.recostItem(stockId, transaction.date, { session });
      for (const [refId, delta] of deltas) {
        // The document being posted is not saved yet; every other one is read from the database.
        const tx =
          String(refId) === String(transaction._id)
            ? transaction
            : await Transaction.findById(refId).session(session).lean();
        if (tx) await PostingService.adjustCogs(tx, delta, { session });
      }
    }
  }

  // Replays one item's live movements from `fromDate` forward and rewrites their cost fields.
  // Movements before `fromDate` keep their stamped cost. Movements inside a CLOSED fiscal year
  // are locked: their stamped cost is kept (quantity still flows through the pool), so a closed
  // period is never restated.
  // Returns Map<transactionId, costDelta> for sales / sales returns whose cost changed.
  static async recostItem(stockId, fromDate, { session } = {}) {
    const stock = await Stock.findById(stockId).session(session);
    if (!stock) return new Map();

    const movements = await InventoryMovement.find({
      stockId: stock.itemId,
      referenceType: { $in: ["Transaction", "Adjustment"] },
      isReversed: false,
      referenceNumber: { $not: /^REV-/ }, // a reversal row and its original cancel out
    })
      .sort({ date: 1, createdAt: 1, _id: 1 })
      .session(session);

    const first = movements.findIndex((m) => m.date >= new Date(fromDate));
    if (first < 0) return new Map();

    const { companyId } = getTenant();
    const closed = await FiscalYear.find({ companyId, status: "closed" }).session(session).lean();
    const isLocked = (d) => closed.some((fy) => d >= fy.startDate && d <= fy.endDate);

    const prev = first > 0 ? movements[first - 1] : null;
    const head = movements[first];
    let pool =
      prev && prev.poolQtyAfter != null
        ? { quantity: prev.poolQtyAfter, costValue: prev.costPoolAfter, avgRate: prev.rateAfter }
        : {
            quantity: head.previousStock,
            avgRate: costing.roundRate(head.rateBefore || 0),
            costValue: costing.roundValue(head.previousStock * (head.rateBefore || 0)),
          };

    const deltas = new Map();
    for (let i = first; i < movements.length; i++) {
      const m = movements[i];
      // Adjustments and write-offs move stock at the running average, like a sale / a sales return.
      const basis =
        !m.costBasis || m.costBasis === "adjustment" || m.costBasis === "opening"
          ? BASIS_BY_EVENT[m.eventType] || (m.quantity > 0 ? "salesReturn" : "sale")
          : m.costBasis;
      const qty = Math.abs(m.quantity);
      const locked = isLocked(m.date);

      const args =
        basis === "purchase" || basis === "purchaseReturn"
          ? { qty, cost: m.totalValue } // documented cost never changes
          : basis === "sale"
          ? { qty, lockedCost: locked ? m.totalValue : undefined }
          : { qty, cogs: locked ? m.totalValue : undefined };

      const before = pool;
      const r = costing.applyMovement(pool, basis, args);
      pool = r.pool;

      const changed = Math.abs((m.totalValue || 0) - r.cost) >= 0.005 || m.rateAfter !== pool.avgRate;
      if (changed) {
        await InventoryMovement.updateOne(
          { _id: m._id },
          {
            unitCost: r.rate,
            totalValue: r.cost,
            costBasis: basis,
            rateBefore: before.avgRate,
            rateAfter: pool.avgRate,
            costPoolAfter: pool.costValue,
            poolQtyAfter: pool.quantity,
            cogsAmount: basis === "sale" ? r.cost : m.cogsAmount,
          },
          { session }
        );
      }
      if ((basis === "sale" || basis === "salesReturn") && !locked) {
        const delta = costing.roundValue(r.cost - (m.totalValue || 0));
        if (Math.abs(delta) >= 0.005) {
          deltas.set(String(m.referenceId), (deltas.get(String(m.referenceId)) || 0) + delta);
        }
      }
    }

    // The item's pool now reflects the replay. Quantity on hand is untouched.
    await Stock.updateOne(
      { _id: stock._id },
      { costValue: pool.costValue, purchasePrice: pool.avgRate },
      { session }
    );
    return deltas;
  }
}

module.exports = RecostService;
