const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");
const { vatFields, creditFields, contactSchema, bankAccountSchema, documentSchema, jsonTransform, keepTrnInStep } = require("./partyMasterSchemas");
const { isValidTerms } = require("../../utils/partyMaster");

const customerSchema = new mongoose.Schema({
  companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  customerId: { type: String, required: true, trim: true },
  customerName: { type: String, required: true, trim: true },
  contactPerson: { type: String, trim: true, default: null }, // optional: a business may be dealt with by name only
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
    // A buyer with no TRN is identified by this (a trade licence number ...): the document then goes to the tax authority only.
    buyerIdentifier: { type: String, trim: true, default: undefined },
    legalRegistration: { type: { type: String, enum: ["TL", "EID", "PAS", "CD"], default: undefined }, id: { type: String, trim: true, default: undefined }, authority: { type: String, trim: true, default: undefined } },
  },
  salesPerson: { type: String, trim: true, default: null, sparse: true },
  // An insurance company is a Customer like any other: it gets a ledger account, ages its own receivables, and
  // is chosen as a job card's bill-to with no new finance code. This flag is the only thing that marks it as
  // one (garage module, services/garage/insuranceClaimService.js). False for every existing customer.
  isInsurer: { type: Boolean, default: false },
  // No payment reminders to this customer (a dispute, a customer who pays through a portal). No default: absent reads as "send them".
  remindersOff: { type: Boolean },
  billingAddress: { type: String, default: null, trim: true },
  // The address's country (ISO 3166 alpha-2) and, for the UAE, its emirate. Absent on a record saved before they existed, which stays valid:
  // nothing is stamped on it until somebody edits the address (utils/partyAddress.js).
  country: { type: String, trim: true, uppercase: true, default: undefined },
  emirate: { type: String, trim: true, default: undefined },
  // the address's city or town, its own field so documents and an e-invoice need not parse the free-text address
  city: { type: String, trim: true, maxlength: 80, default: undefined },
  // The GST state code ("27") of an Indian party: where the supply is made or received (utils/gst.js). Absent for any other
  // country and on a record saved before it existed; taken from the GSTIN's first two digits when not typed.
  stateCode: { type: String, trim: true, default: undefined },
  shippingAddress: { type: String, default: null, trim: true },
  creditLimit: { type: Number, default: 0, min: 0 },
  // Where the shop is, pinned from a van on a first visit (phase 5). Absent until somebody pins it; a van sale or visit
  // far from it is flagged on the supervisor's board, never refused.
  location: {
    type: new mongoose.Schema({ lat: Number, lng: Number, setAt: Date, setBy: String }, { _id: false }),
    default: undefined,
  },
  // Goods dispatched to this customer must have at least this many days of shelf life left.
  minShelfLifeDays: { type: Number, default: 0, min: 0 },
  // "Net 30", "Net 45", "Net 60", "Cash on Delivery", "Prepaid", or "Net <days>" for any other credit period.
  paymentTerms: {
    type: String,
    validate: { validator: (v) => isValidTerms("customer", v), message: "Invalid paymentTerms" },
    default: "Cash",
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

// Scope every query and write to the organisation in scope, and make every declared index per-organisation.
customerSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.model("Customer", customerSchema);