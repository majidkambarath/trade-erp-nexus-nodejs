const mongoose = require("mongoose");

const itemSchema = new mongoose.Schema({
  itemId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: "Stock",
  },
  itemCode: { type: String, default: "" },
  description: { type: String, required: true, trim: true },
  qty: { type: Number, required: true, min: 0 },
  price: { type: Number, default: 0, min: 0 },
  currentPurchasePrice: { type: Number, default: 0, min: 0 },
  rate: { type: Number, default: 0, min: 0 },
  package: { type: Number, default: 0 },
  vatPercent: { type: Number, default: 0, min: 0 },
  vatAmount: { type: Number, default: 0, min: 0 },
  lineTotal: { type: Number, required: true, min: 0 },
  grandTotal: { type: Number, default: 0, min: 0 },
  brand: { type: String, default: null },
  origin: { type: String, default: null },
  reason: { type: String, trim: true },
  // Pricing: computed on the server (utils/pricing.js). discountAmount is the amount actually
  // taken off, whether the client sent a percentage or a fixed amount.
  discountPercent: { type: Number, default: 0, min: 0, max: 100 },
  discountAmount: { type: Number, default: 0, min: 0 },
  grossAmount: { type: Number, default: 0, min: 0 },
  taxableAmount: { type: Number, default: 0, min: 0 },
  taxCodeId: { type: mongoose.Schema.Types.ObjectId, ref: "TaxCode", default: null },
  taxKind: { type: String, default: null }, // snapshot of the tax code's kind at posting
  // Batch / expiry for perishables (a batch belongs to a receipt, not to the product).
  batchNumber: { type: String, trim: true, default: null },
  expiryDate: { type: Date, default: null },
  // Returns: the line of the original document this line returns.
  returnOfLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
  // Batches a dispatch was allocated from (first-expiry-first-out).
  allocations: [{ batchId: mongoose.Schema.Types.ObjectId, batchNumber: String, qty: Number, expiryDate: Date, _id: false }],
});

// A sales order the customer will not take the rest of (utils/closeShort.js). `lines` is what fell short;
// `trimmed` says a draft's lines were cut down to what was delivered, in which case `original` holds the
// order as it was so closing can be undone exactly. `original` is a whole copy, so ordinary reads leave it out.
const closedShortSchema = new mongoose.Schema(
  {
    at: Date,
    by: String,
    reason: { type: String, trim: true },
    trimmed: Boolean,
    valueShort: Number,
    lines: [
      {
        lineId: mongoose.Schema.Types.ObjectId,
        description: String,
        ordered: Number,
        delivered: Number,
        short: Number,
        valueShort: Number,
        _id: false,
      },
    ],
    original: { type: mongoose.Schema.Types.Mixed, select: false },
  },
  { _id: false }
);

// How a document last went to the customer (services/messaging). Written when a send settles, so a list
// can say "Emailed 6 Oct" without a join. The full history is the DocumentSend log.
const lastSendSchema = new mongoose.Schema(
  { sendId: mongoose.Schema.Types.ObjectId, channel: String, status: String, provider: String, at: Date, to: String, openedAt: Date, error: String },
  { _id: false }
);

const transactionSchema = new mongoose.Schema({
  transactionNo: { type: String, unique: true, required: true, trim: true },
  // Sales invoice specific fields
  docno: { type: String, default: null, trim: true },
  lpono: { type: String, default: null, trim: true },
  discount: { type: Number, default: 0, min: 0 },
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
    // enum: ["Customer", "Vendor"],
    required: true,
  },
  partyTypeRef: {
    type: String,
    // enum: ["Customer", "Vendor"],
    required: true,
  },
  vendorReference: {
    type: String,
    default: null,
  },
  date: { type: Date, default: Date.now },
  // When the party has to pay. Only opening invoices carry one (entered from the old books);
  // ordinary documents are due by the party's payment terms.
  dueDate: { type: Date, default: null },
  // An invoice carried over from the old books (services/financial/openingBalanceService.js): it has
  // no lines, no stock, no VAT and no e-invoice, is not returnable, and is posted against Opening
  // Balance Equity. Every consumer of approved documents that must ignore these checks this flag.
  isOpening: { type: Boolean, default: false },
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
  // Header charges (freight, handling, ...): each has its own tax and posts to its own account.
  charges: [
    {
      code: { type: String, trim: true },
      description: { type: String, trim: true },
      amount: { type: Number, required: true, min: 0 },
      vatPercent: { type: Number, default: 0, min: 0 },
      vatAmount: { type: Number, default: 0, min: 0 },
      _id: false,
    },
  ],
  // Server-computed totals (see utils/pricing.js). totalAmount === pricing.grandTotal.
  pricing: {
    gross: Number,
    lineDiscount: Number,
    net: Number,
    lineVat: Number,
    chargesNet: Number,
    chargesVat: Number,
    headerDiscount: Number,
    roundOff: Number,
    grandTotal: Number,
  },
  // Returns reference the document they return; quantities are validated against it.
  returnOf: {
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction", default: null },
    transactionNo: { type: String, default: null },
  },
  attachments: [
    {
      attachmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Attachment" },
      fileName: { type: String, trim: true },
      url: { type: String, trim: true },
      fileType: { type: String, trim: true },
      fileSize: { type: Number, min: 0 },
      uploadedBy: { type: String },
      uploadedAt: { type: Date, default: Date.now },
    },
  ],
  // Optional per-line discount support if frontend sends it
  // Keeping header-level discount authoritative unless specified otherwise
  terms: { type: String, trim: true },
  notes: { type: String, trim: true },
  quoteRef: { type: String, trim: true },
  linkedRef: { type: String, trim: true },
  creditNoteIssued: { type: Boolean, default: false },
  // A sales order the customer will not take the rest of (utils/closeShort.js).
  closedShort: { type: closedShortSchema, default: undefined },
  lastSend: { type: lastSendSchema, default: undefined },
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
    this.totalAmount = this.items.reduce(
      (sum, item) => sum + item.lineTotal,
      0
    );
  }
  if (
    this.isNew ||
    this.isModified("totalAmount") ||
    this.isModified("paidAmount")
  ) {
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
transactionSchema.index({ "returnOf.transactionId": 1 }, { sparse: true });
transactionSchema.index({ status: 1 });
transactionSchema.index({ date: -1 });
transactionSchema.index({ isOpening: 1, type: 1, partyId: 1 });
// List query: filter by type, sort by createdAt. Without this the sort
// falls back to an in-memory sort of every matching document.
transactionSchema.index({ type: 1, createdAt: -1 });
transactionSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Transaction", transactionSchema);
