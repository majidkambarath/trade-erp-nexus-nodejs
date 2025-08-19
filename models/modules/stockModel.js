const mongoose = require("mongoose");

const stockSchema = new mongoose.Schema({
  itemId: { type: String, unique: true, required: true },
  sku: { type: String, unique: true, required: true },
  itemName: { type: String, required: true },
  category: { type: String, required: true },
  unitOfMeasure: { type: String, required: true },
  barcodeQrCode: { type: String, sparse: true },
  reorderLevel: { type: Number, default: 0 },
  batchNumber: { type: String, sparse: true },
  expiryDate: { type: Date, sparse: true },
  purchasePrice: { type: Number, default: 0 },
  salesPrice: { type: Number, default: 0 },
  currentStock: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    default: "Active",
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Update the updatedAt field before saving
stockSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Update the updatedAt field before updating
stockSchema.pre("findOneAndUpdate", function (next) {
  this.set({ updatedAt: Date.now() });
  next();
});

module.exports = mongoose.model("Stock", stockSchema);