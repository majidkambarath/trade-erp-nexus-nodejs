const TransactionService = require("../../services/orderPurchase/transactionService");
const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");

// Helper to resolve createdBy consistently
const resolveCreatedBy = (req) =>
  req.user?.id || req.body.createdBy || "system";

// Helper to send paginated results
const sendPaginated = (res, result) => {
  res.status(200).json({
    status: "success",
    results: result.transactions.length,
    pagination: result.pagination,
    data: result.transactions,
  });
};

// ---------- Controllers ----------

// Create new transaction
exports.createTransaction = catchAsync(async (req, res) => {
  const transaction = await TransactionService.createTransaction(
    req.body,
    resolveCreatedBy(req)
  );
  res.status(201).json({ status: "success", data: transaction });
});

// Get all transactions
exports.getAllTransactions = catchAsync(async (req, res) => {
  console.log(req.query);
  const result = await TransactionService.getAllTransactions(req.query);
  sendPaginated(res, result);
});

// Get transaction by ID
exports.getTransactionById = catchAsync(async (req, res) => {
  const transaction = await TransactionService.getTransactionById(
    req.params.id
  );
  res.status(200).json({ status: "success", data: { transaction } });
});

// Update transaction
exports.updateTransaction = catchAsync(async (req, res) => {
  const transaction = await TransactionService.updateTransaction(
    req.params.id,
    req.body,
    resolveCreatedBy(req)
  );
  res.status(200).json({ status: "success", data: { transaction } });
});

// Delete transaction
exports.deleteTransaction = catchAsync(async (req, res) => {
  await TransactionService.deleteTransaction(
    req.params.id,
    resolveCreatedBy(req)
  );
  res.status(204).json({ status: "success", data: null });
});

// Process transaction (approve/confirm/process)
exports.processTransaction = catchAsync(async (req, res) => {
  const { action } = req.body;
  if (!action) throw new AppError("Action is required", 400);

  const transaction = await TransactionService.processTransaction(
    req.params.id,
    action,
    resolveCreatedBy(req)
  );
  res.status(200).json({ status: "success", data: { transaction } });
});

// Get transaction with inventory movements
exports.getTransactionWithMovements = catchAsync(async (req, res) => {
  const result = await TransactionService.getTransactionWithMovements(
    req.params.id
  );
  res.status(200).json({ status: "success", data: result });
});

// Get transaction stats
exports.getTransactionStats = catchAsync(async (req, res) => {
  const stats = await TransactionService.getTransactionStats(req.query);
  res.status(200).json({ status: "success", data: { stats } });
});

// Get pending transactions
exports.getPendingTransactions = catchAsync(async (req, res) => {
  const transactions = await TransactionService.getPendingTransactions();
  res
    .status(200)
    .json({
      status: "success",
      results: transactions.length,
      data: { transactions },
    });
});

// Duplicate transaction
exports.duplicateTransaction = catchAsync(async (req, res) => {
  const transaction = await TransactionService.duplicateTransaction(
    req.params.id,
    resolveCreatedBy(req)
  );
  res.status(201).json({ status: "success", data: { transaction } });
});

// Bulk process transactions
exports.bulkProcessTransactions = catchAsync(async (req, res) => {
  const { transactionIds, action } = req.body;
  if (!transactionIds?.length || !action)
    throw new AppError("Transaction IDs array and action are required", 400);

  const results = await TransactionService.bulkProcessTransactions(
    transactionIds,
    action,
    resolveCreatedBy(req)
  );
  res.status(200).json({
    status: "success",
    data: {
      results,
      summary: {
        total: transactionIds.length,
        successful: results.successful.length,
        failed: results.failed.length,
      },
    },
  });
});

// Generate transaction report
exports.generateTransactionReport = catchAsync(async (req, res) => {
  const report = await TransactionService.generateTransactionReport(req.query);
  res.status(200).json({ status: "success", data: { report } });
});

// Generic get transactions by type
exports.getTransactionsByType = catchAsync(async (req, res) => {
  const filters = { ...req.query, type: req.params.type };
  const result = await TransactionService.getAllTransactions(filters);
  sendPaginated(res, result);
});

// Shorthand routes for types
exports.getPurchaseOrders = (req, res) => {
  req.params.type = "purchase_order";
  return exports.getTransactionsByType(req, res);
};
exports.getSalesOrders = (req, res) => {
  req.params.type = "sales_order";
  return exports.getTransactionsByType(req, res);
};
exports.getPurchaseReturns = (req, res) => {
  req.params.type = "purchase_return";
  return exports.getTransactionsByType(req, res);
};
exports.getSalesReturns = (req, res) => {
  req.params.type = "sales_return";
  return exports.getTransactionsByType(req, res);
};

// Convert quote to sales order
exports.convertQuoteToSalesOrder = catchAsync(async (req, res) => {
  const quote = await TransactionService.getTransactionById(req.params.id);
  if (quote.type !== "quote")
    throw new AppError("Can only convert quotes to sales orders", 400);

  const salesOrder = await TransactionService.createTransaction(
    {
      type: "sales_order",
      partyId: quote.partyId,
      partyType: quote.partyType,
      items: quote.items,
      terms: quote.terms,
      notes: `Converted from quote: ${quote.transactionNo}`,
      quoteRef: quote.transactionNo,
      priority: quote.priority,
    },
    resolveCreatedBy(req)
  );

  res.status(201).json({
    status: "success",
    data: { salesOrder, originalQuote: quote.transactionNo },
  });
});

// Transaction timeline
exports.getTransactionTimeline = catchAsync(async (req, res) => {
  const transaction = await TransactionService.getTransactionById(
    req.params.id
  );
  const { inventoryMovements } =
    await TransactionService.getTransactionWithMovements(req.params.id);

  const timeline = [
    {
      date: transaction.createdAt,
      event: "CREATED",
      description: `Transaction ${transaction.transactionNo} created`,
      user: transaction.createdBy,
      data: { status: "DRAFT" },
    },
    {
      date: transaction.updatedAt,
      event: "UPDATED",
      description: `Transaction status: ${transaction.status}`,
      user: transaction.createdBy,
      data: { status: transaction.status },
    },
    ...inventoryMovements.map((m) => ({
      date: m.date,
      event: "STOCK_MOVEMENT",
      description: m.notes,
      user: m.createdBy,
      data: {
        stockId: m.stockId,
        quantity: m.quantity,
        eventType: m.eventType,
      },
    })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date));

  res.status(200).json({ status: "success", data: { transaction, timeline } });
});

// Cancel transaction
exports.cancelTransaction = catchAsync(async (req, res) => {
  const { reason } = req.body;
  const transaction = await TransactionService.updateTransaction(
    req.params.id,
    {
      status: "CANCELLED",
      notes: `${req.body.notes || ""}\nCancelled: ${
        reason || "No reason provided"
      }`,
    },
    resolveCreatedBy(req)
  );

  res.status(200).json({ status: "success", data: { transaction } });
});

// Reopen cancelled transaction
exports.reopenTransaction = catchAsync(async (req, res) => {
  const transaction = await TransactionService.updateTransaction(
    req.params.id,
    { status: "DRAFT" },
    resolveCreatedBy(req)
  );
  res.status(200).json({ status: "success", data: { transaction } });
});
