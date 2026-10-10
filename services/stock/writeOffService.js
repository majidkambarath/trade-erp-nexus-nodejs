const mongoose = require("mongoose");
const Stock = require("../../models/modules/stockModel");
const StockBatch = require("../../models/modules/stockBatchModel");
const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const costing = require("../../utils/inventoryCosting");
const NumberSeriesService = require("../core/numberSeriesService");
const FiscalYearService = require("../core/fiscalYearService");
const AccountConfigService = require("../financial/accountConfigService");
const PostingService = require("../financial/postingService");
const AppError = require("../../utils/AppError");
const ItemKindService = require("./itemKindService");

const REASONS = {
  expiry: { configKey: "write-off-expiry", label: "Expired stock" },
  damage: { configKey: "damage-loss", label: "Damaged / lost stock" },
};

// Writing off a batch takes stock out at the item's average cost (quantity on hand, cost pool and
// movement ledger), and - when ledger posting is on - books Dr write-off expense / Cr inventory.
class WriteOffService {
  static REASONS = REASONS;

  static async writeOff({ batchId, qty, reason = "expiry", note }, { adminId } = {}) {
    const rule = REASONS[reason];
    if (!rule) throw new AppError("reason must be expiry or damage", 400, "INVALID_REASON");
    const amount = Number(qty);
    if (!(amount > 0)) throw new AppError("Quantity must be greater than zero", 400, "INVALID_QTY");

    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        const date = new Date();
        await FiscalYearService.assertPostingAllowed(date, { session });

        const batch = await StockBatch.findById(batchId).session(session);
        if (!batch) throw new AppError("Batch not found", 404);
        if (amount > batch.qtyOnHand + 1e-6) {
          throw new AppError(`Only ${batch.qtyOnHand} left in batch ${batch.batchNumber}`, 422, "EXCEEDS_BATCH_QTY");
        }
        const stock = await Stock.findById(batch.stockId).session(session);
        if (!stock) throw new AppError("Stock item not found", 404);
        ItemKindService.assertStocked(stock, "be written off"); // a service has no batches, so this cannot happen by the screen

        const pool = {
          quantity: stock.currentStock,
          costValue: stock.costValue ?? costing.roundValue(stock.currentStock * (stock.purchasePrice || 0)),
          avgRate: costing.roundRate(stock.purchasePrice || 0),
        };
        const r = costing.applyMovement(pool, "sale", { qty: amount });
        const number = await NumberSeriesService.allocate("WO", date, { session });

        await Stock.updateOne(
          { _id: stock._id },
          { currentStock: r.pool.quantity, costValue: r.pool.costValue, purchasePrice: r.pool.avgRate },
          { session }
        );
        const [movement] = await InventoryMovement.create(
          [{
            stockId: stock.itemId, quantity: -amount, previousStock: stock.currentStock, newStock: r.pool.quantity,
            eventType: "DAMAGED_STOCK", referenceType: "Adjustment", referenceId: batch._id, referenceNumber: number,
            unitCost: r.rate, totalValue: r.cost, costBasis: "adjustment",
            rateBefore: pool.avgRate, rateAfter: r.pool.avgRate, costPoolAfter: r.pool.costValue, poolQtyAfter: r.pool.quantity,
            notes: `${rule.label} - batch ${batch.batchNumber}${note ? `: ${note}` : ""}`,
            createdBy: String(adminId || "system"), batchNumber: batch.batchNumber, expiryDate: batch.expiryDate, date,
          }],
          { session }
        );

        batch.qtyOnHand = Math.max(0, Math.round((batch.qtyOnHand - amount) * 1000) / 1000);
        if (batch.qtyOnHand <= 1e-6) batch.status = "written_off";
        await batch.save({ session });

        let posted = false;
        if (r.cost > 0 && (await AccountConfigService.isPostingEnabled({ session }))) {
          await PostingService.postSimple(
            { debitKey: rule.configKey, creditKey: "inventory-asset", amount: r.cost, date, voucherId: batch._id,
              voucherNo: number, voucherType: "stock_writeoff", narration: `${rule.label}: ${stock.itemName} (batch ${batch.batchNumber})`,
              adminId },
            { session }
          );
          posted = true;
        }
        result = { number, qty: amount, cost: r.cost, movementId: movement._id, posted, batchRemaining: batch.qtyOnHand };
      });
      return result;
    } finally {
      await session.endSession();
    }
  }
}

module.exports = WriteOffService;
