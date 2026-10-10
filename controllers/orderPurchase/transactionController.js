const TransactionService = require("../../services/orderPurchase/transactionService");
const CreditControlService = require("../../services/financial/creditControlService");
const AuditService = require("../../services/core/auditService");
const DocumentAuditService = require("../../services/orderPurchase/documentAuditService");
const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");
const roles = require("../../utils/permissions");

// Helper to resolve createdBy consistently
const resolveCreatedBy = (req) =>
  req.admin?.id || req.user?.id || req.body?.createdBy || "system";

// Approval is where a document gets its financial effect, so its audit row carries what that
// effect was - not merely that someone pressed approve.
const PROCESS_ACTION = { approve: "APPROVED", reject: "REJECTED", cancel: "CANCELLED" };
const logProcessed = async (req, transaction, action) => {
  const effects =
    action === "reject"
      ? null
      : await DocumentAuditService.effects(transaction._id, transaction.partyType);
  const effect = effects
    ? ` - ${effects.ledgerEntries} ledger entries, ${effects.stockMovements} stock movements, ${effects.partyLogs} party balance rows`
    : "";
  await AuditService.log({
    req,
    action: `TRANSACTION_${PROCESS_ACTION[action]}`,
    entity: "Transaction",
    entityId: transaction._id,
    summary: `${DocumentAuditService.describe(transaction)} ${PROCESS_ACTION[action].toLowerCase()}${effect}`,
    after: { ...DocumentAuditService.snapshot(transaction), effects },
  });
};

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
  // A document's number is allocated by the number series when it is saved (the order form sends none). A number named in the body is
  // not taken: a person who may add a document must not be able to choose the number of a tax invoice.
  // `isOpening` is the go-live load's flag (it also switches off the plan's monthly document limit), `quoteRef` / `linkedRef` are the
  // links the conversions write: none of them is a field of the order form.
  const { transactionNo: _chosenNumber, isOpening: _opening, quoteRef: _quote, linkedRef: _linked, ...body } = req.body || {};
  const transaction = await TransactionService.createTransaction(
    body,
    resolveCreatedBy(req)
  );
  await AuditService.log({
    req,
    action: "TRANSACTION_CREATED",
    entity: "Transaction",
    entityId: transaction._id,
    summary: `${DocumentAuditService.describe(transaction)} saved as ${transaction.status}`,
    after: DocumentAuditService.snapshot(transaction),
  });
  res.status(201).json({ status: "success", data: transaction });
});

// Get all transactions
exports.getAllTransactions = catchAsync(async (req, res) => {
  // One list serves all four document types, so the route can only ask that SOME of them may be seen. Narrow it to the
  // types this person may: a sales clerk's unfiltered list holds sales documents only, and asking for a type they may
  // not see is refused rather than quietly returning nothing.
  const allowed = roles.viewableTypes(req.admin?.grants);
  const asked = [].concat(req.query.type || []).flatMap((t) => String(t).split(",")).filter(Boolean);
  const refused = asked.filter((t) => !allowed.includes(t));
  if (refused.length) {
    throw new AppError("Your role does not allow you to see these documents.", 403, "PERMISSION_DENIED", { required: [...new Set(refused.map((t) => `${roles.moduleOfType(t)}.view`))], role: req.admin?.role?.key || null });
  }
  const result = await TransactionService.getAllTransactions({ ...req.query, type: asked.length ? asked : allowed });
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
  // Read before the write, so the audit row can show what the edit changed.
  const before = await DocumentAuditService.snapshotOf(req.params.id);
  const transaction = await TransactionService.updateTransaction(
    req.params.id,
    req.body,
    resolveCreatedBy(req)
  );
  await AuditService.log({
    req,
    action: "TRANSACTION_UPDATED",
    entity: "Transaction",
    entityId: transaction._id,
    summary: `${DocumentAuditService.describe(transaction)} edited`,
    before,
    after: DocumentAuditService.snapshot(transaction),
  });
  res.status(200).json({ status: "success", data: transaction });
});

// Delete transaction
exports.deleteTransaction = catchAsync(async (req, res) => {
  const removed = await TransactionService.deleteTransaction(
    req.params.id,
    resolveCreatedBy(req)
  );
  await AuditService.log({
    req,
    action: "TRANSACTION_DELETED",
    entity: "Transaction",
    entityId: req.params.id,
    summary: `${removed.type.replace(/_/g, " ")} ${removed.transactionNo} deleted`,
    before: removed,
  });
  res.status(204).json({ status: "success", data: null });
});

// Process transaction (approve/reject/cancel)
exports.processTransaction = catchAsync(async (req, res) => {
  const { action } = req.body;
  if (!["approve", "reject", "cancel"].includes(action))
    throw new AppError(
      "Invalid action. Use 'approve', 'reject', or 'cancel'",
      400
    );

  // Pressing "approve anyway" on a credit warning is a decision of its own, and not everyone who may approve may make it.
  const acknowledged = req.body?.[CreditControlService.ACK_FIELD] === true;
  if (acknowledged && !roles.can(req.admin?.grants, "sales.creditOverride")) {
    throw new AppError("Your role does not allow you to approve a sale past a customer's credit limit.", 403, "PERMISSION_DENIED", { required: ["sales.creditOverride"], role: req.admin?.role?.key || null });
  }

  const transaction = await TransactionService.processTransaction(
    req.params.id,
    action,
    resolveCreatedBy(req),
    // Each risk warning has its own acknowledgement field, so one cannot acknowledge another.
    { acknowledged, req }
  );
  // The first of two approvals leaves the document where it was: say so, plainly, to the person and in the trail
  if (action === "approve" && transaction.status !== "APPROVED") {
    await AuditService.log({
      req,
      action: "TRANSACTION_FIRST_APPROVAL",
      entity: "Transaction",
      entityId: transaction._id,
      summary: `${DocumentAuditService.describe(transaction)} approved once; a second approver is needed`,
      after: DocumentAuditService.snapshot(transaction),
    });
    return res.status(200).json({ status: "success", data: { transaction, approval: { awaitingSecond: true, given: transaction.approvals?.length || 1 } } });
  }
  await logProcessed(req, transaction, action);
  res.status(200).json({ status: "success", data: { transaction } });
});

// Everything one document did: ledger entries, stock movements, party balance, settlements,
// e-invoice and the activity log behind it.
exports.getTransactionAudit = catchAsync(async (req, res) => {
  const trail = await DocumentAuditService.trail(req.params.id);
  res.status(200).json({ status: "success", data: trail });
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
  res.status(200).json({
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
  await AuditService.log({
    req,
    action: "TRANSACTION_CREATED",
    entity: "Transaction",
    entityId: transaction._id,
    summary: `${DocumentAuditService.describe(transaction)} duplicated from ${req.params.id}`,
    after: DocumentAuditService.snapshot(transaction),
  });
  res.status(201).json({ status: "success", data: { transaction } });
});

// Bulk process transactions
exports.bulkProcessTransactions = catchAsync(async (req, res) => {
  const { transactionIds, action } = req.body;
  if (
    !transactionIds?.length ||
    !["approve", "reject", "cancel"].includes(action)
  )
    throw new AppError(
      "Transaction IDs array and valid action are required",
      400
    );

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
  const transaction = await TransactionService.processTransaction(
    req.params.id,
    "cancel",
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
