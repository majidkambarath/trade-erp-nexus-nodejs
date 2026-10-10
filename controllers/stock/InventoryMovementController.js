const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const InventoryMovementService = require("../../services/stock/inventoryMovementService");
const StockService = require("../../services/stock/stockService");
const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");

class InventoryMovementController {
  // Create a new inventory movement
  static createMovement = catchAsync(async (req, res) => {
    const createdBy = req.admin?.id || req.user?.id || req.body.createdBy || "system";
    const {
      stockId,
      quantity,
      eventType,
      referenceNumber,
      unitCost,
      notes,
      batchNumber,
      expiryDate,
      location,
    } = req.body;

    if (!stockId || !quantity || !eventType || !referenceNumber) {
      throw new AppError("Stock ID, quantity, event type, and reference number are required", 400);
    }

    const stock = await StockService.getStockByItemId(stockId);
    const previousStock = stock.currentStock;
    const newStock = previousStock + Number(quantity);

    if (newStock < 0) {
      throw new AppError("Stock quantity cannot be negative", 400);
    }

    // One stock event: the quantity, its cost, the batch, the movement row and (when posting is on)
    // the ledger entry are written together, so the movement is recorded exactly once.
    const updated = await StockService.updateStock(
      stock._id,
      { currentStock: newStock },
      createdBy,
      {
        eventType,
        referenceNumber,
        unitCost: Number(unitCost) || undefined,
        notes,
        batchNumber,
        expiryDate,
        location,
      }
    );
    const { movement } = updated.$locals.adjustment;

    res.status(201).json({
      status: "success",
      data: { movement },
    });
  });

  // Get all inventory movements
  static getAllMovements = catchAsync(async (req, res) => {
    const { movements, total, totalPages } = await InventoryMovementService.list(req.query);

    res.status(200).json({
      status: "success",
      results: movements.length,
      total,
      totalPages,
      data: { movements },
    });
  });

  // Get movement by ID
  static getMovementById = catchAsync(async (req, res) => {
    const movement = await InventoryMovement.findById(req.params.id);
    if (!movement) throw new AppError("Movement not found", 404);

    res.status(200).json({
      status: "success",
      data: { movement },
    });
  });

  // Get movement statistics
  static getMovementStats = catchAsync(async (req, res) => {
    const stats = await InventoryMovementService.stats(req.query);

    res.status(200).json({
      status: "success",
      data: { stats },
    });
  });
}

module.exports = InventoryMovementController;