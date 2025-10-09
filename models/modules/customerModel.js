const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema({
  customerId: { type: String, required: true, trim: true },
  customerName: { type: String, required: true, trim: true },
  contactPerson: { type: String, required: true, trim: true },
  email: { type: String, match: /\S+@\S+\.\S+/, sparse: true, trim: true },
  phone: { type: String, sparse: true, trim: true },
  billingAddress: { type: String, default: null, trim: true },
  shippingAddress: { type: String, default: null, trim: true },
  creditLimit: { type: Number, default: 0, min: 0 },
  paymentTerms: {
    type: String,
    enum: ["Net 30", "Net 45", "Net 60", "Cash on Delivery", "Prepaid"],
    default: "Net 30",
  },
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    default: "Active",
  },
  joinDate: { type: Date, default: Date.now },
  totalOrders: { type: Number, default: 0, min: 0 },
  totalSpent: { type: Number, default: 0, min: 0 },
  lastOrder: { type: Date },
  cashBalance: { type: Number, default: 0, min: 0 }, // Used in FinancialService.adjustPartyCashBalance
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Pre-save middleware to update timestamp
customerSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Pre-update middleware to update timestamp
customerSchema.pre(["updateOne", "findOneAndUpdate"], function (next) {
  this.set({ updatedAt: Date.now() });
  next();
});

// Indexes (removed _id index as it's implicit)
customerSchema.index({ customerId: 1 }, { unique: true });
customerSchema.index({ cashBalance: 1 }); // For FinancialService.adjustPartyCashBalance
customerSchema.index({ status: 1 }); // For filtering active customers
customerSchema.index({ createdAt: -1 }); // For sorting by creation date

module.exports = mongoose.model("Customer", customerSchema);