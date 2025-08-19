const StockService = require("../../services/stock/stockService");
const catchAsync = require("../../utils/catchAsync");

exports.createStock = catchAsync(async (req, res) => {
  const stock = await StockService.createStock(req.body);
  res.status(201).json({
    success: true,
    message: "Stock item created successfully",
    data: stock,
  });
});

exports.getAllStock = catchAsync(async (req, res) => {
  const {
    search,
    status,
    category,
    lowStock,
    minStock,
    maxStock,
    minPrice,
    maxPrice,
  } = req.query;
  
  const stocks = await StockService.getAllStock({
    search,
    status,
    category,
    lowStock,
    minStock,
    maxStock,
    minPrice,
    maxPrice,
  });
  
  res.json({
    success: true,
    count: stocks.length,
    data: stocks,
  });
});

exports.getStockById = catchAsync(async (req, res) => {
  const stock = await StockService.getStockById(req.params.id);
  res.json({
    success: true,
    data: stock,
  });
});

exports.getStockByItemId = catchAsync(async (req, res) => {
  const stock = await StockService.getStockByItemId(req.params.itemId);
  res.json({
    success: true,
    data: stock,
  });
});

exports.updateStock = catchAsync(async (req, res) => {
  const stock = await StockService.updateStock(req.params.id, req.body);
  res.json({
    success: true,
    message: "Stock item updated successfully",
    data: stock,
  });
});

exports.updateStockQuantity = catchAsync(async (req, res) => {
  const { quantity } = req.body;
  const stock = await StockService.updateStockQuantity(req.params.id, quantity);
  res.json({
    success: true,
    message: "Stock quantity updated successfully",
    data: stock,
  });
});

exports.deleteStock = catchAsync(async (req, res) => {
  await StockService.deleteStock(req.params.id);
  res.json({
    success: true,
    message: "Stock item deleted successfully",
  });
});

exports.getStockStats = catchAsync(async (req, res) => {
  const stats = await StockService.getStockStats();
  res.json({
    success: true,
    data: stats,
  });
});

exports.getCategoriesWithCount = catchAsync(async (req, res) => {
  const categories = await StockService.getCategoriesWithCount();
  res.json({
    success: true,
    data: categories,
  });
});