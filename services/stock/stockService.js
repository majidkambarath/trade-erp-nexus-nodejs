const Stock = require("../../models/modules/stockModel");
const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const AppError = require("../../utils/AppError");
const mongoose = require("mongoose");

class StockService {
  // Create stock with initial inventory movement
  static async createStock(data, createdBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const {
        itemId,
        sku,
        itemName,
        category,
        unitOfMeasure,
        barcodeQrCode,
        reorderLevel,
        batchNumber,
        expiryDate,
        purchasePrice,
        salesPrice,
        currentStock,
        status,
      } = data;

      // Generate itemId if not provided
      const newItemId =
        itemId ||
        `ITM${new Date().toISOString().slice(0, 4).replace(/-/g, "")}-${
          Math.floor(Math.random() * 1000) + 100
        }`;

      // Check if SKU already exists
      const existingSku = await Stock.findOne({ sku }).session(session);
      if (existingSku) {
        throw new AppError("SKU already exists", 400);
      }

      // Create stock record
      const stock = await Stock.create(
        [
          {
            itemId: newItemId,
            sku,
            itemName,
            category,
            unitOfMeasure,
            barcodeQrCode,
            reorderLevel: Number(reorderLevel) || 0,
            batchNumber,
            expiryDate: expiryDate ? new Date(expiryDate) : undefined,
            purchasePrice: Number(purchasePrice) || 0,
            salesPrice: Number(salesPrice) || 0,
            currentStock: Number(currentStock) || 0,
            status,
          },
        ],
        { session }
      );

      // Create initial inventory movement if stock > 0
      const initialStock = Number(currentStock) || 0;
      if (initialStock > 0) {
        await this.createInventoryMovement(
          {
            stockId: newItemId,
            quantity: initialStock,
            previousStock: 0,
            newStock: initialStock,
            eventType: "INITIAL_STOCK",
            referenceType: "Initial",
            referenceId: stock[0]._id,
            referenceNumber: `INIT-${newItemId}`,
            unitCost: Number(purchasePrice) || 0,
            totalValue: initialStock * (Number(purchasePrice) || 0),
            notes: "Initial stock entry",
            createdBy,
            batchNumber,
            expiryDate,
          },
          session
        );
      }

      await session.commitTransaction();
      return stock[0];
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  // Update stock with inventory tracking
  static async updateStock(id, data, createdBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const currentStock = await Stock.findById(id).session(session);
      if (!currentStock) {
        throw new AppError("Stock item not found", 404);
      }

      // Check SKU uniqueness if updating
      if (data.sku && data.sku !== currentStock.sku) {
        const existingSku = await Stock.findOne({
          sku: data.sku,
          _id: { $ne: id },
        }).session(session);
        if (existingSku) {
          throw new AppError("SKU already exists", 400);
        }
      }

      // Handle stock quantity update
      const oldQuantity = currentStock.currentStock;
      const newQuantity =
        data.currentStock !== undefined
          ? Number(data.currentStock)
          : oldQuantity;

      // Validate non-negative stock
      if (newQuantity < 0) {
        throw new AppError("Stock quantity cannot be negative", 400);
      }

      // Convert numeric fields
      const updateData = { ...data };
      if (data.reorderLevel)
        updateData.reorderLevel = Number(data.reorderLevel);
      if (data.purchasePrice)
        updateData.purchasePrice = Number(data.purchasePrice);
      if (data.salesPrice) updateData.salesPrice = Number(data.salesPrice);
      if (data.currentStock)
        updateData.currentStock = Number(data.currentStock);
      if (data.expiryDate) updateData.expiryDate = new Date(data.expiryDate);

      const updatedStock = await Stock.findByIdAndUpdate(id, updateData, {
        new: true,
        runValidators: true,
        session,
      });

      // Create inventory movement if stock quantity changed
      if (newQuantity !== oldQuantity) {
        const quantityChange = newQuantity - oldQuantity;
        await this.createInventoryMovement(
          {
            stockId: currentStock.itemId,
            quantity: quantityChange,
            previousStock: oldQuantity,
            newStock: newQuantity,
            eventType: "STOCK_ADJUSTMENT",
            referenceType: "Adjustment",
            referenceId: updatedStock._id,
            referenceNumber: `ADJ-${Date.now()}`,
            unitCost: updatedStock.purchasePrice,
            totalValue: Math.abs(quantityChange) * updatedStock.purchasePrice,
            notes: `Manual stock adjustment: ${
              quantityChange > 0 ? "Added" : "Removed"
            } ${Math.abs(quantityChange)} units`,
            createdBy,
            batchNumber: currentStock.batchNumber,
            expiryDate: currentStock.expiryDate,
          },
          session
        );
      }

      await session.commitTransaction();
      return updatedStock;
    } catch (error) {
      await session.abortTransaction();
      // Log the error for debugging (consider using a proper logging library like Winston)
      console.error(`Error updating stock (ID: ${id}):`, error.message);
      throw error;
    } finally {
      session.endSession();
    }
  }

  // Process transaction and update stock
  static async processTransactionStock(
    transactionId,
    transactionData,
    createdBy
  ) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { type, items, transactionNo } = transactionData;
      const stockUpdates = [];

      for (const item of items) {
        const stock = await Stock.findOne({ itemId: item.itemId }).session(
          session
        );
        if (!stock) {
          throw new AppError(`Stock item ${item.itemId} not found`, 404);
        }

        const quantityChange = this.getQuantityChange(type, item.qty);
        const newStock = stock.currentStock + quantityChange;

        // Validate sufficient stock for outgoing transactions
        if (quantityChange < 0 && newStock < 0) {
          throw new AppError(
            `Insufficient stock for ${item.description}. Available: ${stock.currentStock}, Required: ${item.qty}`,
            400
          );
        }

        // Update stock
        await Stock.findByIdAndUpdate(
          stock._id,
          {
            currentStock: newStock,
          },
          { session }
        );

        // Create inventory movement
        const movement = await this.createInventoryMovement(
          {
            stockId: item.itemId,
            quantity: quantityChange,
            previousStock: stock.currentStock,
            newStock: newStock,
            eventType: this.getEventType(type),
            referenceType: "Transaction",
            referenceId: transactionId,
            referenceNumber: transactionNo,
            unitCost: item.rate,
            totalValue: Math.abs(quantityChange) * item.rate,
            notes: `${this.getEventType(type)} - ${item.description}`,
            createdBy,
            batchNumber: stock.batchNumber,
            expiryDate: stock.expiryDate,
          },
          session
        );

        stockUpdates.push({
          itemId: item.itemId,
          previousStock: stock.currentStock,
          newStock: newStock,
          movement: movement,
        });
      }

      await session.commitTransaction();
      return stockUpdates;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  // Reverse transaction stock changes
  static async reverseTransactionStock(
    transactionId,
    transactionData,
    createdBy
  ) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { type, items, transactionNo } = transactionData;

      // Find existing movements for this transaction
      const existingMovements = await InventoryMovement.find({
        referenceId: transactionId,
        referenceType: "Transaction",
      }).session(session);

      for (const movement of existingMovements) {
        const stock = await Stock.findOne({ itemId: movement.stockId }).session(
          session
        );
        if (!stock) continue;

        // Reverse the quantity
        const reversalQuantity = -movement.quantity;
        const newStock = stock.currentStock + reversalQuantity;

        // Update stock
        await Stock.findOneAndUpdate(
          { itemId: movement.stockId },
          { currentStock: newStock },
          { session }
        );

        // Create reversal movement
        await this.createInventoryMovement(
          {
            stockId: movement.stockId,
            quantity: reversalQuantity,
            previousStock: stock.currentStock,
            newStock: newStock,
            eventType: movement.eventType,
            referenceType: "Transaction",
            referenceId: transactionId,
            referenceNumber: `REV-${transactionNo}`,
            unitCost: movement.unitCost,
            totalValue: Math.abs(reversalQuantity) * movement.unitCost,
            notes: `Reversal of ${movement.notes}`,
            createdBy,
            batchNumber: movement.batchNumber,
            expiryDate: movement.expiryDate,
          },
          session
        );

        // Mark original movement as reversed
        await InventoryMovement.findByIdAndUpdate(
          movement._id,
          { isReversed: true },
          { session }
        );
      }

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  // Helper method to create inventory movement
  static async createInventoryMovement(movementData, session = null) {
    const movement = new InventoryMovement(movementData);
    return movement.save({ session });
  }

  // Helper method to determine quantity change based on transaction type
  static getQuantityChange(transactionType, quantity) {
    const quantityMap = {
      purchase_order: quantity, // Add stock
      sales_order: -quantity, // Reduce stock
      purchase_return: -quantity, // Reduce stock (returning to supplier)
      sales_return: quantity, // Add stock (customer returning)
    };

    return quantityMap[transactionType] || 0;
  }

  // Helper method to determine event type
  static getEventType(transactionType) {
    const eventMap = {
      purchase_order: "PURCHASE_RECEIVE",
      sales_order: "SALES_DISPATCH",
      purchase_return: "PURCHASE_RETURN",
      sales_return: "SALES_RETURN",
    };

    return eventMap[transactionType];
  }

  // Get stock history for an item
  static async getStockHistory(itemId, startDate, endDate) {
    return InventoryMovement.getStockHistory(itemId, startDate, endDate);
  }

  // Get current stock with movements summary
  static async getStockWithMovements(itemId) {
    const stock = await Stock.findOne({ itemId });
    if (!stock) {
      throw new AppError("Stock item not found", 404);
    }

    const movements = await InventoryMovement.find({ stockId: itemId })
      .sort({ date: -1 })
      .limit(20);

    const movementsSummary = await InventoryMovement.aggregate([
      { $match: { stockId: itemId } },
      {
        $group: {
          _id: "$eventType",
          totalQuantity: { $sum: "$quantity" },
          count: { $sum: 1 },
          totalValue: { $sum: "$totalValue" },
        },
      },
    ]);

    return {
      stock,
      recentMovements: movements,
      movementsSummary,
    };
  }

  // Get low stock items
  static async getLowStockItems() {
    return Stock.find({
      $expr: { $lte: ["$currentStock", "$reorderLevel"] },
      status: "Active",
    }).sort({ currentStock: 1 });
  }

  // Get stock valuation
  static async getStockValuation() {
    return Stock.aggregate([
      {
        $match: { status: "Active" },
      },
      {
        $group: {
          _id: null,
          totalItems: { $sum: 1 },
          totalQuantity: { $sum: "$currentStock" },
          totalPurchaseValue: {
            $sum: { $multiply: ["$currentStock", "$purchasePrice"] },
          },
          totalSalesValue: {
            $sum: { $multiply: ["$currentStock", "$salesPrice"] },
          },
        },
      },
    ]);
  }

  // Existing methods with improvements...
  static async getAllStock(filters) {
    const query = {};

    // Search functionality
    if (filters.search) {
      query.$or = [
        { itemId: new RegExp(filters.search, "i") },
        { sku: new RegExp(filters.search, "i") },
        { itemName: new RegExp(filters.search, "i") },
        { category: new RegExp(filters.search, "i") },
        { batchNumber: new RegExp(filters.search, "i") },
      ];
    }

    // Filter by status
    if (filters.status) query.status = filters.status;

    // Filter by category
    if (filters.category) query.category = filters.category;

    // Filter by low stock
    if (filters.lowStock === "true") {
      query.$expr = { $lte: ["$currentStock", "$reorderLevel"] };
    }

    // Filter by stock range
    if (filters.minStock)
      query.currentStock = { $gte: Number(filters.minStock) };
    if (filters.maxStock) {
      query.currentStock = {
        ...query.currentStock,
        $lte: Number(filters.maxStock),
      };
    }

    // Filter by price range
    if (filters.minPrice) query.salesPrice = { $gte: Number(filters.minPrice) };
    if (filters.maxPrice) {
      query.salesPrice = {
        ...query.salesPrice,
        $lte: Number(filters.maxPrice),
      };
    }

    return Stock.find(query).sort({ createdAt: -1 });
  }

  static async getStockById(id) {
    const stock = await Stock.findById(id);
    if (!stock) throw new AppError("Stock item not found", 404);
    return stock;
  }

  static async getStockByItemId(itemId) {
    const stock = await Stock.findOne({ itemId });
    if (!stock) throw new AppError("Stock item not found", 404);
    return stock;
  }

  static async deleteStock(id) {
    console.log(id);
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const stock = await Stock.findById(id).session(session);
      if (!stock) throw new AppError("Stock item not found", 404);
      // Check if there are any pending transactions
      const movements = await InventoryMovement.find({
        stockId: stock.itemId,
      }).session(session);

      if (movements.length > 0) {
        throw new AppError(
          "Cannot delete stock item with existing inventory movements",
          400
        );
      }

      await Stock.findByIdAndDelete(id).session(session);

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async getStockStats() {
    const stats = await Stock.aggregate([
      {
        $group: {
          _id: null,
          totalItems: { $sum: 1 },
          activeItems: {
            $sum: { $cond: [{ $eq: ["$status", "Active"] }, 1, 0] },
          },
          inactiveItems: {
            $sum: { $cond: [{ $eq: ["$status", "Inactive"] }, 1, 0] },
          },
          lowStockItems: {
            $sum: {
              $cond: [{ $lte: ["$currentStock", "$reorderLevel"] }, 1, 0],
            },
          },
          totalStockValue: {
            $sum: { $multiply: ["$currentStock", "$purchasePrice"] },
          },
          totalSalesValue: {
            $sum: { $multiply: ["$currentStock", "$salesPrice"] },
          },
          totalCurrentStock: { $sum: "$currentStock" },
        },
      },
    ]);

    return (
      stats[0] || {
        totalItems: 0,
        activeItems: 0,
        inactiveItems: 0,
        lowStockItems: 0,
        totalStockValue: 0,
        totalSalesValue: 0,
        totalCurrentStock: 0,
      }
    );
  }

  static async getCategoriesWithCount() {
    return Stock.aggregate([
      {
        $group: {
          _id: "$category",
          count: { $sum: 1 },
          totalStock: { $sum: "$currentStock" },
          totalValue: {
            $sum: { $multiply: ["$currentStock", "$purchasePrice"] },
          },
        },
      },
      { $sort: { count: -1 } },
    ]);
  }
}

module.exports = StockService;
