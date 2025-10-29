const mongoose = require("mongoose");

const vatReportItemSchema = new mongoose.Schema({
  transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction", required: true },
  transactionNo: { type: String, required: true },
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: "Stock" },
  itemCode: String,
  description: String,
  qty: { type: Number, required: true },
  rate: { type: Number, required: true },
  lineTotal: { type: Number, required: true },
  vatAmount: { type: Number, required: true },
  vatRate: { type: Number, required: true },
  partyId: { type: mongoose.Schema.Types.ObjectId, required: true },
  partyName: String,
  partyType: { type: String, enum: ["Customer", "Vendor"], required: true },
  date: { type: Date, required: true },
});

const vatReportSchema = new mongoose.Schema({
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },
  generatedAt: { type: Date, default: Date.now },
  generatedBy: { type: String, required: true },
  totalVATOutput: { type: Number, default: 0 },
  totalVATInput: { type: Number, default: 0 },
  netVATPayable: { type: Number, default: 0 },
  items: [vatReportItemSchema],
  status: {
    type: String,
    enum: ["DRAFT", "FINALIZED", "SUBMITTED"],
    default: "DRAFT",
  },
});

vatReportSchema.index({ periodStart: 1, periodEnd: 1 });
vatReportSchema.index({ generatedAt: -1 });

module.exports = mongoose.model("VATReport", vatReportSchema);