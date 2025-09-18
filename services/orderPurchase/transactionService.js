const mongoose = require("mongoose");
const Transaction = require("../../models/modules/transactionModel");
const InventoryMovement = require("../../models/modules/inventoryMovementModel");
const StockService = require("../stock/stockService");
const AppError = require("../../utils/AppError");

// ---------- Helpers ----------
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

function calculateItems(items) {
  return items.map((item) => {
    const lineValue = item.qty * item.rate;
    const tax = lineValue * ((item.taxPercent || 0) / 100);
    return { ...item, lineTotal: lineValue + tax };
  });
}

function withTransactionSession(fn) {
  return async (...args) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const result = await fn(...args, session);
      await session.commitTransaction();
      return result;
    } catch (err) {
      await session.abortTransaction();
      throw err;
    } finally {
      session.endSession();
    }
  };
}

// ---------- Service ----------
class TransactionService {
  // Create Transaction
  static createTransaction = withTransactionSession(
    async (data, createdBy, session) => {
      const { type, partyId, partyType, items, autoProcess, ...rest } = data;

      if (!type || !partyId || !partyType)
        throw new AppError("Missing required fields", 400);
      if (!items?.length) throw new AppError("Items are required", 400);

      // Validate stock for sales orders & purchase returns
      for (const item of items) {
        const stock = await StockService.getStockByItemId(item.itemId);
        if (
          (type === "sales_order" || type === "purchase_return") &&
          stock.currentStock < item.qty
        ) {
          throw new AppError(`Insufficient stock for ${item.description}`, 400);
        }
      }

      const processedItems = calculateItems(items);
      const totalAmount = processedItems.reduce(
        (sum, i) => sum + i.lineTotal,
        0
      );

      let initialStatus = rest.status || "DRAFT";
      if (type.includes("_return") && autoProcess !== false)
        initialStatus = "PROCESSED";

      const transactionData = {
        transactionNo: generateTransactionNo(type),
        type,
        partyId,
        partyType,
        items: processedItems,
        totalAmount,
        status: initialStatus,
        createdBy,
        ...rest,
      };

      const [newTransaction] = await Transaction.create([transactionData], {
        session,
      });

      // Auto-process if returns or requested
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
        newTransaction.status = this.getProcessedStatus(type);
        await newTransaction.save({ session });
      }

      return newTransaction;
    }
  );

  // Update Transaction
  static updateTransaction = withTransactionSession(
    async (id, data, createdBy, session) => {
      const transaction = await Transaction.findById(id).session(session);
      if (!transaction) throw new AppError("Transaction not found", 404);
      if (this.isProcessed(transaction.status))
        throw new AppError("Cannot edit processed transactions", 400);

      if (data.items) {
        data.items = calculateItems(data.items);
        data.totalAmount = data.items.reduce((sum, i) => sum + i.lineTotal, 0);
      }

      Object.assign(transaction, data, { updatedAt: new Date() });
      await transaction.save({ session });
      return transaction;
    }
  );

  // Delete Transaction
  static deleteTransaction = withTransactionSession(
    async (id, createdBy, session) => {
      const transaction = await Transaction.findById(id).session(session);
      if (!transaction) throw new AppError("Transaction not found", 404);

      if (this.isProcessed(transaction.status)) {
        await this.reverseTransactionStock(id, transaction, createdBy, session);
      }

      await Transaction.findByIdAndDelete(id).session(session);
    }
  );

  // Process Transaction (stock changes + status updates)
  static processTransaction = withTransactionSession(
    async (id, action, createdBy, session) => {
      const transaction = await Transaction.findById(id).session(session);
      if (!transaction) throw new AppError("Transaction not found", 404);

      this.validateAction(transaction.type, action, transaction.status);

      await this.processTransactionStock(id, transaction, createdBy, session);
      this.updateTransactionStatus(transaction, action);

      await transaction.save({ session });
      return transaction;
    }
  );

  // Get all Transactions
  static async getAllTransactions(filters) {
    const query = {};
    if (filters.type) query.type = filters.type;
    if (filters.status) query.status = filters.status;
    if (filters.partyId)
      query.partyId = new mongoose.Types.ObjectId(filters.partyId);
    if (filters.partyType) query.partyType = filters.partyType;

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
          query[field] = { $gte: new Date(today.getTime() - 7 * 86400000) };
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

    const page = parseInt(filters.page) || 1;
    const limit = parseInt(filters.limit) || 20;
    const skip = (page - 1) * limit;

    const transactions = await Transaction.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({ path: "partyId", select: "customerName vendorName" }) // auto-handle both
      .lean();

    const transactionsWithPartyName = transactions.map((t) => ({
      ...t,
      partyName:
        t.partyId?.customerName || t.partyId?.vendorName || "Unknown Party",
    }));

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

  // ---------- Stock Handling ----------
  static async processTransactionStock(
    transactionId,
    transaction,
    createdBy,
    session
  ) {
    const { type, items, transactionNo } = transaction;
    const stockUpdates = [];

    for (const item of items) {
      const stock = await StockService.getStockByItemId(item.itemId);
      const quantityChange = this.getQuantityChange(type, item.qty);
      const newStock = stock.currentStock + quantityChange;

      if (quantityChange < 0 && newStock < 0) {
        throw new AppError(`Insufficient stock for ${item.description}`, 400);
      }

      await stock.constructor.findByIdAndUpdate(
        stock._id,
        { currentStock: newStock },
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
        newStock,
        movement,
      });
    }

    return stockUpdates;
  }

  static async reverseTransactionStock(
    transactionId,
    transaction,
    createdBy,
    session
  ) {
    const existingMovements = await InventoryMovement.find({
      referenceId: transactionId,
      referenceType: "Transaction",
      isReversed: false,
    }).session(session);

    for (const movement of existingMovements) {
      const stock = await StockService.getStockByItemId(movement.stockId);
      const reversalQuantity = -movement.quantity;
      const newStock = stock.currentStock + reversalQuantity;

      await stock.constructor.findByIdAndUpdate(
        stock._id,
        { currentStock: newStock },
        { session }
      );

      const reversalMovement = await this.createInventoryMovement(
        {
          stockId: movement.stockId,
          quantity: reversalQuantity,
          previousStock: stock.currentStock,
          newStock,
          eventType: movement.eventType,
          referenceType: "Transaction",
          referenceId: transactionId,
          referenceNumber: `REV-${transaction.transactionNo}`,
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
        { isReversed: true, reversalReference: reversalMovement._id },
        { session }
      );
    }
  }

  static async createInventoryMovement(movementData, session) {
    const movement = new InventoryMovement(movementData);
    return movement.save({ session });
  }

  // ---------- Status & Validation ----------
  static getQuantityChange(type, qty) {
    return (
      {
        purchase_order: qty,
        sales_order: -qty,
        purchase_return: -qty,
        sales_return: qty,
      }[type] || 0
    );
  }

  static getEventType(type) {
    return {
      purchase_order: "PURCHASE_RECEIVE",
      sales_order: "SALES_DISPATCH",
      purchase_return: "PURCHASE_RETURN",
      sales_return: "SALES_RETURN",
    }[type];
  }

  static validateAction(type, action, status) {
    const validActions = {
      purchase_order: ["approve", "reject"],
      sales_order: ["confirm", "cancel"],
      purchase_return: ["process"],
      sales_return: ["process"],
    };

    if (!validActions[type]?.includes(action))
      throw new AppError(`Invalid action '${action}' for type '${type}'`, 400);
    if (this.isProcessed(status))
      throw new AppError(
        `Transaction already processed with status '${status}'`,
        400
      );
  }

  static updateTransactionStatus(transaction, action) {
    const map = {
      purchase_order: {
        approve: { status: "APPROVED", grnGenerated: true },
        reject: { status: "REJECTED" },
      },
      sales_order: {
        confirm: { status: "CONFIRMED", invoiceGenerated: true },
        cancel: { status: "CANCELLED" },
      },
      purchase_return: { process: { status: "PROCESSED" } },
      sales_return: {
        process: { status: "PROCESSED", creditNoteIssued: true },
      },
    };

    Object.assign(transaction, map[transaction.type]?.[action] || {});
  }

  static isProcessed(status) {
    return ["APPROVED", "CONFIRMED", "PROCESSED", "COMPLETED"].includes(status);
  }

  static getProcessedStatus(type) {
    return (
      {
        purchase_order: "APPROVED",
        sales_order: "CONFIRMED",
        purchase_return: "PROCESSED",
        sales_return: "PROCESSED",
      }[type] || "PROCESSED"
    );
  }
}

module.exports = TransactionService;
