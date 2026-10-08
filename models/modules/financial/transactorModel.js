const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

const transactorSchema = new mongoose.Schema({
  companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  accountCode: {
    type: String,
    required: true,
    match: /^[A-Z]{3}\d{3}$/,
    trim: true,
  },
  accountName: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
  },
  accountType: {
    type: String,
    enum: ["asset", "liability", "equity", "income", "expense"],
    required: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  openingBalance: {
    type: Number,
    default: 0,
    min: 0,
  },
  currentBalance: {
    type: Number,
    default: 0,
  },
  description: {
    type: String,
    trim: true,
  },
  allowDirectPosting: {
    type: Boolean,
    default: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Admin",
    required: true,
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Admin",
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Admin",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  deletedAt: {
    type: Date,
  },
});

// Pre-save middleware
transactorSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Pre-update middleware
transactorSchema.pre(["updateOne", "findOneAndUpdate"], function (next) {
  this.set({ updatedAt: Date.now() });
  next();
});

// Indexes (removed duplicate accountCode index)
transactorSchema.index({ accountCode: 1, isActive: 1, deletedAt: 1 }); // For FinancialService.processContraVoucher
transactorSchema.index({ accountType: 1 }); // For filtering by type
transactorSchema.index({ isActive: 1 }); // For active transactor filtering

transactorSchema.index({ accountCode: 1 }, { unique: true }); // unique within an organisation

// Scope every query and write to the organisation in scope, and make every declared index per-organisation.
transactorSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.model("Transactor", transactorSchema);