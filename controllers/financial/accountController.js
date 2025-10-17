const AccountService = require("../../services/financial/accountService");
const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");
const { extractFileInfo } = require("../../middleware/upload");

exports.createAccountVoucher = catchAsync(async (req, res) => {
  const createdBy = req.admin?.id || req.body.createdBy || "system";
  const bodyData = req.body.data ? JSON.parse(req.body.data) : req.body;
  console.log(bodyData);

  if (bodyData.invoiceBalances && Array.isArray(bodyData.invoiceBalances)) {
    bodyData.invoiceIds = bodyData.invoiceBalances.map((inv) => inv.invoiceId);
  }

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

  const result = await AccountService.createAccountVoucher(bodyData, createdBy);

  res.status(201).json({
    status: "success",
    message: "Payment voucher created successfully",
    data: result,
  });
});

exports.getAllAccountVouchers = catchAsync(async (req, res) => {
  const result = await AccountService.getAllAccountVouchers(req.query);
  res.status(200).json({
    status: "success",
    results: result.vouchers.length,
    pagination: result.pagination,
    data: result.vouchers,
  });
});

exports.getAccountVoucherById = catchAsync(async (req, res) => {
  const result = await AccountService.getAccountVoucherById(req.params.id);
  res.status(200).json({
    status: "success",
    data: result,
  });
});

exports.updateAccountVoucher = catchAsync(async (req, res) => {
  const updatedBy = req.admin?.id || req.body.updatedBy || "system";
  const bodyData = req.body.data ? JSON.parse(req.body.data) : req.body;

  if (bodyData.invoiceBalances && Array.isArray(bodyData.invoiceBalances)) {
    bodyData.invoiceIds = bodyData.invoiceBalances.map((inv) => inv.invoiceId);
  }

  const fileInfo = extractFileInfo(req.file);
  if (fileInfo) {
    bodyData.attachments = bodyData.attachments || [];
    bodyData.attachments.push({
      fileName: fileInfo.originalName,
      filePath: fileInfo.url,
      fileType: fileInfo.format,
      fileSize: fileInfo.size,
    });
  }

  const result = await AccountService.updateAccountVoucher(
    req.params.id,
    bodyData,
    updatedBy
  );

  res.status(200).json({
    status: "success",
    message: "Voucher updated successfully",
    data: result,
  });
});

exports.deleteAccountVoucher = catchAsync(async (req, res) => {
  const deletedBy = req.admin?.id || "system";
  const result = await AccountService.deleteAccountVoucher(
    req.params.id,
    deletedBy
  );

  res.status(200).json({
    status: "success",
    data: result,
  });
});

exports.processAccountVoucherApproval = catchAsync(async (req, res) => {
  const { action, comments } = req.body;
  const approvedBy = req.admin?.id || req.body.approvedBy || "system";

  if (!action || !["approve", "reject"].includes(action)) {
    throw new AppError("Valid action (approve/reject) is required", 400);
  }

  const result = await AccountService.processAccountVoucherApproval(
    req.params.id,
    action,
    approvedBy,
    comments
  );

  res.status(200).json({
    status: "success",
    data: result,
  });
});

exports.getPendingAccountVouchers = catchAsync(async (req, res) => {
  const filters = { ...req.query, status: "pending" };
  const result = await AccountService.getAllAccountVouchers(filters);

  res.status(200).json({
    status: "success",
    results: result.vouchers.length,
    data: { vouchers: result.vouchers },
  });
});

exports.exportAccountVouchers = catchAsync(async (req, res) => {
  const { format = "excel", ...filters } = req.query;
  const result = await AccountService.getAllAccountVouchers(filters);

  const exportData = result.vouchers.map((v) => ({
    voucherNo: v.voucherNo,
    type: v.voucherType,
    date: v.date,
    party: v.partyName,
    amount: v.totalAmount,
    status: v.status,
    narration: v.narration,
  }));

  res.status(200).json({
    status: "success",
    data: { exportData, format, totalRecords: exportData.length },
  });
});

exports.getAccountVouchersByType = catchAsync(async (req, res) => {
  const { type } = req.params;
  if (!["purchase", "sale"].includes(type)) {
    throw new AppError(
      "Invalid voucher type. Must be 'purchase' or 'sale'",
      400
    );
  }

  const result = await AccountService.getAllAccountVouchers({
    ...req.query,
    voucherType: type,
  });

  res.status(200).json({
    status: "success",
    results: result.vouchers.length,
    pagination: result.pagination,
    data: { vouchers: result.vouchers, type },
  });
});
