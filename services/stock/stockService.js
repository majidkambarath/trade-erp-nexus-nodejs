const Stock = require("../../models/modules/stockModel");
const AppError = require("../../utils/AppError");

exports.createStock = async (data) => {
  const {
    itemId,
    sku,
    itemName,
    category,
    unitOfMeasure,
    barcodeQrCode,
    reorderLevel,
    batchNumber,
    expiryDate,
    purchasePrice,
    salesPrice,
    currentStock,
    status,
  } = data;

  // Generate itemId if not provided
  const newItemId =
    itemId ||
    `ITM${new Date().toISOString().slice(0, 4).replace(/-/g, "")}-${
      Math.floor(Math.random() * 1000) + 100
    }`;

  // Check if SKU already exists
  const existingSku = await Stock.findOne({ sku });
  if (existingSku) {
    throw new AppError("SKU already exists", 400);
  }

  const stock = await Stock.create({
    itemId: newItemId,
    sku,
    itemName,
    category,
    unitOfMeasure,
    barcodeQrCode,
    reorderLevel: Number(reorderLevel) || 0,
    batchNumber,
    expiryDate: expiryDate ? new Date(expiryDate) : undefined,
    purchasePrice: Number(purchasePrice) || 0,
    salesPrice: Number(salesPrice) || 0,
    currentStock: Number(currentStock) || 0,
    status,
  });

  return stock;
};

exports.getAllStock = async (filters) => {
  const query = {};

  // Search functionality
  if (filters.search) {
    query.$or = [
      { itemId: new RegExp(filters.search, "i") },
      { sku: new RegExp(filters.search, "i") },
      { itemName: new RegExp(filters.search, "i") },
      { category: new RegExp(filters.search, "i") },
      { batchNumber: new RegExp(filters.search, "i") },
    ];
  }

  // Filter by status
  if (filters.status) query.status = filters.status;

  // Filter by category
  if (filters.category) query.category = filters.category;

  // Filter by low stock (items where currentStock <= reorderLevel)
  if (filters.lowStock === "true") {
    query.$expr = { $lte: ["$currentStock", "$reorderLevel"] };
  }

  // Filter by stock range
  if (filters.minStock) query.currentStock = { $gte: Number(filters.minStock) };
  if (filters.maxStock) {
    query.currentStock = {
      ...query.currentStock,
      $lte: Number(filters.maxStock),
    };
  }

  // Filter by price range
  if (filters.minPrice) query.salesPrice = { $gte: Number(filters.minPrice) };
  if (filters.maxPrice) {
    query.salesPrice = {
      ...query.salesPrice,
      $lte: Number(filters.maxPrice),
    };
  }

  return Stock.find(query).sort({ createdAt: -1 });
};

exports.getStockById = async (id) => {
  const stock = await Stock.findById(id);
  if (!stock) throw new AppError("Stock item not found", 404);
  return stock;
};

exports.getStockByItemId = async (itemId) => {
  const stock = await Stock.findOne({ itemId });
  if (!stock) throw new AppError("Stock item not found", 404);
  return stock;
};

exports.updateStock = async (id, data) => {
  // If updating SKU, check for duplicates
  if (data.sku) {
    const existingSku = await Stock.findOne({
      sku: data.sku,
      _id: { $ne: id },
    });
    if (existingSku) {
      throw new AppError("SKU already exists", 400);
    }
  }

  // Convert numeric fields
  if (data.reorderLevel) data.reorderLevel = Number(data.reorderLevel);
  if (data.purchasePrice) data.purchasePrice = Number(data.purchasePrice);
  if (data.salesPrice) data.salesPrice = Number(data.salesPrice);
  if (data.currentStock) data.currentStock = Number(data.currentStock);
  if (data.expiryDate) data.expiryDate = new Date(data.expiryDate);

  const stock = await Stock.findByIdAndUpdate(id, data, {
    new: true,
    runValidators: true,
  });

  if (!stock) throw new AppError("Stock item not found", 404);
  return stock;
};

exports.updateStockQuantity = async (id, quantity) => {
  const stock = await Stock.findByIdAndUpdate(
    id,
    {
      currentStock: Number(quantity),
      updatedAt: Date.now(),
    },
    { new: true, runValidators: true }
  );

  if (!stock) throw new AppError("Stock item not found", 404);
  return stock;
};

exports.deleteStock = async (id) => {
  const stock = await Stock.findByIdAndDelete(id);
  if (!stock) throw new AppError("Stock item not found", 404);
};

exports.getStockStats = async () => {
  const stats = await Stock.aggregate([
    {
      $group: {
        _id: null,
        totalItems: { $sum: 1 },
        activeItems: {
          $sum: { $cond: [{ $eq: ["$status", "Active"] }, 1, 0] },
        },
        inactiveItems: {
          $sum: { $cond: [{ $eq: ["$status", "Inactive"] }, 1, 0] },
        },
        lowStockItems: {
          $sum: { $cond: [{ $lte: ["$currentStock", "$reorderLevel"] }, 1, 0] },
        },
        totalStockValue: {
          $sum: { $multiply: ["$currentStock", "$purchasePrice"] },
        },
        totalSalesValue: {
          $sum: { $multiply: ["$currentStock", "$salesPrice"] },
        },
        totalCurrentStock: { $sum: "$currentStock" },
      },
    },
  ]);

  return (
    stats[0] || {
      totalItems: 0,
      activeItems: 0,
      inactiveItems: 0,
      lowStockItems: 0,
      totalStockValue: 0,
      totalSalesValue: 0,
      totalCurrentStock: 0,
    }
  );
};

exports.getCategoriesWithCount = async () => {
  return Stock.aggregate([
    {
      $group: {
        _id: "$category",
        count: { $sum: 1 },
        totalStock: { $sum: "$currentStock" },
        totalValue: {
          $sum: { $multiply: ["$currentStock", "$purchasePrice"] },
        },
      },
    },
    { $sort: { count: -1 } },
  ]);
};
