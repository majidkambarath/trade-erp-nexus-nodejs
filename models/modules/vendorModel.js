const mongoose = require("mongoose");

const vendorSchema = new mongoose.Schema({
  vendorId: { type: String, unique: true, required: true },
  vendorName: { type: String, required: true },
  contactPerson: { type: String, required: true },
  email: { type: String, match: /\S+@\S+\.\S+/, sparse: true },
  phone: { type: String, sparse: true },
  address: { type: String, required: true },
  paymentTerms: {
    type: String,
    // enum: ["30 days", "Net 30", "45 days", "Net 60", "60 days"],
    default: "30 days",
  },
  status: {
    type: String,
    // enum: ["Compliant", "Non-compliant", "Pending", "Expired"],
    default: "Pending",
  },
  enrollDate: { type: Date, default: Date.now },
  cashBalance: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Vendor", vendorSchema);