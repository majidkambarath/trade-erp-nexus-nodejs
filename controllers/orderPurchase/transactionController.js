const TransactionService = require("../../services/orderPurchase/transactionService");
const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");

// Create new transaction
exports.createTransaction = catchAsync(async (req, res) => {
  const createdBy = req.user?.id || req.body.createdBy || "system";
  const transaction = await TransactionService.createTransaction(req.body, createdBy);
  
  res.status(201).json({
    status: "success",
    data: {
      transaction
    }
  });
});

// Get all transactions with filters and pagination
exports.getAllTransactions = catchAsync(async (req, res) => {
  const result = await TransactionService.getAllTransactions(req.query);
  
  res.status(200).json({
    status: "success",
    results: result.transactions.length,
    pagination: result.pagination,
    data: result.transactions
  });
});

// Get transaction by ID
exports.getTransactionById = catchAsync(async (req, res) => {
  const transaction = await TransactionService.getTransactionById(req.params.id);
  
  res.status(200).json({
    status: "success",
    data: {
      transaction
    }
  });
});

// Update transaction
exports.updateTransaction = catchAsync(async (req, res) => {
  const createdBy = req.user?.id || req.body.createdBy || "system";
  const transaction = await TransactionService.updateTransaction(req.params.id, req.body, createdBy);
  
  res.status(200).json({
    status: "success",
    data: {
      transaction
    }
  });
});

// Delete transaction
exports.deleteTransaction = catchAsync(async (req, res) => {
  const createdBy = req.user?.id || "system";
  await TransactionService.deleteTransaction(req.params.id, createdBy);
  
  res.status(204).json({
    status: "success",
    data: null
  });
});

// Process transaction (approve PO, confirm SO, process returns)
exports.processTransaction = catchAsync(async (req, res) => {
  const { action } = req.body;
  const createdBy = req.user?.id || req.body.createdBy || "system";
  
  if (!action) {
    throw new AppError("Action is required", 400);
  }
  
  const transaction = await TransactionService.processTransaction(req.params.id, action, createdBy);
  
  res.status(200).json({
    status: "success",
    data: {
      transaction
    }
  });
});

// Get transaction with inventory movements
exports.getTransactionWithMovements = catchAsync(async (req, res) => {
  const result = await TransactionService.getTransactionWithMovements(req.params.id);
  
  res.status(200).json({
    status: "success",
    data: result
  });
});

// Get transaction statistics
exports.getTransactionStats = catchAsync(async (req, res) => {
  const stats = await TransactionService.getTransactionStats(req.query);
  
  res.status(200).json({
    status: "success",
    data: {
      stats
    }
  });
});

// Get pending transactions
exports.getPendingTransactions = catchAsync(async (req, res) => {
  const transactions = await TransactionService.getPendingTransactions();
  
  res.status(200).json({
    status: "success",
    results: transactions.length,
    data: {
      transactions
    }
  });
});

// Duplicate transaction
exports.duplicateTransaction = catchAsync(async (req, res) => {
  const createdBy = req.user?.id || req.body.createdBy || "system";
  const transaction = await TransactionService.duplicateTransaction(req.params.id, createdBy);
  
  res.status(201).json({
    status: "success",
    data: {
      transaction
    }
  });
});

// Bulk process transactions
exports.bulkProcessTransactions = catchAsync(async (req, res) => {
  const { transactionIds, action } = req.body;
  const createdBy = req.user?.id || req.body.createdBy || "system";
  
  if (!transactionIds || !Array.isArray(transactionIds) || !action) {
    throw new AppError("Transaction IDs array and action are required", 400);
  }
  
  const results = await TransactionService.bulkProcessTransactions(transactionIds, action, createdBy);
  
  res.status(200).json({
    status: "success",
    data: {
      results,
      summary: {
        total: transactionIds.length,
        successful: results.successful.length,
        failed: results.failed.length
      }
    }
  });
});

// Generate transaction report
exports.generateTransactionReport = catchAsync(async (req, res) => {
  const report = await TransactionService.generateTransactionReport(req.query);
  
  res.status(200).json({
    status: "success",
    data: {
      report
    }
  });
});

// Get transactions by type
exports.getTransactionsByType = catchAsync(async (req, res) => {
  const { type } = req.params;
  const filters = { ...req.query, type };
  
  const result = await TransactionService.getAllTransactions(filters);
  
  res.status(200).json({
    status: "success",
    results: result.transactions.length,
    pagination: result.pagination,
    data: {
      transactions: result.transactions,
      type
    }
  });
});

// Get purchase orders
exports.getPurchaseOrders = catchAsync(async (req, res) => {
  req.params.type = 'purchase_order';
  return exports.getTransactionsByType(req, res);
});

// Get sales orders
exports.getSalesOrders = catchAsync(async (req, res) => {
  req.params.type = 'sales_order';
  return exports.getTransactionsByType(req, res);
});

// Get purchase returns
exports.getPurchaseReturns = catchAsync(async (req, res) => {
  req.params.type = 'purchase_return';
  return exports.getTransactionsByType(req, res);
});

// Get sales returns
exports.getSalesReturns = catchAsync(async (req, res) => {
  req.params.type = 'sales_return';
  return exports.getTransactionsByType(req, res);
});

// Convert quote to sales order
exports.convertQuoteToSalesOrder = catchAsync(async (req, res) => {
  const quote = await TransactionService.getTransactionById(req.params.id);
  
  if (quote.type !== 'quote') {
    throw new AppError("Can only convert quotes to sales orders", 400);
  }
  
  const createdBy = req.user?.id || req.body.createdBy || "system";
  
  const salesOrderData = {
    type: 'sales_order',
    partyId: quote.partyId,
    partyType: quote.partyType,
    items: quote.items,
    terms: quote.terms,
    notes: `Converted from quote: ${quote.transactionNo}`,
    quoteRef: quote.transactionNo,
    priority: quote.priority
  };
  
  const salesOrder = await TransactionService.createTransaction(salesOrderData, createdBy);
  
  res.status(201).json({
    status: "success",
    data: {
      salesOrder,
      originalQuote: quote.transactionNo
    }
  });
});

// Get transaction timeline/audit trail
exports.getTransactionTimeline = catchAsync(async (req, res) => {
  const transaction = await TransactionService.getTransactionById(req.params.id);
  const result = await TransactionService.getTransactionWithMovements(req.params.id);
  
  // Combine transaction updates with inventory movements for timeline
  const timeline = [
    {
      date: transaction.createdAt,
      event: 'CREATED',
      description: `Transaction ${transaction.transactionNo} created`,
      user: transaction.createdBy,
      data: { status: 'DRAFT' }
    },
    {
      date: transaction.updatedAt,
      event: 'UPDATED',
      description: `Transaction status: ${transaction.status}`,
      user: transaction.createdBy,
      data: { status: transaction.status }
    }
  ];
  
  // Add inventory movements to timeline
  result.inventoryMovements.forEach(movement => {
    timeline.push({
      date: movement.date,
      event: 'STOCK_MOVEMENT',
      description: movement.notes,
      user: movement.createdBy,
      data: {
        stockId: movement.stockId,
        quantity: movement.quantity,
        eventType: movement.eventType
      }
    });
  });
  
  // Sort timeline by date
  timeline.sort((a, b) => new Date(a.date) - new Date(b.date));
  
  res.status(200).json({
    status: "success",
    data: {
      transaction,
      timeline
    }
  });
});

// Cancel transaction
exports.cancelTransaction = catchAsync(async (req, res) => {
  const { reason } = req.body;
  const createdBy = req.user?.id || req.body.createdBy || "system";
  
  const transaction = await TransactionService.updateTransaction(
    req.params.id,
    { 
      status: 'CANCELLED',
      notes: `${transaction.notes || ''}\nCancelled: ${reason || 'No reason provided'}`
    },
    createdBy
  );
  
  res.status(200).json({
    status: "success",
    data: {
      transaction
    }
  });
});

// Reopen cancelled transaction
exports.reopenTransaction = catchAsync(async (req, res) => {
  const createdBy = req.user?.id || req.body.createdBy || "system";
  
  const transaction = await TransactionService.updateTransaction(
    req.params.id,
    { status: 'DRAFT' },
    createdBy
  );
  
  res.status(200).json({
    status: "success",
    data: {
      transaction
    }
  });
});