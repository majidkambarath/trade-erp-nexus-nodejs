const logger = require("../../utils/logger");
const TransactorService = require("../../services/financial/TransactorService");
const catchAsync = require("../../utils/catchAsync");

exports.createTransactor = catchAsync(async (req, res) => {
  const createdBy = req.admin?.id || req.body.createdBy || "system";
  logger.debug(req.body)
  const transactor = await TransactorService.createTransactor(req.body, createdBy);

  res.status(201).json({
    status: "success",
    data: transactor,
  });
});

exports.getAllTransactors = catchAsync(async (req, res) => {
  const result = await TransactorService.getAllTransactors(req.query);
logger.debug(result.transactors)
  res.status(200).json({
    status: "success",
    results: result.transactors.length,
    pagination: result.pagination,
    data: result.transactors,
  });
});

exports.getTransactorById = catchAsync(async (req, res) => {
  const transactor = await TransactorService.getTransactorById(req.params.id);

  res.status(200).json({
    status: "success",
    data: transactor,
  });
});

exports.updateTransactor = catchAsync(async (req, res) => {
  const updatedBy = req.admin?.id || req.body.updatedBy || "system";
  logger.debug(req.body)
  logger.debug(req.params.id)
  const transactor = await TransactorService.updateTransactor(req.params.id, req.body, updatedBy);

  res.status(200).json({
    status: "success",
    data: transactor,
  });
});

exports.deleteTransactor = catchAsync(async (req, res) => {
  const deletedBy = req.admin?.id || "system";
  const result = await TransactorService.deleteTransactor(req.params.id, deletedBy);

  res.status(200).json({
    status: "success",
    data: result,
  });
});

module.exports = exports;