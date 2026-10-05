const mongoose = require("mongoose");
const { vatFields, creditFields, contactSchema, bankAccountSchema, documentSchema, jsonTransform, keepTrnInStep } = require("./partyMasterSchemas");
const { isValidTerms } = require("../../utils/partyMaster");

const vendorSchema = new mongoose.Schema({
  vendorId: { type: String, required: true, trim: true },
  vendorName: { type: String, required: true, trim: true },
  trnNO: { type: String, default: null }, // kept equal to vat.trn
  // Master data (see partyMasterSchemas.js): VAT configuration, credit days, contacts, bank accounts, KYC documents.
  vat: vatFields,
  credit: creditFields,
  contacts: [contactSchema],
  bankAccounts: [bankAccountSchema],
  documents: [documentSchema],
  participantId: { type: String, trim: true, default: null }, // Peppol id, matches inbound e-invoices
  contactPerson: { type: String, required: true, trim: true },
  email: { type: String, match: /\S+@\S+\.\S+/, sparse: true, trim: true },
  phone: { type: String, sparse: true, trim: true },
  website: { type: String, trim: true, maxlength: 200, default: "" },
  address: { type: String, required: true, trim: true },
  // "30 days", "Net 30", "45 days", "Net 60", "60 days", "COD", or "Net <days>" for any other credit period.
  paymentTerms: {
    type: String,
    validate: { validator: (v) => isValidTerms("vendor", v), message: "Invalid paymentTerms" },
    default: "30 days",
  },
  status: {
    type: String,
    enum: ["Compliant", "Non-compliant", "Pending", "Expired"],
    default: "Compliant",
  },
  enrollDate: { type: Date, default: Date.now },
  cashBalance: { type: Number, default: 0 }, // signed: order postings move it below zero // Used in FinancialService.adjustPartyCashBalance
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Pre-save middleware to update timestamp
vendorSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Pre-update middleware to update timestamp
vendorSchema.pre(["updateOne", "findOneAndUpdate"], function (next) {
  this.set({ updatedAt: Date.now() });
  next();
});

// Indexes (removed _id index as it's implicit)
vendorSchema.index({ vendorId: 1 }, { unique: true });
vendorSchema.index({ cashBalance: 1 }); // For FinancialService.adjustPartyCashBalance
vendorSchema.index({ status: 1 }); // For filtering vendors
vendorSchema.index({ "vat.trn": 1 }, { unique: true, partialFilterExpression: { "vat.trn": { $type: "string" } } }); // one vendor per TRN
vendorSchema.index({ createdAt: -1 }); // For sorting by creation date

vendorSchema.set("toJSON", { transform: jsonTransform("vendor") });
keepTrnInStep(vendorSchema, "trnNO");

module.exports = mongoose.model("Vendor", vendorSchema);
