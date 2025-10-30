const Stock = require("../../models/modules/stockModel");
const Category = require("../../models/modules/categoryModel");
const Vendor = require("../../models/modules/vendorModel");
const StockPurchaseLog = require("../../models/modules/StockPurchaseLog"); // Import StockPurchaseLog model
const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const AppError = require("../../utils/AppError");
const mongoose = require("mongoose");

class StockService {
  static async createStock(data, createdBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const {
        itemId,
        sku,
        itemName,
        categoryId,
        vendorId,
        unitOfMeasure,
        barcodeQrCode,
        reorderLevel,
        batchNumber,
        expiryDate,
        purchasePrice,
        salesPrice,
        currentStock,
        status,
        origin,
        brand,
      } = data;

      // Validate category exists
      const categoryExists = await Category.findById(categoryId).session(
        session
      );
      if (!categoryExists) {
        throw new AppError("Category not found", 404);
      }

      // Validate vendor exists
      const vendorExists = await Vendor.findById(vendorId).session(session);
      if (!vendorExists) {
        throw new AppError("Vendor not found", 404);
      }

      // Generate itemId if not provided
      function generateItemId(itemName, itemId = null) {
        const prefix = itemName
          ? itemName.trim().substring(0, 3).toUpperCase()
          : "ITM"; // fallback if name missing

        const randomNum = Math.floor(1000 + Math.random() * 9000); // 4-digit random number

        const newItemId = itemId || `${prefix}${randomNum}`;
        return newItemId;
      }

      const newItemId = generateItemId(itemName);
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
            category: categoryId,
            vendorId,
            unitOfMeasure,
            barcodeQrCode: sku,
            reorderLevel: Number(reorderLevel) || 0,
            batchNumber,
            expiryDate: expiryDate ? new Date(expiryDate) : undefined,
            purchasePrice: Number(purchasePrice) || 0,
            salesPrice: Number(salesPrice) || 0,
            currentStock: Number(currentStock) || 0,
            status,
            origin,
            brand,
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
            origin,
            brand,
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

      // Validate category if provided
      if (data.category) {
        const categoryExists = await Category.findById(data.category).session(
          session
        );
        if (!categoryExists) {
          throw new AppError("Category not found", 404);
        }
      }

      // Validate vendor if provided
      if (data.vendorId) {
        const vendorExists = await Vendor.findById(data.vendorId).session(
          session
        );
        if (!vendorExists) {
          throw new AppError("Vendor not found", 404);
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
      console.error(`Error updating stock (ID: ${id}):`, error.message);
      throw error;
    } finally {
      session.endSession();
    }
  }

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

        if (quantityChange < 0 && newStock < 0) {
          throw new AppError(
            `Insufficient stock for ${item.description}. Available: ${stock.currentStock}, Required: ${item.qty}`,
            400
          );
        }

        let newPurchasePrice = stock.purchasePrice;
        if (type === "purchase_order") {
          // Calculate weighted average price
          const currentValue = stock.purchasePrice * stock.currentStock;
          const newValue = item.rate; //item.price * item.qty
          const totalQuantity = stock.currentStock + item.qty;
          newPurchasePrice =
            totalQuantity > 0
              ? (currentValue + newValue) / totalQuantity
              : stock.purchasePrice;
        }

        await Stock.findByIdAndUpdate(
          stock._id,
          {
            currentStock: newStock,
            purchasePrice: newPurchasePrice,
            updatedAt: new Date(),
          },
          { session }
        );

        const movement = await this.createInventoryMovement(
          {
            stockId: item.itemId,
            quantity: quantityChange,
            previousStock: stock.currentStock,
            newStock,
            eventType: this.getEventType(type),
            referenceType: "Transaction",
            referenceId: transactionId,
            referenceNumber: transactionNo,
            unitCost: item.price,
            totalValue: Math.abs(quantityChange) * item.price,
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
          newStock,
          newPurchasePrice,
          movement,
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

 static async getPurchaseLogsByItemId(itemId) {
  try {
    // Convert itemId to ObjectId
    const stockId = new mongoose.Types.ObjectId(itemId);

    // Find the stock document to confirm it exists
    const stock = await Stock.findOne({ _id: stockId });
    if (!stock) {
      throw new AppError("Stock item not found", 404);
    }

    // Find purchase logs where items.itemId matches the stock._id
    const purchaseLogs = await StockPurchaseLog.find({
      "items.itemId": stockId,
    })
      .populate({
        path: "partyId",
        select: "vendorName", // Select only vendorName
      })
      .lean();

    console.log("Raw purchase logs:", purchaseLogs);

    // Format the response to include only relevant item details
    const formattedLogs = purchaseLogs.map((log) => ({
      transactionNo: log.transactionNo,
      type: log.type,
      party: log.partyId ? log.partyId.vendorName : "N/A", // Use vendorName
      date: log.date,
      deliveryDate: log.deliveryDate,
      items: log.items
        .filter((item) => item.itemId.toString() === stockId.toString())
        .map((item) => ({
          itemId: item.itemId,
          description: item.description,
          qty: item.qty,
          rate: item.rate,
          vatPercent: item.vatPercent,
          price: item.price,
          expiryDate: item.expiryDate,
        })),
      terms: log.terms,
      notes: log.notes,
      priority: log.priority,
      createdAt: log.createdAt,
      updatedAt: log.updatedAt,
    }));

    return formattedLogs;
  } catch (error) {
    throw new AppError(
      error.message || "Error fetching purchase logs",
      error.statusCode || 500
    );
  }
}
  static async reverseTransactionStock(
    transactionId,
    transactionData,
    createdBy
  ) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { type, items, transactionNo } = transactionData;

      const existingMovements = await InventoryMovement.find({
        referenceId: transactionId,
        referenceType: "Transaction",
      }).session(session);

      for (const movement of existingMovements) {
        const stock = await Stock.findOne({ itemId: movement.stockId }).session(
          session
        );
        if (!stock) continue;

        const reversalQuantity = -movement.quantity;
        const newStock = stock.currentStock + reversalQuantity;

        // Note: Not updating purchasePrice on reversal
        await Stock.findOneAndUpdate(
          { itemId: movement.stockId },
          { currentStock: newStock, updatedAt: new Date() },
          { session }
        );

        await this.createInventoryMovement(
          {
            stockId: movement.stockId,
            quantity: reversalQuantity,
            previousStock: stock.currentStock,
            newStock,
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

  static async createInventoryMovement(movementData, session = null) {
    const movement = new InventoryMovement(movementData);
    return movement.save({ session });
  }

  static getQuantityChange(transactionType, quantity) {
    const quantityMap = {
      purchase_order: quantity,
      sales_order: -quantity,
      purchase_return: -quantity,
      sales_return: quantity,
    };

    return quantityMap[transactionType] || 0;
  }

  static getEventType(transactionType) {
    const eventMap = {
      purchase_order: "PURCHASE_RECEIVE",
      sales_order: "SALES_DISPATCH",
      purchase_return: "PURCHASE_RETURN",
      sales_return: "SALES_RETURN",
    };

    return eventMap[transactionType];
  }

  static async getStockHistory(itemId, startDate, endDate) {
    return InventoryMovement.getStockHistory(itemId, startDate, endDate);
  }

  static async getStockWithMovements(itemId) {
    const stock = await Stock.findOne({ itemId })
      .populate("category")
      .populate("vendorId");
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

  static async getLowStockItems() {
    return Stock.find({
      $expr: { $lte: ["$currentStock", "$reorderLevel"] },
      status: "Active",
    })
      .populate("category")
      .populate("vendorId")
      .sort({ currentStock: 1 });
  }

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

  static async getAllStock(filters) {
    const query = {};

    if (filters.search) {
      query.$or = [
        { itemId: new RegExp(filters.search, "i") },
        { sku: new RegExp(filters.search, "i") },
        { itemName: new RegExp(filters.search, "i") },
        { batchNumber: new RegExp(filters.search, "i") },
      ];
    }

    if (filters.status) query.status = filters.status;

    if (filters.category) {
      query.category = mongoose.Types.ObjectId(filters.category);
    }

    if (filters.vendorId) {
      query.vendorId = mongoose.Types.ObjectId(filters.vendorId);
    }

    if (filters.lowStock === "true") {
      query.$expr = { $lte: ["$currentStock", "$reorderLevel"] };
    }

    if (filters.minStock)
      query.currentStock = { $gte: Number(filters.minStock) };
    if (filters.maxStock) {
      query.currentStock = {
        ...query.currentStock,
        $lte: Number(filters.maxStock),
      };
    }

    if (filters.minPrice) query.salesPrice = { $gte: Number(filters.minPrice) };
    if (filters.maxPrice) {
      query.salesPrice = {
        ...query.salesPrice,
        $lte: Number(filters.maxPrice),
      };
    }

    return Stock.find(query)
      .populate("category")
      .populate("vendorId")
      .sort({ createdAt: -1 });
  }

  static async getStockById(id) {
    const stock = await Stock.findById(id)
      .populate("category")
      .populate("vendorId")
      .populate("unitOfMeasure");
    if (!stock) throw new AppError("Stock item not found", 404);
    return stock;
  }

  static async getStockByItemId(itemId) {
    const stock = await Stock.findOne({
      _id: itemId,
    })
      .populate("category")
      .populate("vendorId");
    console.log(stock);
    if (!stock) throw new AppError("Stock item not found", 404);
    return stock;
  }

  static async deleteStock(id) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const stock = await Stock.findById(id).session(session);
      if (!stock) throw new AppError("Stock item not found", 404);

      const movements = await InventoryMovement.find({
        stockId: stock.itemId,
      }).session(session);

      // if (movements.length > 0) {
      //   throw new AppError(
      //     "Cannot delete stock item with existing inventory movements",
      //     400
      //   );
      // }

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
}

module.exports = StockService;
