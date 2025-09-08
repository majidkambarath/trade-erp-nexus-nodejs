const CategoryService = require("../../services/stock/categoryService");
const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");

exports.createCategory = catchAsync(async (req, res) => {
  const createdBy = req.user?.id || req.body.createdBy || "system";
  const category = await CategoryService.createCategory(req.body, createdBy);

  res.status(201).json({
    status: "success",
    data: {
      category,
    },
  });
});

exports.getAllCategories = catchAsync(async (req, res) => {
  const { categories, totalPages } = await CategoryService.getAllCategories(req.query);

  res.status(200).json({
    status: "success",
    results: categories.length,
    totalPages,
    data: {
      categories,
    },
  });
});

exports.getCategoryById = catchAsync(async (req, res) => {
  const category = await CategoryService.getCategoryById(req.params.id);

  res.status(200).json({
    status: "success",
    data: {
      category,
    },
  });
});

exports.updateCategory = catchAsync(async (req, res) => {
  const createdBy = req.user?.id || req.body.createdBy || "system";
  const category = await CategoryService.updateCategory(req.params.id, req.body, createdBy);

  res.status(200).json({
    status: "success",
    data: {
      category,
    },
  });
});

exports.deleteCategory = catchAsync(async (req, res) => {
  await CategoryService.deleteCategory(req.params.id);

  res.status(204).json({
    status: "success",
    data: null,
  });
});

exports.getCategoryStats = catchAsync(async (req, res) => {
  const stats = await CategoryService.getCategoryStats();

  res.status(200).json({
    status: "success",
    data: {
      stats,
    },
  });
});