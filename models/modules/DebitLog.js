const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

const debitLogSchema = new mongoose.Schema({
  companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  vendorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Vendor",
    required: true,
  },
  type: {
    type: String,
    enum: ["purchase_order", "purchase_return", "payment_received", "adjustment", "purchase_order_reversed", "purchase_return_reversed"],
    required: true,
  },
  date: { type: Date, default: Date.now },
  invNo: { type: String, required: true }, // transactionNo
  amount: { type: Number, required: true }, // debit amount (+ for PO, - for return)
  paid: { type: Number, default: 0 },
  balance: { type: Number, required: true }, // running balance after this entry
  ref: { type: String }, // e.g., transactionId or payment ref
  status: {
    type: String,
    enum: ["UNPAID", "PARTIAL", "PAID", "REVERSED"],
    default: "UNPAID",
  },
  createdBy: { type: String, required: true },
}, { timestamps: true });

// Scope every query and write to the organisation in scope, and make every declared index per-organisation.
debitLogSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.model("DebitLog", debitLogSchema);