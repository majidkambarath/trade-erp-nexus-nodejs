const FinancialService = require("../../services/financial/financialService");
const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");
const { extractFileInfo } = require("../../middleware/upload");

// Create any type of voucher (receipt, payment, journal, contra, expense)
exports.createVoucher = catchAsync(async (req, res) => {
  const createdBy = req.admin?.id || req.body.createdBy || "system";

  // Parse payload if coming from multipart/form-data
  const bodyData = req.body.data ? JSON.parse(req.body.data) : req.body;
 console.log(bodyData)
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
  const voucher = await FinancialService.createVoucher(bodyData, createdBy);

  res.status(201).json({
    status: "success",
    data: voucher,
  });
});

// Get all vouchers with filters and pagination
exports.getAllVouchers = catchAsync(async (req, res) => {
  const result = await FinancialService.getAllVouchers(req.query);
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

  const voucher = await FinancialService.updateVoucher(
    req.params.id,
    bodyData,
    updatedBy
  );

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

  res.status(200).json({
    status: "success",
    data: result,
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
    comments
  );

  res.status(200).json({
    status: "success",
    data: {
      voucher,
    },
  });
});

// Get vouchers by type
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

// Specific voucher type handlers
exports.getReceiptVouchers = catchAsync(async (req, res) => {
  req.params.type = "receipt";
  return exports.getVouchersByType(req, res);
});

exports.getPaymentVouchers = catchAsync(async (req, res) => {
  req.params.type = "payment";
  return exports.getVouchersByType(req, res);
});

exports.getJournalVouchers = catchAsync(async (req, res) => {
  req.params.type = "journal";
  return exports.getVouchersByType(req, res);
});

exports.getContraVouchers = catchAsync(async (req, res) => {
  req.params.type = "contra";
  return exports.getVouchersByType(req, res);
});

exports.getExpenseVouchers = catchAsync(async (req, res) => {
  req.params.type = "expense";
  return exports.getVouchersByType(req, res);
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

// Get financial reports
exports.getFinancialReports = catchAsync(async (req, res) => {
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
        comments
      );
      results.successful.push({
        id,
        voucherNo: voucher.voucherNo,
        status: voucher.status,
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
  const createdBy = req.admin?.id || req.body.createdBy || "system";

  const duplicateData = {
    ...originalVoucher.voucher.toObject(),
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
    createdBy
  );

  res.status(201).json({
    status: "success",
    data: {
      voucher,
      originalVoucherNo: originalVoucher.voucher.voucherNo,
    },
  });
});
