const ExpenseTypeService = require("../../services/financial/expenseTypeService");
const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");

exports.createCategory = catchAsync(async (req, res) => {
  const createdBy = req.admin?.id || "system"; // the signed-in person; a body never names its own author
// console.log(req.body)
  const { name, parentCategoryId } = req.body;
  if (typeof name !== "string" || !name.trim()) {
    throw new AppError("Category name is required", 400);
  }

  const category = await ExpenseTypeService.create(
    { name: name.trim(), parentCategoryId },
    createdBy
  );

  res.status(201).json({
    status: "success",
    data: { category },
  });
});

/**
 * GET ALL – Hierarchical tree
 */
exports.getAllCategories = catchAsync(async (req, res) => {
  const result = await ExpenseTypeService.getAll(req.query);

  res.status(200).json({
    status: "success",
    results: result.categories.length,
    pagination: result.pagination,
    data:  result.categories ,
  });
});

/**
 * GET BY ID
 */
exports.getCategoryById = catchAsync(async (req, res) => {
  const category = await ExpenseTypeService.getById(req.params.id);

  res.status(200).json({
    status: "success",
    data: { category },
  });
});

/**
 * UPDATE
 */
exports.updateCategory = catchAsync(async (req, res) => {
  const updatedBy = req.admin?.id || "system"; // the signed-in person; a body never names its own author

  const { name, parentCategoryId } = req.body;
  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    throw new AppError("Category name cannot be empty", 400);
  }

  const category = await ExpenseTypeService.update(
    req.params.id,
    { name: name?.trim(), parentCategoryId },
    updatedBy
  );

  res.status(200).json({
    status: "success",
    data: { category },
  });
});

/**
 * DELETE
 */
exports.deleteCategory = catchAsync(async (req, res) => {
  await ExpenseTypeService.delete(req.params.id);

  res.status(204).json({
    status: "success",
    data: null,
  });
});