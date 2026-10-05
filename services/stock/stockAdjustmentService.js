const Stock = require("../../models/modules/stockModel");
const StockBatch = require("../../models/modules/stockBatchModel");
const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const costing = require("../../utils/inventoryCosting");
const NumberSeriesService = require("../core/numberSeriesService");
const FiscalYearService = require("../core/fiscalYearService");
const AccountConfigService = require("../financial/accountConfigService");
const PostingService = require("../financial/postingService");
const BatchService = require("./batchService");
const { getTenant } = require("../../utils/tenant");

// A manual change to the quantity on hand (a stock count, a correction, a movement typed in on the
// Inventory page). It is costed and booked like every other stock event:
//   - a decrease leaves at the item's average cost and takes the batches first-expiry-first-out;
//   - an increase enters at the cost given (else the current average, so the average is unchanged);
//   - the cost pool (Stock.currentStock / costValue / purchasePrice) and the movement carry the
//     before / after rate, so the stock ledger can be audited without replaying anything;
//   - when ledger posting is on: gain = Dr Inventory / Cr Stock adjustment, loss = the reverse.
// Runs inside the caller's session.
class StockAdjustmentService {
  static async apply(
    { stock, newQuantity, unitCost, eventType = "STOCK_ADJUSTMENT", referenceNumber, notes, batchNumber, expiryDate, location, createdBy, date = new Date() },
    { session }
  ) {
    if (Math.abs(Number(newQuantity) - Number(stock.currentStock)) < 1e-9) return null;
    await FiscalYearService.assertPostingAllowed(date, { session });

    const pool = {
      quantity: stock.currentStock,
      costValue: stock.costValue ?? costing.roundValue(stock.currentStock * (stock.purchasePrice || 0)),
      avgRate: costing.roundRate(stock.purchasePrice || 0),
    };
    const qty = Math.abs(Number(newQuantity) - Number(stock.currentStock));
    let result;
    if (Number(newQuantity) < Number(stock.currentStock)) {
      result = costing.applyMovement(pool, "sale", { qty }); // out at the average
    } else {
      const rate = Number(unitCost) > 0 ? Number(unitCost) : pool.avgRate;
      result = costing.applyMovement(pool, "purchase", { qty, cost: qty * rate }); // in at the cost given
    }

    const number = await NumberSeriesService.allocate("SA", date, { session });
    await Stock.updateOne(
      { _id: stock._id },
      { currentStock: result.pool.quantity, costValue: result.pool.costValue, purchasePrice: result.pool.avgRate },
      { session }
    );

    const decrease = Number(newQuantity) < Number(stock.currentStock);
    if (decrease) {
      await BatchService.allocate({ stockId: stock._id, qty, orderDate: date }, { session }); // a shortfall is tolerated: older stock may carry no batch
    } else if (batchNumber) {
      const { companyId } = getTenant();
      await StockBatch.create(
        [{
          companyId, stockId: stock._id, itemCode: stock.itemId, batchNumber: String(batchNumber).trim(),
          expiryDate: expiryDate ? new Date(expiryDate) : null, receivedQty: qty, qtyOnHand: qty,
          unitCost: result.rate, sourceTransactionNo: number, receivedAt: date,
        }],
        { session }
      );
    }

    const [movement] = await InventoryMovement.create(
      [{
        stockId: stock.itemId, quantity: decrease ? -qty : qty, previousStock: stock.currentStock, newStock: result.pool.quantity,
        eventType, referenceType: "Adjustment", referenceId: stock._id, referenceNumber: referenceNumber || number,
        unitCost: result.rate, totalValue: result.cost, costBasis: "adjustment",
        rateBefore: pool.avgRate, rateAfter: result.pool.avgRate, costPoolAfter: result.pool.costValue, poolQtyAfter: result.pool.quantity,
        notes: notes || `Manual stock adjustment: ${decrease ? "removed" : "added"} ${qty} units`,
        createdBy: String(createdBy || "system"), batchNumber: batchNumber || stock.batchNumber,
        expiryDate: expiryDate ? new Date(expiryDate) : stock.expiryDate, location, date,
      }],
      { session }
    );

    let posted = false;
    if (result.cost > 0 && (await AccountConfigService.isPostingEnabled({ session }))) {
      await PostingService.postSimple(
        {
          debitKey: decrease ? "stock-adjustment" : "inventory-asset",
          creditKey: decrease ? "inventory-asset" : "stock-adjustment",
          amount: result.cost, date, voucherId: movement._id, voucherNo: number, voucherType: "stock_adjustment",
          narration: `Stock ${decrease ? "loss" : "gain"}: ${stock.itemName} (${decrease ? "-" : "+"}${qty})${referenceNumber ? ` ref ${referenceNumber}` : ""}`,
          adminId: createdBy,
        },
        { session }
      );
      posted = true;
    }
    return { movement, number, cost: result.cost, posted };
  }
}

module.exports = StockAdjustmentService;
