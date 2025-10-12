const mongoose = require("mongoose");

const itemSchema = new mongoose.Schema({
  itemId: { type: String, required: true, trim: true },
    itemCode: { type: String, default:"" },
  description: { type: String, required: true, trim: true },
  qty: { type: Number, required: true, min: 0 },
  rate: { type: Number, required: true, min: 0 },
  taxPercent: { type: Number, default: 5, min: 0 },
  taxAmount: { type: Number, default: 0, min: 0 },
  lineTotal: { type: Number, required: true, min: 0 },
  reason: { type: String, trim: true },
});

const transactionSchema = new mongoose.Schema({
  transactionNo: { type: String, unique: true, required: true, trim: true },
  type: {
    type: String,
    enum: ["purchase_order", "sales_order", "purchase_return", "sales_return"],
    required: true,
  },
  partyId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    refPath: "partyTypeRef",
  },
  partyType: {
    type: String,
    enum: ["Customer", "Vendor"],
    required: true,
  },
  partyTypeRef: {
    type: String,
    enum: ["Customer", "Vendor"],
    required: true,
  },
  date: { type: Date, default: Date.now },
  deliveryDate: { type: Date },
  returnDate: { type: Date },
  expectedDispatch: { type: Date },
  status: {
    type: String,
    default: "DRAFT",
  },
  totalAmount: { type: Number, required: true, min: 0 },
  paidAmount: { type: Number, default: 0, min: 0 },
  outstandingAmount: { type: Number, default: 0, min: 0 },
  items: [itemSchema],
  terms: { type: String, trim: true },
  notes: { type: String, trim: true },
  quoteRef: { type: String, trim: true },
  linkedRef: { type: String, trim: true },
  creditNoteIssued: { type: Boolean, default: false },
  createdBy: { type: String, required: true, trim: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  priority: {
    type: String,
    enum: ["High", "Medium", "Low"],
    default: "Medium",
  },
  grnGenerated: { type: Boolean, default: false },
  invoiceGenerated: { type: Boolean, default: false },
});

// Pre-save middleware
transactionSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  if (!this.totalAmount) {
    this.totalAmount = this.items.reduce((sum, item) => sum + item.lineTotal, 0);
  }
  if (this.isNew || this.isModified("totalAmount") || this.isModified("paidAmount")) {
    this.outstandingAmount = this.totalAmount - this.paidAmount;
  }
  // Remove automatic status changes based on payment
  next();
});

// Pre-update middleware
transactionSchema.pre(["updateOne", "findOneAndUpdate"], function (next) {
  this.set({ updatedAt: Date.now() });
  next();
});

// Indexes
transactionSchema.index({ partyId: 1, partyType: 1 });
transactionSchema.index({ status: 1 });
transactionSchema.index({ date: -1 });

module.exports = mongoose.model("Transaction", transactionSchema);