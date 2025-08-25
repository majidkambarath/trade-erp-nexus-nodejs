const StockService = require("../../services/stock/stockService");
const catchAsync = require("../../utils/catchAsync");
const AppError = require("../../utils/AppError");

// Create new stock item
exports.createStock = catchAsync(async (req, res) => {
  const createdBy = req.user?.id || req.body.createdBy || "system";
  const stock = await StockService.createStock(req.body, createdBy);
  
  res.status(201).json({
    status: "success",
    data: {
      stock
    }
  });
});

// Get all stock items with filters
exports.getAllStock = catchAsync(async (req, res) => {
  const stocks = await StockService.getAllStock(req.query);
  
  res.status(200).json({
    status: "success",
    results: stocks.length,
    data: {
      stocks
    }
  });
});

// Get stock item by ID
exports.getStockById = catchAsync(async (req, res) => {
  const stock = await StockService.getStockById(req.params.id);
  
  res.status(200).json({
    status: "success",
    data: {
      stock
    }
  });
});

// Get stock item by itemId
exports.getStockByItemId = catchAsync(async (req, res) => {
  const stock = await StockService.getStockByItemId(req.params.itemId);
  
  res.status(200).json({
    status: "success",
    data: {
      stock
    }
  });
});

// Update stock item
exports.updateStock = catchAsync(async (req, res) => {
  const createdBy = req.user?.id || req.body.createdBy || "system";
  const stock = await StockService.updateStock(req.params.id, req.body, createdBy);
  
  res.status(200).json({
    status: "success",
    data: {
      stock
    }
  });
});

// Delete stock item
exports.deleteStock = catchAsync(async (req, res) => {
  await StockService.deleteStock(req.params.id);
  
  res.status(204).json({
    status: "success",
    data: null
  });
});

// Get stock statistics
exports.getStockStats = catchAsync(async (req, res) => {
  const stats = await StockService.getStockStats();
  
  res.status(200).json({
    status: "success",
    data: {
      stats
    }
  });
});
// Add this to stockController.js
exports.updateStockQuantity = catchAsync(async (req, res) => {
  const { quantity, reason } = req.body;
  const createdBy = req.user?.id || req.body.createdBy || "system";
  const { id } = req.params;

  if (quantity === undefined) {
    throw new AppError("Quantity is required", 400);
  }

  const stock = await StockService.getStockById(id);
  const newQuantity = Number(quantity);

  if (newQuantity < 0) {
    throw new AppError("Stock quantity cannot be negative", 400);
  }

  const updatedStock = await StockService.updateStock(
    id,
    { currentStock: newQuantity },
    createdBy
  );

  res.status(200).json({
    status: "success",
    data: {
      stock: updatedStock,
      adjustment: {
        previous: stock.currentStock,
        new: newQuantity,
        reason: reason || "Manual quantity update",
      },
    },
  });
});
// Get categories with count
exports.getCategoriesWithCount = catchAsync(async (req, res) => {
  const categories = await StockService.getCategoriesWithCount();
  
  res.status(200).json({
    status: "success",
    data: {
      categories
    }
  });
});

// Get stock with movement history
exports.getStockWithMovements = catchAsync(async (req, res) => {
  const result = await StockService.getStockWithMovements(req.params.itemId);
  
  res.status(200).json({
    status: "success",
    data: result
  });
});

// Get stock history
exports.getStockHistory = catchAsync(async (req, res) => {
  const { itemId } = req.params;
  const { startDate, endDate } = req.query;
  
  const history = await StockService.getStockHistory(itemId, startDate, endDate);
  
  res.status(200).json({
    status: "success",
    results: history.length,
    data: {
      history
    }
  });
});

// Get low stock items
exports.getLowStockItems = catchAsync(async (req, res) => {
  const lowStockItems = await StockService.getLowStockItems();
  
  res.status(200).json({
    status: "success",
    results: lowStockItems.length,
    data: {
      lowStockItems
    }
  });
});

// Get stock valuation
exports.getStockValuation = catchAsync(async (req, res) => {
  const valuation = await StockService.getStockValuation();
  
  res.status(200).json({
    status: "success",
    data: {
      valuation: valuation[0] || {
        totalItems: 0,
        totalQuantity: 0,
        totalPurchaseValue: 0,
        totalSalesValue: 0
      }
    }
  });
});

// Bulk update stock quantities
exports.bulkUpdateStock = catchAsync(async (req, res) => {
  const { updates } = req.body; // Array of {id, currentStock}
  const createdBy = req.user?.id || req.body.createdBy || "system";
  
  if (!Array.isArray(updates)) {
    throw new AppError("Updates must be an array", 400);
  }
  
  const results = [];
  const errors = [];
  
  for (const update of updates) {
    try {
      const stock = await StockService.updateStock(update.id, { currentStock: update.currentStock }, createdBy);
      results.push({
        id: update.id,
        success: true,
        stock
      });
    } catch (error) {
      errors.push({
        id: update.id,
        success: false,
        error: error.message
      });
    }
  }
  
  res.status(200).json({
    status: "success",
    data: {
      successful: results,
      failed: errors,
      summary: {
        total: updates.length,
        successful: results.length,
        failed: errors.length
      }
    }
  });
});

// Stock adjustment
exports.stockAdjustment = catchAsync(async (req, res) => {
  const { itemId, adjustmentQuantity, reason } = req.body;
  const createdBy = req.user?.id || req.body.createdBy || "system";
  
  if (!itemId || adjustmentQuantity === undefined) {
    throw new AppError("Item ID and adjustment quantity are required", 400);
  }
  
  const stock = await StockService.getStockByItemId(itemId);
  const newQuantity = stock.currentStock + Number(adjustmentQuantity);
  
  if (newQuantity < 0) {
    throw new AppError("Stock cannot be negative", 400);
  }
  
  const updatedStock = await StockService.updateStock(
    stock._id, 
    { 
      currentStock: newQuantity 
    }, 
    createdBy
  );
  
  res.status(200).json({
    status: "success",
    data: {
      stock: updatedStock,
      adjustment: {
        previous: stock.currentStock,
        adjustment: Number(adjustmentQuantity),
        new: newQuantity,
        reason
      }
    }
  });
});

// Import stock from CSV/Excel
exports.importStock = catchAsync(async (req, res) => {
  const { stockData } = req.body; // Array of stock items
  const createdBy = req.user?.id || req.body.createdBy || "system";
  
  if (!Array.isArray(stockData)) {
    throw new AppError("Stock data must be an array", 400);
  }
  
  const results = [];
  const errors = [];
  
  for (const data of stockData) {
    try {
      const stock = await StockService.createStock(data, createdBy);
      results.push({
        success: true,
        stock,
        itemId: data.itemId || stock.itemId
      });
    } catch (error) {
      errors.push({
        success: false,
        error: error.message,
        data
      });
    }
  }
  
  res.status(200).json({
    status: "success",
    data: {
      successful: results,
      failed: errors,
      summary: {
        total: stockData.length,
        successful: results.length,
        failed: errors.length
      }
    }
  });
});

// Export stock data
exports.exportStock = catchAsync(async (req, res) => {
  const stocks = await StockService.getAllStock(req.query);
  
  const exportData = stocks.map(stock => ({
    ItemID: stock.itemId,
    SKU: stock.sku,
    ItemName: stock.itemName,
    Category: stock.category,
    UnitOfMeasure: stock.unitOfMeasure,
    CurrentStock: stock.currentStock,
    ReorderLevel: stock.reorderLevel,
    PurchasePrice: stock.purchasePrice,
    SalesPrice: stock.salesPrice,
    Status: stock.status,
    BatchNumber: stock.batchNumber,
    ExpiryDate: stock.expiryDate,
    CreatedAt: stock.createdAt
  }));
  
  res.status(200).json({
    status: "success",
    data: {
      stocks: exportData,
      summary: {
        totalItems: stocks.length,
        totalStock: stocks.reduce((sum, s) => sum + s.currentStock, 0),
        totalValue: stocks.reduce((sum, s) => sum + (s.currentStock * s.purchasePrice), 0)
      }
    }
  });
});