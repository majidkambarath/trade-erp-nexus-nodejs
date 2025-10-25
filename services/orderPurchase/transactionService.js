const mongoose = require("mongoose");
const Transaction = require("../../models/modules/transactionModel");
const StockPurchaseLog = require("../../models/modules/StockPurchaseLog"); // Import StockPurchaseLog model
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
  return `${prefix}${sequence}`;
}

function calculateItems(items, code) {
  return items.map((item) => {
    const lineValue = item.qty * item.price; // Use rate for unit price
    const lineTotal = (
      lineValue +
      (lineValue * (item.vatPercent || 0)) / 100
    ).toFixed(2);
    return { ...item, itemCode: code, lineTotal: +lineTotal };
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
      const {
        type,
        partyId,
        partyType,
        items,
        date,
        deliveryDate,
        terms,
        notes,
        priority,
      } = data;

      if (!type || !partyId || !partyType)
        throw new AppError("Missing required fields", 400);
      if (!items?.length) throw new AppError("Items are required", 400);

      // Validate stock for sales orders & purchase returns
      let code;
      for (const item of items) {
        const stock = await StockService.getStockByItemId(item.itemId);
        code = stock.itemId;
        if (
          (type === "sales_order" || type === "purchase_return") &&
          stock.currentStock < item.qty
        ) {
          throw new AppError(`Insufficient stock for ${item.description}`, 400);
        }
      }

      const processedItems = calculateItems(items, code);
      const totalAmount = processedItems.reduce(
        (sum, i) => sum + i.lineTotal,
        0
      );

      const transactionData = {
        transactionNo: generateTransactionNo(type),
        type,
        partyId,
        partyType: partyType === "vendor" ? "Vendor" : "Customer",
        partyTypeRef: partyType === "vendor" ? "Vendor" : "Customer",
        items: processedItems,
        totalAmount,
        status: "DRAFT",
        createdBy,
        date: date || new Date(),
        deliveryDate: deliveryDate || new Date(),
        terms: terms || "",
        notes: notes || "",
        priority: priority || "Medium",
      };

      const [newTransaction] = await Transaction.create([transactionData], {
        session,
      });

      // Create StockPurchaseLog for purchase orders
      if (type === "purchase_order") {
        const purchaseLogData = {
          transactionNo: newTransaction.transactionNo,
          type: "purchase_order",
          partyId,
          partyType: "Vendor",
          partyTypeRef: "Vendor",
          date: transactionData.date,
          deliveryDate: transactionData.deliveryDate,
          items: processedItems.map((item) => ({
            itemId: item.itemId,
            description: item.description,
            qty: item.qty,
            rate: item.rate,
            vatPercent: item.vatPercent || 0,
            price: item.lineTotal,
            expiryDate: item.expiryDate ? new Date(item.expiryDate) : undefined,
          })),
          terms: transactionData.terms || "",
          notes: transactionData.notes || "",
          priority: transactionData.priority || "Medium",
        };

        await StockPurchaseLog.create([purchaseLogData], { session });
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
        // Recalculate items with updated data
        data.items = calculateItems(data.items, transaction.items[0]?.itemCode);
        data.totalAmount = data.items.reduce((sum, i) => sum + i.lineTotal, 0);
      }

      // Update StockPurchaseLog for purchase orders
      if (transaction.type === "purchase_order" && data.items) {
        const purchaseLog = await StockPurchaseLog.findOne({
          transactionNo: transaction.transactionNo,
        }).session(session);
        if (!purchaseLog) {
          throw new AppError("Purchase log not found", 404);
        }

        purchaseLog.items = data.items.map((item) => ({
          itemId: item.itemId,
          description: item.description,
          qty: item.qty,
          rate: item.rate,
          vatPercent: item.vatPercent || 0,
          price: item.lineTotal,
          expiryDate: item.expiryDate ? new Date(item.expiryDate) : undefined,
        }));
        purchaseLog.totalAmount = data.totalAmount;
        purchaseLog.terms = data.terms || purchaseLog.terms;
        purchaseLog.notes = data.notes || purchaseLog.notes;
        purchaseLog.priority = data.priority || purchaseLog.priority;
        purchaseLog.updatedAt = new Date();

        await purchaseLog.save({ session });
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

      // Delete StockPurchaseLog for purchase orders
      if (transaction.type === "purchase_order") {
        await StockPurchaseLog.deleteOne(
          { transactionNo: transaction.transactionNo },
          { session }
        );
      }

      await Transaction.findByIdAndDelete(id).session(session);
    }
  );

  // Process Transaction (approve/reject/cancel)
  static processTransaction = withTransactionSession(
    async (id, action, createdBy, session) => {
      const transaction = await Transaction.findById(id).session(session);
      if (!transaction) throw new AppError("Transaction not found", 404);

      this.validateAction(transaction.type, action, transaction.status);

      if (action === "approve" && transaction.type === "purchase_order") {
        // Update StockPurchaseLog status
        const purchaseLog = await StockPurchaseLog.findOne({
          transactionNo: transaction.transactionNo,
        }).session(session);
        if (!purchaseLog) {
          throw new AppError("Purchase log not found", 404);
        }
        purchaseLog.status = "APPROVED"; // Requires status field in schema
        await purchaseLog.save({ session });

        // Process stock updates
        await this.processTransactionStock(id, transaction, createdBy, session);
      } else if (action === "reject" && transaction.type === "purchase_order") {
        const purchaseLog = await StockPurchaseLog.findOne({
          transactionNo: transaction.transactionNo,
        }).session(session);
        if (purchaseLog) {
          purchaseLog.status = "REJECTED"; // Requires status field in schema
          await purchaseLog.save({ session });
        }
      } else if (action === "cancel" && transaction.type === "purchase_order") {
        const purchaseLog = await StockPurchaseLog.findOne({
          transactionNo: transaction.transactionNo,
        }).session(session);
        if (purchaseLog) {
          purchaseLog.status = "CANCELLED"; // Requires status field in schema
          await purchaseLog.save({ session });
        }
      }

      this.updateTransactionStatus(transaction, action);

      await transaction.save({ session });
      return transaction;
    }
  );

  // Get all Transactions
  static async getAllTransactions(filters) {
    const query = {};

    if (filters.type) {
      if (Array.isArray(filters.type)) {
        query.type = { $in: filters.type };
      } else {
        query.type = filters.type;
      }
    }

    if (filters.status) query.status = filters.status;
    if (filters.partyId) {
      query.partyId = new mongoose.Types.ObjectId(filters.partyId);
    }
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
      const types = Array.isArray(filters.type) ? filters.type : [filters.type];

      const field = types.some((t) =>
        ["purchase_return", "sales_return"].includes(t)
      )
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
            $gte: new Date(today.getTime() - 7 * 86400000),
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

    const page = parseInt(filters.page) || 1;
    const limit = parseInt(filters.limit) || 20;
    const skip = (page - 1) * limit;

    const transactions = await Transaction.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({ path: "partyId", select: "customerName vendorName" })
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

  // Process Transaction Stock
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

      let newPurchasePrice = stock.purchasePrice;
      let price = item.rate; // Use rate as unit price
      if (type === "purchase_order") {
        const currentValue = stock.purchasePrice * stock.currentStock;
        const newValue = price * item.qty;
        const totalQuantity = stock.currentStock + item.qty;
        newPurchasePrice =
          totalQuantity > 0
            ? (currentValue + newValue) / totalQuantity
            : stock.purchasePrice;
      }

      await stock.constructor.findByIdAndUpdate(
        stock._id,
        {
          currentStock: newStock,
          purchasePrice: +newPurchasePrice.toFixed(2),
          updatedAt: new Date(),
        },
        { session }
      );

      const movement = await this.createInventoryMovement(
        {
          stockId: stock.itemId,
          quantity: quantityChange,
          previousStock: stock.currentStock,
          newStock,
          eventType: this.getEventType(type),
          referenceType: "Transaction",
          referenceId: transactionId,
          referenceNumber: transactionNo,
          unitCost: price,
          totalValue: Math.abs(quantityChange) * price,
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

    return stockUpdates;
  }

  // Reverse Transaction Stock
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
        { currentStock: newStock, updatedAt: new Date() },
        { session }
      );

      const reversalMovement = await this.createInventoryMovement(
        {
          stockId: stock.itemId,
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

    // Update StockPurchaseLog status for reversal
    if (transaction.type === "purchase_order") {
      const purchaseLog = await StockPurchaseLog.findOne({
        transactionNo: transaction.transactionNo,
      }).session(session);
      if (purchaseLog) {
        purchaseLog.status = "REVERSED"; // Requires status field in schema
        await purchaseLog.save({ session });
      }
    }
  }

  // Create Inventory Movement
  static async createInventoryMovement(movementData, session) {
    const movement = new InventoryMovement(movementData);
    return movement.save({ session });
  }

  // Status & Validation
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
    const validActions = ["approve", "reject", "cancel"];
    if (!validActions.includes(action))
      throw new AppError(`Invalid action '${action}'`, 400);
    if (this.isProcessed(status))
      throw new AppError(
        `Transaction already processed with status '${status}'`,
        400
      );
  }

  static updateTransactionStatus(transaction, action) {
    const statusMap = {
      approve: {
        status: "APPROVED",
        grnGenerated: transaction.type === "purchase_order" ? true : undefined,
        invoiceGenerated: transaction.type === "sales_order" ? true : undefined,
        creditNoteIssued:
          transaction.type === "sales_return" ? true : undefined,
      },
      reject: { status: "REJECTED" },
      cancel: { status: "CANCELLED" },
    };

    Object.assign(transaction, statusMap[action] || {});
  }

  static isProcessed(status) {
    return ["APPROVED", "REJECTED", "CANCELLED", "PAID", "PARTIAL"].includes(
      status
    );
  }
}

module.exports = TransactionService;
