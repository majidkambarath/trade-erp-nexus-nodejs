const ExpenseTypeService = require("../../services/financial/expenseTypeService");
const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");

exports.createExpenseType = catchAsync(async (req, res) => {
  const createdBy = req.user?.id || req.body.createdBy || "system";
  const expenseType = await ExpenseTypeService.createExpenseType(req.body, createdBy);

  res.status(201).json({
    status: "success",
    data: {
      expenseType,
    },
  });
});

exports.getAllExpenseTypes = catchAsync(async (req, res) => {
  const { expenseTypes, totalPages } = await ExpenseTypeService.getAllExpenseTypes(req.query);

  res.status(200).json({
    status: "success",
    results: expenseTypes.length,
    totalPages,
    data: {
      expenseTypes,
    },
  });
});

exports.getExpenseTypeById = catchAsync(async (req, res) => {
  const expenseType = await ExpenseTypeService.getExpenseTypeById(req.params.id);

  res.status(200).json({
    status: "success",
    data: {
      expenseType,
    },
  });
});

exports.updateExpenseType = catchAsync(async (req, res) => {
  const createdBy = req.user?.id || req.body.createdBy || "system";
  const expenseType = await ExpenseTypeService.updateExpenseType(req.params.id, req.body, createdBy);

  res.status(200).json({
    status: "success",
    data: {
      expenseType,
    },
  });
});

exports.deleteExpenseType = catchAsync(async (req, res) => {
  await ExpenseTypeService.deleteExpenseType(req.params.id);

  res.status(204).json({
    status: "success",
    data: null,
  });
});