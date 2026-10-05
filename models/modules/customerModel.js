const mongoose = require("mongoose");
const { vatFields, creditFields, contactSchema, bankAccountSchema, documentSchema, jsonTransform, keepTrnInStep } = require("./partyMasterSchemas");
const { isValidTerms } = require("../../utils/partyMaster");

const customerSchema = new mongoose.Schema({
  customerId: { type: String, required: true, trim: true },
  customerName: { type: String, required: true, trim: true },
  contactPerson: { type: String, required: true, trim: true },
  email: { type: String, match: /\S+@\S+\.\S+/, sparse: true, trim: true },
  phone: { type: String, sparse: true, trim: true },
  website: { type: String, trim: true, maxlength: 200, default: "" },
  trnNumber: { type: String, trim: true, default: null }, // kept equal to vat.trn
  // Master data (see partyMasterSchemas.js): VAT configuration, credit days, contacts, bank accounts, KYC documents.
  vat: vatFields,
  credit: creditFields,
  contacts: [contactSchema],
  bankAccounts: [bankAccountSchema],
  documents: [documentSchema],
  // Needed to issue an e-invoice to a VAT-registered buyer (PINT AE / Peppol).
  eInvoice: {
    participantId: { type: String, trim: true, default: null }, // "0235:100123456700003"
    city: { type: String, trim: true, default: null },
    countryCode: { type: String, trim: true, uppercase: true, default: "AE" },
  },
  salesPerson: { type: String, trim: true, default: null, sparse: true },
  billingAddress: { type: String, default: null, trim: true },
  shippingAddress: { type: String, default: null, trim: true },
  creditLimit: { type: Number, default: 0, min: 0 },
  // Goods dispatched to this customer must have at least this many days of shelf life left.
  minShelfLifeDays: { type: Number, default: 0, min: 0 },
  // "Net 30", "Net 45", "Net 60", "Cash on Delivery", "Prepaid", or "Net <days>" for any other credit period.
  paymentTerms: {
    type: String,
    validate: { validator: (v) => isValidTerms("customer", v), message: "Invalid paymentTerms" },
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
  cashBalance: { type: Number, default: 0 }, // signed: order postings move it below zero // Used in FinancialService.adjustPartyCashBalance
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
customerSchema.index({ trnNumber: 1 }, { sparse: true }); // ✅ Added TRN index
customerSchema.index({ "vat.trn": 1 }, { unique: true, partialFilterExpression: { "vat.trn": { $type: "string" } } }); // one customer per TRN
customerSchema.index({ status: 1 }); // For filtering active customers
customerSchema.index({ createdAt: -1 }); // For sorting by creation date

customerSchema.set("toJSON", { transform: jsonTransform("customer") });
keepTrnInStep(customerSchema, "trnNumber");

module.exports = mongoose.model("Customer", customerSchema);