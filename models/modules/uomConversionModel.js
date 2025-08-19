const mongoose = require("mongoose");

const uomConversionSchema = new mongoose.Schema({
  fromUOM: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'UOM', 
    required: true 
  },
  toUOM: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'UOM', 
    required: true 
  },
  conversionRatio: { 
    type: Number, 
    required: true,
    min: 0.001 
  },
  category: { 
    type: String, 
    enum: ["Weight", "Volume", "Quantity", "Packaging", "Length", "Area"],
    required: true 
  },
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    default: "Active",
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Compound index to prevent duplicate conversions
uomConversionSchema.index({ fromUOM: 1, toUOM: 1 }, { unique: true });

// Pre-save middleware to update updatedAt
uomConversionSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("UOMConversion", uomConversionSchema);