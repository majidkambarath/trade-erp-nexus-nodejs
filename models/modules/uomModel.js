const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

const uomSchema = new mongoose.Schema({
  companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  unitName: { type: String, required: true }, // unique within an organisation: see below
  shortCode: { type: String, required: true }, // unique within an organisation: see below
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

uomSchema.index({ unitName: 1 }, { unique: true }); // unique within an organisation
uomSchema.index({ shortCode: 1 }, { unique: true }); // unique within an organisation

// Scope every query and write to the organisation in scope, and make every declared index per-organisation.
uomSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.model("UOM", uomSchema);