const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

const creditLogSchema = new mongoose.Schema({
  companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Customer",
    required: true,
  },
  type: {
    type: String,
    enum: ["sales_order", "sales_return", "payment_made", "adjustment", "sales_order_reversed", "sales_return_reversed"],
    required: true,
  },
  date: { type: Date, default: Date.now },
  invNo: { type: String, required: true },
  amount: { type: Number, required: true }, // credit amount (+ for SO, - for return)
  paid: { type: Number, default: 0 },
  balance: { type: Number, required: true },
  ref: { type: String },
  status: {
    type: String,
    enum: ["UNPAID", "PARTIAL", "PAID", "REVERSED"],
    default: "UNPAID",
  },
  createdBy: { type: String, required: true },
}, { timestamps: true });

// Scope every query and write to the organisation in scope, and make every declared index per-organisation.
creditLogSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.model("CreditLog", creditLogSchema);