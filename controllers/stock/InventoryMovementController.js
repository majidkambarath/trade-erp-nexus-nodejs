const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const StockService = require("../../services/stock/stockService");
const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");

class InventoryMovementController {
  // Create a new inventory movement
  static createMovement = catchAsync(async (req, res) => {
    const createdBy = req.user?.id || req.body.createdBy || "system";
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

    const movement = await StockService.createInventoryMovement({
      stockId,
      quantity: Number(quantity),
      previousStock,
      newStock,
      eventType,
      referenceType: eventType === "INITIAL_STOCK" ? "Initial" : "Adjustment",
      referenceId: stock._id,
      referenceNumber,
      unitCost: Number(unitCost) || stock.purchasePrice,
      totalValue: Math.abs(Number(quantity)) * (Number(unitCost) || stock.purchasePrice),
      notes,
      createdBy,
      batchNumber,
      expiryDate: expiryDate ? new Date(expiryDate) : undefined,
      location,
    });

    // Update stock quantity
    await StockService.updateStock(stock._id, { currentStock: newStock }, createdBy);

    res.status(201).json({
      status: "success",
      data: { movement },
    });
  });

  // Get all inventory movements
  static getAllMovements = catchAsync(async (req, res) => {
    const { startDate, endDate, eventType, movementType, search, page = 1, limit = 10 } = req.query;
    const query = {};

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    if (eventType) query.eventType = eventType;
    if (movementType) query.quantity = movementType === "IN" ? { $gt: 0 } : { $lt: 0 };

    if (search) {
      const stocks = await StockService.getAllStock({ search });
      const stockIds = stocks.map(stock => stock.itemId);
      query.stockId = { $in: stockIds };
    }

    const movements = await InventoryMovement.find(query)
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .sort({ date: -1 })
      .populate({ path: "stockId", select: "itemName" });

    const total = await InventoryMovement.countDocuments(query);

    res.status(200).json({
      status: "success",
      results: movements.length,
      total,
      totalPages: Math.ceil(total / limit),
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
    const { startDate, endDate } = req.query;
    const match = {};

    if (startDate || endDate) {
      match.date = {};
      if (startDate) match.date.$gte = new Date(startDate);
      if (endDate) match.date.$lte = new Date(endDate);
    }

    const stats = await InventoryMovement.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalMovements: { $sum: 1 },
          stockIn: { $sum: { $cond: [{ $gt: ["$quantity", 0] }, 1, 0] } },
          stockOut: { $sum: { $cond: [{ $lt: ["$quantity", 0] }, 1, 0] } },
          totalValue: { $sum: "$totalValue" },
          recentMovements: {
            $sum: {
              $cond: [
                {
                  $gte: [
                    "$date",
                    new Date(Date.now() - 24 * 60 * 60 * 1000),
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);

    res.status(200).json({
      status: "success",
      data: {
        stats: stats[0] || {
          totalMovements: 0,
          stockIn: 0,
          stockOut: 0,
          totalValue: 0,
          recentMovements: 0,
        },
      },
    });
  });
}

module.exports = InventoryMovementController;