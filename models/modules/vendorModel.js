const mongoose = require("mongoose");

const vendorSchema = new mongoose.Schema({
  vendorId: { type: String, required: true, trim: true },
  vendorName: { type: String, required: true, trim: true },
  contactPerson: { type: String, required: true, trim: true },
  email: { type: String, match: /\S+@\S+\.\S+/, sparse: true, trim: true },
  phone: { type: String, sparse: true, trim: true },
  address: { type: String, required: true, trim: true },
  paymentTerms: {
    type: String,
    enum: ["30 days", "Net 30", "45 days", "Net 60", "60 days"],
    default: "30 days",
  },
  status: {
    type: String,
    enum: ["Compliant", "Non-compliant", "Pending", "Expired"],
    default: "Compliant",
  },
  enrollDate: { type: Date, default: Date.now },
  cashBalance: { type: Number, default: 0, min: 0 }, // Used in FinancialService.adjustPartyCashBalance
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Pre-save middleware to update timestamp
vendorSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Pre-update middleware to update timestamp
vendorSchema.pre(["updateOne", "findOneAndUpdate"], function (next) {
  this.set({ updatedAt: Date.now() });
  next();
});

// Indexes (removed _id index as it's implicit)
vendorSchema.index({ vendorId: 1 }, { unique: true });
vendorSchema.index({ cashBalance: 1 }); // For FinancialService.adjustPartyCashBalance
vendorSchema.index({ status: 1 }); // For filtering vendors
vendorSchema.index({ createdAt: -1 }); // For sorting by creation date

module.exports = mongoose.model("Vendor", vendorSchema);