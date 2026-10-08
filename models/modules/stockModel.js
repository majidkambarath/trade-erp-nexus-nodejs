const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

const stockSchema = new mongoose.Schema({
  companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  itemId: { type: String, required: true }, // unique within an organisation: see below
  sku: { type: String, required: true }, // unique within an organisation: see below
  itemName: { type: String, required: true },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Category",
    required: [true, "Category is required"],
  },
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Vendor",
    required: false,
    default:null,
    set: v => (v === "" ? null : v),
  },
  unitOfMeasure: { type: mongoose.Schema.Types.ObjectId, ref: "UOM" },
  barcodeQrCode: { type: String },
  origin: { type: String },
  brand: { type: String },
  reorderLevel: { type: Number, default: 0 },
  batchNumber: { type: String, sparse: true },
  expiryDate: { type: Date, sparse: true },
  purchasePrice: { type: Number, default: 0 },
  salesPrice: { type: Number, default: 0 },
  currentStock: { type: Number, default: 0 },
  // Total cost of the units on hand. purchasePrice is the weighted-average unit cost
  // (costValue / currentStock). null = not yet established: seeded from
  // currentStock x purchasePrice the first time the item moves.
  costValue: { type: Number, default: null },
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

stockSchema.index({ itemId: 1 }, { unique: true }); // unique within an organisation
stockSchema.index({ sku: 1 }, { unique: true }); // unique within an organisation

// Scope every query and write to the organisation in scope, and make every declared index per-organisation.
stockSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.model("Stock", stockSchema);
