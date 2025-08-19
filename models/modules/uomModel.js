const mongoose = require("mongoose");

const uomSchema = new mongoose.Schema({
  unitName: { type: String, required: true, unique: true },
  shortCode: { type: String, required: true, unique: true },
  type: {
    type: String,
    enum: ["Base", "Derived"],
    default: "Base",
    required: true
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

// Pre-save middleware to update updatedAt
uomSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("UOM", uomSchema);