const UOM = require("../../models/modules/uomModel");
const UOMConversion = require("../../models/modules/uomConversionModel");
const AppError = require("../../utils/AppError");

// UOM CRUD Operations
exports.createUOM = async (data) => {
  const { unitName, shortCode, type, category, status } = data;
  
  // Check for existing UOM with same name or shortCode
  const existingUOM = await UOM.findOne({
    $or: [
      { unitName: { $regex: new RegExp(`^${unitName}$`, 'i') } },
      { shortCode: { $regex: new RegExp(`^${shortCode}$`, 'i') } }
    ]
  });
  
  if (existingUOM) {
    throw new AppError("UOM with this name or short code already exists", 400);
  }

  const uom = await UOM.create({
    unitName,
    shortCode: shortCode.toLowerCase(),
    type,
    category,
    status,
  });

  return uom;
};

exports.getAllUOMs = async (filters) => {
  const query = {};
  
  // Search functionality
  if (filters.search) {
    query.$or = [
      { unitName: new RegExp(filters.search, "i") },
      { shortCode: new RegExp(filters.search, "i") },
      { category: new RegExp(filters.search, "i") },
    ];
  }
  
  // Filter by status
  if (filters.status) query.status = filters.status;
  
  // Filter by type
  if (filters.type) query.type = filters.type;
  
  // Filter by category
  if (filters.category) query.category = filters.category;

  return UOM.find(query).sort({ createdAt: -1 });
};

exports.getUOMById = async (id) => {
  const uom = await UOM.findById(id);
  if (!uom) throw new AppError("UOM not found", 404);
  return uom;
};

exports.updateUOM = async (id, data) => {
  // Check if updating to existing name/shortCode
  if (data.unitName || data.shortCode) {
    const existingUOM = await UOM.findOne({
      _id: { $ne: id },
      $or: [
        ...(data.unitName ? [{ unitName: { $regex: new RegExp(`^${data.unitName}$`, 'i') } }] : []),
        ...(data.shortCode ? [{ shortCode: { $regex: new RegExp(`^${data.shortCode}$`, 'i') } }] : [])
      ]
    });
    
    if (existingUOM) {
      throw new AppError("UOM with this name or short code already exists", 400);
    }
  }

  if (data.shortCode) {
    data.shortCode = data.shortCode.toLowerCase();
  }

  const uom = await UOM.findByIdAndUpdate(id, data, { 
    new: true, 
    runValidators: true 
  });
  
  if (!uom) throw new AppError("UOM not found", 404);
  return uom;
};

exports.deleteUOM = async (id) => {
  // Check if UOM is used in conversions
  const conversions = await UOMConversion.find({
    $or: [{ fromUOM: id }, { toUOM: id }]
  });
  
  if (conversions.length > 0) {
    throw new AppError("Cannot delete UOM as it's used in conversions", 400);
  }

  const uom = await UOM.findByIdAndDelete(id);
  if (!uom) throw new AppError("UOM not found", 404);
};

// UOM Conversion CRUD Operations
exports.createUOMConversion = async (data) => {
  const { fromUOM, toUOM, conversionRatio, category, status } = data;
  
  // Validate that fromUOM and toUOM are different
  if (fromUOM === toUOM) {
    throw new AppError("From UOM and To UOM cannot be the same", 400);
  }
  
  // Check if both UOMs exist
  const fromUOMExists = await UOM.findById(fromUOM);
  const toUOMExists = await UOM.findById(toUOM);
  
  if (!fromUOMExists) throw new AppError("From UOM not found", 404);
  if (!toUOMExists) throw new AppError("To UOM not found", 404);
  
  // Check for existing conversion
  const existingConversion = await UOMConversion.findOne({
    fromUOM,
    toUOM
  });
  
  if (existingConversion) {
    throw new AppError("Conversion between these UOMs already exists", 400);
  }

  const conversion = await UOMConversion.create({
    fromUOM,
    toUOM,
    conversionRatio,
    category: category || fromUOMExists.category, // Auto-detect from fromUOM if not provided
    status,
  });

  // Populate the conversion with UOM details
  await conversion.populate(['fromUOM', 'toUOM']);
  return conversion;
};

exports.getAllUOMConversions = async (filters) => {
  const query = {};
  
  // Filter by status
  if (filters.status) query.status = filters.status;
  
  // Filter by category
  if (filters.category) query.category = filters.category;

  const conversions = await UOMConversion.find(query)
    .populate(['fromUOM', 'toUOM'])
    .sort({ createdAt: -1 });

// Search functionality (after population)
if (filters.search) {
  return conversions.filter((conversion) =>
    conversion.fromUOM?.unitName?.toLowerCase().includes(filters.search.toLowerCase()) ||
    conversion.toUOM?.unitName?.toLowerCase().includes(filters.search.toLowerCase()) ||
    conversion.category?.toLowerCase().includes(filters.search.toLowerCase())
  );
}

  return conversions;
};

exports.getUOMConversionById = async (id) => {
  const conversion = await UOMConversion.findById(id).populate(['fromUOM', 'toUOM']);
  if (!conversion) throw new AppError("UOM Conversion not found", 404);
  return conversion;
};

exports.updateUOMConversion = async (id, data) => {
  // Validate that fromUOM and toUOM are different if both provided
  if (data.fromUOM && data.toUOM && data.fromUOM === data.toUOM) {
    throw new AppError("From UOM and To UOM cannot be the same", 400);
  }
  
  // Check if updating to existing conversion
  if (data.fromUOM || data.toUOM) {
    const currentConversion = await UOMConversion.findById(id);
    if (!currentConversion) throw new AppError("UOM Conversion not found", 404);
    
    const fromUOM = data.fromUOM || currentConversion.fromUOM;
    const toUOM = data.toUOM || currentConversion.toUOM;
    
    const existingConversion = await UOMConversion.findOne({
      _id: { $ne: id },
      fromUOM,
      toUOM
    });
    
    if (existingConversion) {
      throw new AppError("Conversion between these UOMs already exists", 400);
    }
  }

  const conversion = await UOMConversion.findByIdAndUpdate(id, data, { 
    new: true, 
    runValidators: true 
  }).populate(['fromUOM', 'toUOM']);
  
  if (!conversion) throw new AppError("UOM Conversion not found", 404);
  return conversion;
};

exports.deleteUOMConversion = async (id) => {
  const conversion = await UOMConversion.findByIdAndDelete(id);
  if (!conversion) throw new AppError("UOM Conversion not found", 404);
};

// Utility function to convert units
exports.convertUnits = async (fromUOMId, toUOMId, quantity) => {
  const conversion = await UOMConversion.findOne({
    fromUOM: fromUOMId,
    toUOM: toUOMId,
    status: 'Active'
  });
  
  if (!conversion) {
    throw new AppError("No active conversion found between these units", 404);
  }
  
  return quantity * conversion.conversionRatio;
};