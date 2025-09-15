const Transaction = require("../../models/modules/transactionModel");
const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const StockService = require("../stock/stockService");
const AppError = require("../../utils/AppError");
const mongoose = require("mongoose");
const Vendor = require("../../models/modules/vendorModel");
const Customer = require("../../models/modules/customerModel");

function generateTransactionNo(type) {
  const prefix = {
    purchase_order: "PO",
    sales_order: "SO",
    purchase_return: "PR",
    sales_return: "SR",
  }[type];
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const sequence = String(Math.floor(Math.random() * 999) + 1).padStart(3, "0");
  return `${prefix}-${dateStr}-${sequence}`;
}

class TransactionService {
  static async createTransaction(data, createdBy) {
    const session = await mongoose.startSession();
    session.startTransaction();
    console.log(data)
    try {
      const { type, partyId, partyType, items, autoProcess, ...rest } = data;

      if (!type || !partyId || !partyType) {
        throw new AppError("Missing required fields", 400);
      }

      if (!items || !Array.isArray(items) || items.length === 0) {
        throw new AppError("Items are required", 400);
      }

      // Validate items exist in stock
      for (const item of items) {
        const stock = await StockService.getStockByItemId(item.itemId);

        // For sales orders and purchase returns, check stock availability
        if (
          (type === "sales_order" || type === "purchase_return") &&
          stock.currentStock < item.qty
        ) {
          throw new AppError(
            `Insufficient stock for ${item.description}. Available: ${stock.currentStock}`,
            400
          );
        }
      }

      const transactionNo = generateTransactionNo(type);

      // Calculate lineTotals and totalAmount
      const processedItems = items.map((item) => {
        const lineValue = item.qty * item.rate;
        const tax = lineValue * ((item.taxPercent || 0) / 100);
        return {
          ...item,
          lineTotal: lineValue + tax,
        };
      });

      const totalAmount = processedItems.reduce(
        (sum, item) => sum + item.lineTotal,
        0
      );

      // Set appropriate status based on type
      let initialStatus = rest.status || "DRAFT";

      // Returns are typically processed immediately
      if (type.includes("_return") && autoProcess !== false) {
        initialStatus = "PROCESSED";
      }

      const transactionData = {
        transactionNo,
        type,
        partyId,
        partyType,
        items: processedItems,
        totalAmount,
        status: initialStatus,
        createdBy,
        ...rest,
      };

      const transaction = await Transaction.create([transactionData], {
        session,
      });
      const newTransaction = transaction[0];

      // Auto-process returns or if specifically requested
      if (
        (type.includes("_return") && autoProcess !== false) ||
        autoProcess === true
      ) {
        await this.processTransactionStock(
          newTransaction._id,
          newTransaction,
          createdBy,
          session
        );

        // Update transaction status
        newTransaction.status = this.getProcessedStatus(type);
        await newTransaction.save({ session });
      }

      await session.commitTransaction();
      return newTransaction;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async updateTransaction(id, data, createdBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const transaction = await Transaction.findById(id).session(session);
      if (!transaction) {
        throw new AppError("Transaction not found", 404);
      }

      // Don't allow editing processed transactions
      if (this.isProcessed(transaction.status)) {
        throw new AppError("Cannot edit processed transactions", 400);
      }

      // If items are being updated, recalculate totals
      if (data.items) {
        const processedItems = data.items.map((item) => {
          const lineValue = item.qty * item.rate;
          const tax = lineValue * ((item.taxPercent || 0) / 100);
          return {
            ...item,
            lineTotal: lineValue + tax,
          };
        });

        data.totalAmount = processedItems.reduce(
          (sum, item) => sum + item.lineTotal,
          0
        );
        data.items = processedItems;
      }

      Object.assign(transaction, data);
      transaction.updatedAt = new Date();
      await transaction.save({ session });

      await session.commitTransaction();
      return transaction;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async processTransaction(id, action, createdBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const transaction = await Transaction.findById(id).session(session);
      if (!transaction) {
        throw new AppError("Transaction not found", 404);
      }

      // Validate action based on transaction type
      this.validateAction(transaction.type, action, transaction.status);

      // Process stock changes
      await this.processTransactionStock(id, transaction, createdBy, session);

      // Update transaction status and flags
      this.updateTransactionStatus(transaction, action);
      await transaction.save({ session });

      await session.commitTransaction();
      return transaction;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  static async deleteTransaction(id, createdBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const transaction = await Transaction.findById(id).session(session);
      if (!transaction) {
        throw new AppError("Transaction not found", 404);
      }

      // If transaction was processed, reverse the stock changes
      if (this.isProcessed(transaction.status)) {
        await this.reverseTransactionStock(id, transaction, createdBy, session);
      }

      await Transaction.findByIdAndDelete(id).session(session);

      await session.commitTransaction();
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  // Process transaction stock changes
  static async processTransactionStock(
    transactionId,
    transaction,
    createdBy,
    session = null
  ) {
    const shouldEndSession = !session;
    if (!session) {
      session = await mongoose.startSession();
      session.startTransaction();
    }

    try {
      const { type, items, transactionNo } = transaction;
      const stockUpdates = [];

      for (const item of items) {
        const stock = await StockService.getStockByItemId(item.itemId);

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
        await stock.constructor.findByIdAndUpdate(
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

      if (shouldEndSession) {
        await session.commitTransaction();
      }

      return stockUpdates;
    } catch (error) {
      if (shouldEndSession) {
        await session.abortTransaction();
      }
      throw error;
    } finally {
      if (shouldEndSession) {
        session.endSession();
      }
    }
  }

  // Reverse transaction stock changes
  static async reverseTransactionStock(
    transactionId,
    transaction,
    createdBy,
    session = null
  ) {
    const shouldEndSession = !session;
    if (!session) {
      session = await mongoose.startSession();
      session.startTransaction();
    }

    try {
      const { transactionNo } = transaction;

      // Find existing movements for this transaction
      const existingMovements = await InventoryMovement.find({
        referenceId: transactionId,
        referenceType: "Transaction",
        isReversed: false,
      }).session(session);

      for (const movement of existingMovements) {
        const stock = await StockService.getStockByItemId(movement.stockId);

        // Reverse the quantity
        const reversalQuantity = -movement.quantity;
        const newStock = stock.currentStock + reversalQuantity;

        // Update stock
        await stock.constructor.findByIdAndUpdate(
          stock._id,
          {
            currentStock: newStock,
          },
          { session }
        );

        // Create reversal movement
        const reversalMovement = await this.createInventoryMovement(
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
          {
            isReversed: true,
            reversalReference: reversalMovement._id,
          },
          { session }
        );
      }

      if (shouldEndSession) {
        await session.commitTransaction();
      }
    } catch (error) {
      if (shouldEndSession) {
        await session.abortTransaction();
      }
      throw error;
    } finally {
      if (shouldEndSession) {
        session.endSession();
      }
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
      purchase_order: quantity, // Add stock (items coming in)
      sales_order: -quantity, // Reduce stock (items going out)
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

  // Helper method to validate actions
  static validateAction(transactionType, action, currentStatus) {
    const validActions = {
      purchase_order: ["approve", "reject"],
      sales_order: ["confirm", "cancel"],
      purchase_return: ["process"],
      sales_return: ["process"],
    };

    if (!validActions[transactionType]?.includes(action)) {
      throw new AppError(
        `Invalid action '${action}' for transaction type '${transactionType}'`,
        400
      );
    }

    // Check if already processed
    if (this.isProcessed(currentStatus)) {
      throw new AppError(
        `Transaction is already processed with status '${currentStatus}'`,
        400
      );
    }
  }

  // Helper method to update transaction status
  static updateTransactionStatus(transaction, action) {
    const statusMap = {
      purchase_order: {
        approve: { status: "APPROVED", grnGenerated: true },
        reject: { status: "REJECTED" },
      },
      sales_order: {
        confirm: { status: "CONFIRMED", invoiceGenerated: true },
        cancel: { status: "CANCELLED" },
      },
      purchase_return: {
        process: { status: "PROCESSED" },
      },
      sales_return: {
        process: { status: "PROCESSED", creditNoteIssued: true },
      },
    };

    const updates = statusMap[transaction.type]?.[action];
    if (updates) {
      Object.assign(transaction, updates);
    }
  }

  // Helper method to check if transaction is processed
  static isProcessed(status) {
    return ["APPROVED", "CONFIRMED", "PROCESSED", "COMPLETED"].includes(status);
  }

  // Helper method to get processed status based on type
  static getProcessedStatus(transactionType) {
    const statusMap = {
      purchase_order: "APPROVED",
      sales_order: "CONFIRMED",
      purchase_return: "PROCESSED",
      sales_return: "PROCESSED",
    };
    return statusMap[transactionType] || "PROCESSED";
  }

  // Get all transactions with filters
  static async getAllTransactions(filters) {
    const query = {};

    if (filters.type) query.type = filters.type;
    if (filters.status) query.status = filters.status;
    if (filters.partyId) query.partyId = filters.partyId;

    if (filters.search) {
      query.$or = [
        { transactionNo: new RegExp(filters.search, "i") },
        { notes: new RegExp(filters.search, "i") },
        { createdBy: new RegExp(filters.search, "i") },
        { "items.description": new RegExp(filters.search, "i") },
      ];
    }

    if (filters.dateFilter) {
      const today = new Date();
      const field = ["purchase_return", "sales_return"].includes(filters.type)
        ? "returnDate"
        : "date";

      switch (filters.dateFilter) {
        case "TODAY":
          query[field] = {
            $gte: new Date(today.setHours(0, 0, 0, 0)),
            $lte: new Date(today.setHours(23, 59, 59, 999)),
          };
          break;
        case "WEEK":
          query[field] = {
            $gte: new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000),
          };
          break;
        case "MONTH":
          query[field] = {
            $gte: new Date(today.getFullYear(), today.getMonth(), 1),
          };
          break;
        case "CUSTOM":
          if (filters.startDate && filters.endDate) {
            query[field] = {
              $gte: new Date(filters.startDate),
              $lte: new Date(filters.endDate),
            };
          }
          break;
      }
    }

    // Pagination
    const page = parseInt(filters.page) || 1;
    const limit = parseInt(filters.limit) || 20;
    const skip = (page - 1) * limit;

    // Get transactions first
    const transactions = await Transaction.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(); // Use lean() for better performance

    // Add partyName to each transaction
    const transactionsWithPartyName = await Promise.all(
      transactions.map(async (transaction) => {
        let partyName = "Unknown Party";

        if (transaction.partyId) {
          try {
            if (transaction.partyType === "customer") {
              // const Customer = mongoose.model("Customer");
              const customer = await Customer.findById(
                transaction.partyId
              ).select("customerName");
              if (customer) {
                partyName = customer.customerName;
              }
              console.log(customer);
            } else if (transaction.partyType === "vendor") {
              // const Vendor = mongoose.model("Vendor");
              const vendor = await Vendor.findById(transaction.partyId).select(
                "vendorName"
              );
              if (vendor) {
                partyName = vendor.vendorName;
              }
            }
          } catch (error) {
            console.error("Error fetching party name:", error);
          }
        }

        return {
          ...transaction,
          partyName,
        };
      })
    );

    const total = await Transaction.countDocuments(query);

    return {
      transactions: transactionsWithPartyName,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total,
        limit,
      },
    };
  }

  // Get transaction by ID
  static async getTransactionById(id) {
    const transaction = await Transaction.findById(id).populate(
      "partyId",
      "name email phone address"
    );

    if (!transaction) {
      throw new AppError("Transaction not found", 404);
    }
    return transaction;
  }

  // Get transaction with inventory movements
  static async getTransactionWithMovements(id) {
    const transaction = await this.getTransactionById(id);
    const movements = await InventoryMovement.find({
      referenceId: id,
      referenceType: "Transaction",
    }).sort({ date: -1 });

    return {
      transaction,
      inventoryMovements: movements,
    };
  }

  // Get transaction statistics
  static async getTransactionStats(filters = {}) {
    const matchQuery = {};

    if (filters.dateFrom || filters.dateTo) {
      matchQuery.createdAt = {};
      if (filters.dateFrom)
        matchQuery.createdAt.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) matchQuery.createdAt.$lte = new Date(filters.dateTo);
    }

    const stats = await Transaction.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: null,
          totalTransactions: { $sum: 1 },
          totalValue: { $sum: "$totalAmount" },
          purchaseOrders: {
            $sum: { $cond: [{ $eq: ["$type", "purchase_order"] }, 1, 0] },
          },
          salesOrders: {
            $sum: { $cond: [{ $eq: ["$type", "sales_order"] }, 1, 0] },
          },
          purchaseReturns: {
            $sum: { $cond: [{ $eq: ["$type", "purchase_return"] }, 1, 0] },
          },
          salesReturns: {
            $sum: { $cond: [{ $eq: ["$type", "sales_return"] }, 1, 0] },
          },
          draftTransactions: {
            $sum: { $cond: [{ $eq: ["$status", "DRAFT"] }, 1, 0] },
          },
          processedTransactions: {
            $sum: {
              $cond: [
                { $in: ["$status", ["APPROVED", "CONFIRMED", "PROCESSED"]] },
                1,
                0,
              ],
            },
          },
          avgTransactionValue: { $avg: "$totalAmount" },
        },
      },
    ]);

    // Get monthly trends
    const monthlyStats = await Transaction.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" },
            type: "$type",
          },
          count: { $sum: 1 },
          totalValue: { $sum: "$totalAmount" },
        },
      },
      { $sort: { "_id.year": -1, "_id.month": -1 } },
      { $limit: 12 },
    ]);

    return {
      summary: stats[0] || {
        totalTransactions: 0,
        totalValue: 0,
        purchaseOrders: 0,
        salesOrders: 0,
        purchaseReturns: 0,
        salesReturns: 0,
        draftTransactions: 0,
        processedTransactions: 0,
        avgTransactionValue: 0,
      },
      monthlyTrends: monthlyStats,
    };
  }

  // Get pending transactions that need attention
  static async getPendingTransactions() {
    return Transaction.find({
      status: { $in: ["DRAFT", "PENDING"] },
    })
      .sort({ createdAt: 1 })
      .populate("partyId", "name");
  }

  // Duplicate transaction (useful for recurring orders)
  static async duplicateTransaction(id, createdBy) {
    const originalTransaction = await this.getTransactionById(id);

    const duplicateData = {
      type: originalTransaction.type,
      partyId: originalTransaction.partyId,
      partyType: originalTransaction.partyType,
      items: originalTransaction.items.map((item) => ({
        itemId: item.itemId,
        description: item.description,
        qty: item.qty,
        rate: item.rate,
        taxPercent: item.taxPercent,
      })),
      terms: originalTransaction.terms,
      notes: `Duplicate of ${originalTransaction.transactionNo}`,
      priority: originalTransaction.priority,
    };

    return this.createTransaction(duplicateData, createdBy);
  }

  // Bulk process transactions
  static async bulkProcessTransactions(transactionIds, action, createdBy) {
    const results = {
      successful: [],
      failed: [],
    };

    for (const id of transactionIds) {
      try {
        const transaction = await this.processTransaction(
          id,
          action,
          createdBy
        );
        results.successful.push({
          id,
          transactionNo: transaction.transactionNo,
          status: transaction.status,
        });
      } catch (error) {
        results.failed.push({
          id,
          error: error.message,
        });
      }
    }

    return results;
  }

  // Generate reports
  static async generateTransactionReport(filters = {}) {
    const query = {};

    if (filters.type) query.type = filters.type;
    if (filters.status) query.status = filters.status;
    if (filters.dateFrom || filters.dateTo) {
      query.createdAt = {};
      if (filters.dateFrom) query.createdAt.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) query.createdAt.$lte = new Date(filters.dateTo);
    }

    const transactions = await Transaction.find(query)
      .populate("partyId", "name")
      .sort({ createdAt: -1 });

    const summary = {
      totalTransactions: transactions.length,
      totalValue: transactions.reduce((sum, t) => sum + t.totalAmount, 0),
      byType: {},
      byStatus: {},
    };

    transactions.forEach((t) => {
      summary.byType[t.type] = (summary.byType[t.type] || 0) + 1;
      summary.byStatus[t.status] = (summary.byStatus[t.status] || 0) + 1;
    });

    return {
      summary,
      transactions: transactions.map((t) => ({
        transactionNo: t.transactionNo,
        type: t.type,
        party: t.partyId?.name || "Unknown",
        date: t.date,
        status: t.status,
        totalAmount: t.totalAmount,
        itemCount: t.items.length,
      })),
    };
  }

  // Convert purchase order to goods received note
  static async convertPOToGRN(id, receivedItems, createdBy) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const po = await Transaction.findById(id).session(session);
      if (!po || po.type !== "purchase_order") {
        throw new AppError("Purchase order not found", 404);
      }

      if (po.status !== "APPROVED") {
        throw new AppError("Purchase order must be approved first", 400);
      }

      // Validate received items
      const receivedItemsMap = new Map();
      receivedItems.forEach((item) => {
        receivedItemsMap.set(item.itemId, item.receivedQty);
      });

      // Process stock updates for received quantities
      for (const item of po.items) {
        const receivedQty = receivedItemsMap.get(item.itemId) || 0;

        if (receivedQty > 0) {
          const stock = await StockService.getStockByItemId(item.itemId);
          const newStock = stock.currentStock + receivedQty;

          // Update stock
          await stock.constructor.findByIdAndUpdate(
            stock._id,
            {
              currentStock: newStock,
            },
            { session }
          );

          // Create inventory movement
          await this.createInventoryMovement(
            {
              stockId: item.itemId,
              quantity: receivedQty,
              previousStock: stock.currentStock,
              newStock: newStock,
              eventType: "PURCHASE_RECEIVE",
              referenceType: "Transaction",
              referenceId: po._id,
              referenceNumber: `GRN-${po.transactionNo}`,
              unitCost: item.rate,
              totalValue: receivedQty * item.rate,
              notes: `GRN for PO ${po.transactionNo} - ${item.description}`,
              createdBy,
              batchNumber: stock.batchNumber,
              expiryDate: stock.expiryDate,
            },
            session
          );
        }
      }

      // Update PO status
      po.grnGenerated = true;
      po.status = "COMPLETED";
      await po.save({ session });

      await session.commitTransaction();
      return po;
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  // Get transactions by party (customer/vendor)
  static async getTransactionsByParty(partyId, filters = {}) {
    const query = { partyId };

    if (filters.type) query.type = filters.type;
    if (filters.status) query.status = filters.status;
    if (filters.dateFrom || filters.dateTo) {
      query.createdAt = {};
      if (filters.dateFrom) query.createdAt.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) query.createdAt.$lte = new Date(filters.dateTo);
    }

    return Transaction.find(query)
      .sort({ createdAt: -1 })
      .populate("partyId", "name email phone");
  }

  // Get overdue transactions
  static async getOverdueTransactions() {
    const today = new Date();

    return Transaction.find({
      status: { $in: ["DRAFT", "APPROVED", "CONFIRMED"] },
      $or: [
        {
          deliveryDate: { $lt: today },
          type: { $in: ["purchase_order", "sales_order"] },
        },
        {
          expectedDispatch: { $lt: today },
          type: "sales_order",
        },
      ],
    })
      .sort({ deliveryDate: 1, expectedDispatch: 1 })
      .populate("partyId", "name");
  }

  // Calculate transaction profitability (for sales)
  static async calculateTransactionProfit(id) {
    const transaction = await this.getTransactionById(id);

    if (!["sales_order", "sales_return"].includes(transaction.type)) {
      throw new AppError(
        "Profit calculation only available for sales transactions",
        400
      );
    }

    let totalCost = 0;
    let totalRevenue = transaction.totalAmount;

    for (const item of transaction.items) {
      const stock = await StockService.getStockByItemId(item.itemId);
      const itemCost = stock.purchasePrice * item.qty;
      totalCost += itemCost;
    }

    const profit = totalRevenue - totalCost;
    const profitMargin = totalRevenue > 0 ? (profit / totalRevenue) * 100 : 0;

    return {
      transactionNo: transaction.transactionNo,
      totalRevenue,
      totalCost,
      profit,
      profitMargin: Math.round(profitMargin * 100) / 100,
    };
  }

  // Get stock requirements based on pending sales orders
  static async getStockRequirements() {
    const pendingSalesOrders = await Transaction.find({
      type: "sales_order",
      status: { $in: ["DRAFT", "CONFIRMED"] },
    });

    const requirements = new Map();

    for (const order of pendingSalesOrders) {
      for (const item of order.items) {
        const existing = requirements.get(item.itemId) || {
          itemId: item.itemId,
          description: item.description,
          totalRequired: 0,
          orders: [],
        };

        existing.totalRequired += item.qty;
        existing.orders.push({
          transactionNo: order.transactionNo,
          qty: item.qty,
          deliveryDate: order.deliveryDate,
        });

        requirements.set(item.itemId, existing);
      }
    }

    // Check against current stock
    const requirementsArray = Array.from(requirements.values());

    for (const req of requirementsArray) {
      try {
        const stock = await StockService.getStockByItemId(req.itemId);
        req.currentStock = stock.currentStock;
        req.shortfall = Math.max(0, req.totalRequired - stock.currentStock);
      } catch (error) {
        req.currentStock = 0;
        req.shortfall = req.totalRequired;
        req.error = "Stock item not found";
      }
    }

    return requirementsArray.filter((req) => req.shortfall > 0);
  }
}

module.exports = TransactionService;
