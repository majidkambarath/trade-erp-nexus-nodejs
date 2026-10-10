const logger = require("../../utils/logger");
const FinancialService = require("../../services/financial/financialService");
const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");
const { extractFileInfo } = require("../../middleware/upload");
const LedgerService = require("../../services/financial/ledgerService");
const AuditService = require("../../services/core/auditService");
const VoucherAuditService = require("../../services/financial/voucherAuditService");

// Create any type of voucher (receipt, payment, journal, contra, expense)
exports.createVoucher = catchAsync(async (req, res) => {
  const createdBy = req.admin?.id || req.body.createdBy || "system";
  logger.debug(req.body)
  // Parse payload if coming from multipart/form-data
  const bodyData = req.body.data ? JSON.parse(req.body.data) : req.body;
  // Handle uploaded file
  const fileInfo = extractFileInfo(req.file);
  if (fileInfo) {
    bodyData.attachments = [
      {
        fileName: fileInfo.originalName,
        filePath: fileInfo.url,
        fileType: fileInfo.format,
        fileSize: fileInfo.size,
      },
    ];
  }

  // console.log(bodyData);
  // `{ req }` lets the service hold a voucher the person may not post on their own (over their approval limit, or an amount
  // the organisation wants two approvers for): it is saved pending, posts nothing, and waits in the approvals list.
  const voucher = await FinancialService.createVoucher(bodyData, createdBy, undefined, { req });
  const hold = voucher.$locals?.hold || null;
  await AuditService.log({
    req,
    action: "VOUCHER_CREATED",
    entity: "Voucher",
    entityId: voucher._id,
    summary: `${VoucherAuditService.describe(voucher)} saved${hold ? ` and held for approval: ${hold.reason === "limit" ? "over the approval limit of the person who saved it" : "it needs two approvers at this amount"}` : ""}`,
    after: { ...VoucherAuditService.snapshot(voucher), effects: await VoucherAuditService.effects(voucher._id) },
  });

  // (the cheque kept on a held voucher is not for a screen)
  const shown = hold ? FinancialService.shown(voucher) : voucher;
  res.status(201).json({
    status: "success",
    data: shown,
    ...(hold ? { approval: { held: true, reason: hold.reason, amount: hold.amount, limit: hold.limit ?? null, above: hold.above ?? null, message: hold.message } } : {}),
  });
});

// Get all vouchers with filters and pagination
exports.getAllVouchers = catchAsync(async (req, res) => {
  logger.debug("object");
  logger.debug(req.query);
  const result = await FinancialService.getAllVouchers(req.query);
  logger.debug(result.vouchers.length);
  res.status(200).json({
    status: "success",
    results: result.vouchers.length,
    pagination: result.pagination,
    data: result.vouchers,
  });
});

// Get voucher by ID
exports.getVoucherById = catchAsync(async (req, res) => {
  const result = await FinancialService.getVoucherById(req.params.id);

  res.status(200).json({
    status: "success",
    data: result,
  });
});

// Everything one voucher did: its ledger entries, the invoices it settled, its cheque and the
// activity log behind it.
exports.getVoucherAudit = catchAsync(async (req, res) => {
  const trail = await VoucherAuditService.trail(req.params.id);
  res.status(200).json({ status: "success", data: trail });
});

// Update voucher
exports.updateVoucher = catchAsync(async (req, res) => {
  const updatedBy = req.admin?.id || req.body.updatedBy || "system";

  // Parse payload if coming from multipart/form-data
  const bodyData = req.body.data ? JSON.parse(req.body.data) : req.body;

  // Handle uploaded file
  const fileInfo = extractFileInfo(req.file);
  if (fileInfo) {
    bodyData.attachments = [
      {
        fileName: fileInfo.originalName,
        filePath: fileInfo.url,
        fileType: fileInfo.format,
        fileSize: fileInfo.size,
      },
    ];
  }

  // read before the write, so the audit row can show what the edit changed
  const before = await VoucherAuditService.snapshotOf(req.params.id);
  // `{ req }`: changing what an APPROVED voucher posted needs finance.deletePosted and an approval of the new figures
  const voucher = await FinancialService.updateVoucher(
    req.params.id,
    bodyData,
    updatedBy,
    { req }
  );
  await AuditService.log({
    req,
    action: "VOUCHER_UPDATED",
    entity: "Voucher",
    entityId: req.params.id,
    summary: `${VoucherAuditService.describe(voucher)} edited`,
    before,
    after: { ...VoucherAuditService.snapshot(voucher), effects: await VoucherAuditService.effects(req.params.id) },
  });

  res.status(200).json({
    status: "success",
    data: {
      voucher,
    },
  });
});

// Delete/Cancel voucher
exports.deleteVoucher = catchAsync(async (req, res) => {
  const deletedBy = req.admin?.id || "system";
  const result = await FinancialService.deleteVoucher(req.params.id, deletedBy);
  // The voucher is kept with status cancelled, so the log says so rather than 'removed'.
  await AuditService.log({
    req,
    action: "VOUCHER_DELETED",
    entity: "Voucher",
    entityId: req.params.id,
    summary: `${result.removed.voucherType} voucher ${result.removed.voucherNo} deleted (kept as cancelled)`,
    before: result.removed,
  });

  res.status(200).json({
    status: "success",
    data: result,
  });
});

// Get vouchers by type (unified handler)
exports.getVouchersByType = catchAsync(async (req, res) => {
  const { type } = req.params;
  const filters = { ...req.query, voucherType: type };

  const result = await FinancialService.getAllVouchers(filters);

  res.status(200).json({
    status: "success",
    results: result.vouchers.length,
    pagination: result.pagination,
    data: {
      vouchers: result.vouchers,
      type,
    },
  });
});

// Get pending vouchers for approval
exports.getPendingVouchers = catchAsync(async (req, res) => {
  const filters = { ...req.query, status: "pending" };
  const result = await FinancialService.getAllVouchers(filters);

  res.status(200).json({
    status: "success",
    results: result.vouchers.length,
    data: {
      vouchers: result.vouchers,
    },
  });
});

// Approve or reject voucher
exports.processVoucherApproval = catchAsync(async (req, res) => {
  const { action, comments } = req.body;
  const approvedBy = req.admin?.id || req.body.approvedBy || "system";

  if (!action || !["approve", "reject"].includes(action)) {
    throw new AppError("Valid action (approve/reject) is required", 400);
  }

  const voucher = await FinancialService.processVoucherApproval(
    req.params.id,
    action,
    approvedBy,
    comments,
    { req }
  );
  if (voucher.awaitingSecondApproval) {
    await AuditService.log({
      req,
      action: "VOUCHER_FIRST_APPROVAL",
      entity: "Voucher",
      entityId: req.params.id,
      summary: `${VoucherAuditService.describe(voucher)} approved once; a second approver is needed`,
    });
    return res.status(200).json({ status: "success", data: { voucher, approval: { awaitingSecond: true, given: voucher.approvals?.length || 1 } } });
  }
  await AuditService.log({
    req,
    action: action === "approve" ? "VOUCHER_APPROVED" : "VOUCHER_REJECTED",
    entity: "Voucher",
    entityId: req.params.id,
    summary: `${VoucherAuditService.describe(voucher)} ${action === "approve" ? "approved" : "rejected"}${comments ? `: ${comments}` : ""}`,
    after: { ...VoucherAuditService.snapshot(voucher), effects: await VoucherAuditService.effects(req.params.id) },
  });

  res.status(200).json({
    status: "success",
    data: {
      voucher,
    },
  });
});

// Get financial reports
exports.getFinancialReports = catchAsync(async (req, res) => {
  // the statements read the ledger: make sure earlier approved documents have reached it
  await require("../../services/financial/defaultChartService").onOpenThrottled(req);
  const report = await FinancialService.getFinancialReports(req.query);

  res.status(200).json({
    status: "success",
    data: {
      report,
    },
  });
});

// Get dashboard statistics
exports.getDashboardStats = catchAsync(async (req, res) => {
  const stats = await FinancialService.getDashboardStats(req.query);

  res.status(200).json({
    status: "success",
    data: {
      stats,
    },
  });
});

// Bulk operations
exports.bulkProcessVouchers = catchAsync(async (req, res) => {
  const { voucherIds, action, comments } = req.body;
  const processedBy = req.admin?.id || req.body.processedBy || "system";

  if (!voucherIds || !Array.isArray(voucherIds) || !action) {
    throw new AppError("Voucher IDs array and action are required", 400);
  }

  const results = {
    successful: [],
    failed: [],
  };

  for (const id of voucherIds) {
    try {
      const voucher = await FinancialService.processVoucherApproval(
        id,
        action,
        processedBy,
        comments,
        { req }
      );
      results.successful.push({
        id,
        voucherNo: voucher.voucherNo,
        status: voucher.status,
        awaitingSecondApproval: voucher.awaitingSecondApproval === true,
      });
    } catch (error) {
      results.failed.push({
        id,
        error: error.message,
      });
    }
  }

  res.status(200).json({
    status: "success",
    data: {
      results,
      summary: {
        total: voucherIds.length,
        successful: results.successful.length,
        failed: results.failed.length,
      },
    },
  });
});

// Export vouchers to Excel/PDF
exports.exportVouchers = catchAsync(async (req, res) => {
  const { format = "excel", ...filters } = req.query;

  const result = await FinancialService.getAllVouchers(filters);

  const exportData = result.vouchers.map((voucher) => ({
    voucherNo: voucher.voucherNo,
    type: voucher.voucherType,
    date: voucher.date,
    party: voucher.partyName,
    amount: voucher.totalAmount,
    status: voucher.status,
    narration: voucher.narration,
  }));

  res.status(200).json({
    status: "success",
    data: {
      exportData,
      format,
      totalRecords: exportData.length,
    },
  });
});

// Duplicate voucher
exports.duplicateVoucher = catchAsync(async (req, res) => {
  const originalVoucher = await FinancialService.getVoucherById(req.params.id);
  const createdBy = req.admin?.id || "system"; // the signed-in person; a body never names its own author

  const duplicateData = {
    ...originalVoucher.voucher, // getVoucherById returns a lean (plain) object, not a Mongoose document
    _id: undefined,
    voucherNo: undefined,
    status: "draft",
    createdAt: undefined,
    updatedAt: undefined,
    approvedBy: undefined,
    approvedAt: undefined,
  };

  const voucher = await FinancialService.createVoucher(
    duplicateData,
    createdBy,
    undefined,
    { req }
  );

  res.status(201).json({
    status: "success",
    data: {
      voucher,
      originalVoucherNo: originalVoucher.voucher.voucherNo,
    },
  });
});

exports.getAllLedgerEntries = catchAsync(async (req, res) => {
  const filters = {
    voucherType: req.query.voucherType,
    accountId: req.query.accountId,
    partyId: req.query.partyId,
    partyType: req.query.partyType,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
    search: req.query.search,
    page: req.query.page,
    limit: req.query.limit,
    sortBy: req.query.sortBy || "date",
    sortOrder: req.query.sortOrder || "desc",
  };

  const result = await LedgerService.getAllLedgerEntries(filters);

  return res.status(200).json({
    status: "success",
    data: result.ledgerEntries,
    pagination: result.pagination,
  });
});
