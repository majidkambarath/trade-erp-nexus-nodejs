const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

const categorySchema = new mongoose.Schema({
  companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  name: {
    type: String,
    required: [true, "Category name is required"],
    trim: true,
    maxlength: [100, "Category name cannot exceed 100 characters"],
  },
  description: {
    type: String,
    trim: true,
    maxlength: [500, "Description cannot exceed 500 characters"],
    default: null,
  },
  status: {
    type: String,
    default: "Active",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Update the updatedAt field before saving
categorySchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Update the updatedAt field before updating
categorySchema.pre("findOneAndUpdate", function (next) {
  this.set({ updatedAt: Date.now() });
  next();
});

categorySchema.index({ name: 1 }, { unique: true }); // unique within an organisation

// Scope every query and write to the organisation in scope, and make every declared index per-organisation.
categorySchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.model("Category", categorySchema);
