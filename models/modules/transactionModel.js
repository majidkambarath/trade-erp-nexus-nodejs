const mongoose = require("mongoose");

const itemSchema = new mongoose.Schema({
  itemId: { type: String, required: true }, // from Stock.itemId
  description: { type: String, required: true },
  qty: { type: Number, required: true, min: 0 },
  rate: { type: Number, required: true, min: 0 },
  taxPercent: { type: Number, default: 5, min: 0 },
  lineTotal: { type: Number, required: true, min: 0 },
  reason: { type: String }, // for returns
});

const transactionSchema = new mongoose.Schema({
  transactionNo: { type: String, unique: true, required: true },
  type: {
    type: String,
    enum: ["purchase_order", "sales_order", "purchase_return", "sales_return"],
    required: true,
  },
  partyId: { type: mongoose.Schema.Types.ObjectId, required: true }, // ref Vendor or Customer based on type
  partyType: { type: String, enum: ["vendor", "customer"], required: true },
  date: { type: Date, default: Date.now },
  deliveryDate: { type: Date }, // for orders
  returnDate: { type: Date }, // for returns
  expectedDispatch: { type: Date }, // for sales
  status: { type: String, default: "DRAFT" },
  totalAmount: { type: Number, required: true, min: 0 },
  items: [itemSchema],
  terms: { type: String },
  notes: { type: String },
  quoteRef: { type: String }, // for sales
  linkedRef: { type: String }, // linked GRN/invoice
  creditNoteIssued: { type: Boolean, default: false }, // for sales return
  createdBy: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  priority: {
    type: String,
    enum: ["High", "Medium", "Low"],
    default: "Medium",
  },
  grnGenerated: { type: Boolean, default: false }, // for purchase
  invoiceGenerated: { type: Boolean, default: false }, // for sales
});

transactionSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  // Calculate totalAmount if not set
  if (!this.totalAmount) {
    this.totalAmount = this.items.reduce(
      (sum, item) => sum + item.lineTotal,
      0
    );
  }
  next();
});

module.exports = mongoose.model("Transaction", transactionSchema);
