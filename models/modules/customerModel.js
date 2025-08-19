const mongoose = require("mongoose");

const customerSchema = new mongoose.Schema({
  customerId: { type: String, unique: true, required: true },
  customerName: { type: String, required: true },
  contactPerson: { type: String, required: true },
  email: { type: String, match: /\S+@\S+\.\S+/, sparse: true },
  phone: { type: String, match: /^\+?\d{10,15}$/, sparse: true },
  billingAddress: { type: String, default: null },
  shippingAddress: { type: String, default: null },
  creditLimit: { type: Number, default: 0, min: 0 },
  paymentTerms: {
    type: String,
    // enum: ["Net 30", "Net 45", "Net 60", "Cash on Delivery", "Prepaid"],
    default: "Net 30",
  },
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    default: "Active",
  },
  joinDate: { type: Date, default: Date.now },
  totalOrders: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
  lastOrder: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Update the updatedAt field before saving
customerSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Update the updatedAt field before updating
customerSchema.pre(["updateOne", "findOneAndUpdate"], function (next) {
  this.set({ updatedAt: Date.now() });
  next();
});

module.exports = mongoose.model("Customer", customerSchema);
