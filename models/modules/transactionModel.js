const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

const itemSchema = new mongoose.Schema({
  itemId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    ref: "Stock",
  },
  itemCode: { type: String, default: "" },
  // What kind of item this line sold or bought: "service" lines never move stock (utils/itemKinds.js). Stamped from the item
  // master when the document is priced, never taken from the request, and deliberately with no default: a line written before
  // services existed has none and reads as goods.
  itemType: { type: String, enum: ["goods", "service"] },
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
  headerDiscountNet: { type: Number, min: 0 }, // of discountAmount, the part that is the document's header discount shared out over the lines (utils/headerDiscount.js); absent otherwise
  discountAmount: { type: Number, default: 0, min: 0 },
  grossAmount: { type: Number, default: 0, min: 0 },
  taxableAmount: { type: Number, default: 0, min: 0 },
  taxCodeId: { type: mongoose.Schema.Types.ObjectId, ref: "TaxCode", default: null },
  // A document in a foreign currency: this line's figures in that currency (everything else on the line is in the BASE currency, so every report reads
  // it as before). Absent on a base-currency document. See utils/fxDocument.js.
  fx: { price: Number, grossAmount: Number, discountAmount: Number, taxableAmount: Number, vatAmount: Number, lineTotal: Number, rcmVat: Number },
  hsnCode: { type: String, trim: true }, // India: the item's HSN / SAC code when the line was priced (a snapshot, no default)
  costCentreId: { type: mongoose.Schema.Types.ObjectId, ref: "CostCentre" }, // a line's own cost centre, over the document's (no default)
  // India GST: the line's tax split into components (utils/gst.js). vatAmount stays the TOTAL tax; cgst + sgst + igst equals it.
  // Absent on a document that was not priced under GST (every UAE document, and Indian ones from before GST detail).
  gst: { cgst: Number, sgst: Number, igst: Number },
  rcmGst: { cgst: Number, sgst: Number, igst: Number },
  taxKind: { type: String, default: null }, // snapshot of the tax code's kind at posting
  // Reverse charge (taxKind "reverse_charge"): the VAT the RECIPIENT assesses on this line. The supplier charged none, so vatAmount is
  // 0 and lineTotal is the net; this is the self-assessed amount (taxable x the code's rate), posted by a purchase and reported in boxes
  // 3 and 10 (utils/pricing.js). Written only on a reverse-charge line, with no default: a line saved before this existed (priced as
  // if the supplier had charged VAT) has none, and the VAT return keeps reading those exactly as it always did.
  rcmVat: { type: Number, min: 0 },
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

// The last payment reminder an invoice was sent (services/messaging/paymentReminderService.js): what the list says as "Reminder sent 3 Dec".
// Separate from lastSend, which stays the last time the INVOICE itself went to the customer.
const lastReminderSchema = new mongoose.Schema(
  { sendId: mongoose.Schema.Types.ObjectId, step: String, channel: String, status: String, provider: String, at: Date, to: String, error: String },
  { _id: false }
);

const transactionSchema = new mongoose.Schema({
  companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  branchId: { type: String, default: "main" }, // the branch it belongs to; head office is "main"
  transactionNo: { type: String, required: true, trim: true }, // unique within an organisation: see the index below
  // References the person types, printed on the document beside the number it was given.
  // `docno` is the OTHER party's own document number (an opening invoice carries the customer's
  // pre-go-live "INV-2024-1187", an opening purchase the supplier's "GGI/24/0918"), `lpono` the
  // customer's purchase order. Both are sales/purchase specific and keep their meaning.
  docno: { type: String, default: null, trim: true },
  lpono: { type: String, default: null, trim: true },
  // The organisation's OWN reference for this document - a job number, a batch, whatever it files
  // its paper by. Deliberately a field of its own rather than a reuse of `docno`, which already
  // holds the counterparty's number on real records: relabelling it would mislabel those.
  // It does NOT replace the document number, which is still given by the number series; a person
  // who wants to type THAT uses the voucher type's `auto_override` method and `manualNumber`.
  serialNo: { type: String, default: null, trim: true, maxlength: 50 },
  costCentreId: { type: mongoose.Schema.Types.ObjectId, ref: "CostCentre" }, // the document's cost centre (a line may override it); no default
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
  // What approved returns against this invoice have credited (a sales or purchase return is applied to the invoice it returns,
  // exactly as a payment is), and, on a return, how much of that credit actually came off the invoice's open balance (the rest
  // is owed back: the invoice was already paid). Written by ReturnService only; a request body cannot set them.
  creditedAmount: { type: Number, default: 0, min: 0 },
  appliedToInvoice: { type: Number, default: 0, min: 0 },
  items: [itemSchema],
  // Self-billing (utils/selfBilling.js): we raise the tax invoice for the supplier. `selfBilledNo` is that invoice's (or
  // credit note's) own number, taken on approval; a request body can never set it. Absent on every other document.
  selfBilled: { type: Boolean },
  selfBilledNo: { type: String, trim: true },
  // what its paper prints, kept as on the day it was approved: the agreement, and for a credit note the invoice credited
  selfBillingRef: { type: String, trim: true },
  selfBilledAgainst: { type: String, trim: true },
  // Header charges (freight, handling, ...): each has its own tax and posts to its own account.
  charges: [
    {
      code: { type: String, trim: true },
      description: { type: String, trim: true },
      amount: { type: Number, required: true, min: 0 },
      vatPercent: { type: Number, default: 0, min: 0 },
      vatAmount: { type: Number, default: 0, min: 0 },
      gst: { cgst: Number, sgst: Number, igst: Number }, // India: this charge's tax by component (absent otherwise)
      fx: { amount: Number, vatAmount: Number }, // a foreign-currency document: this charge in that currency (the figures above are base)
      _id: false,
    },
  ],
  // Server-computed totals (see utils/pricing.js). totalAmount === pricing.grandTotal.
  pricing: {
    gross: Number,
    lineDiscount: Number,
    net: Number,
    lineVat: Number,
    rcmVat: Number, // self-assessed reverse-charge VAT: beside the total, never in it (absent on a document saved before it existed)
    chargesNet: Number,
    chargesVat: Number,
    headerDiscount: Number,
    // the header discount, when it was shared out over the lines as extra line discount (utils/headerDiscount.js): then headerDiscount is 0 and
    // the lines already carry it. Absent on an invoice made before, whose discount came off the total after tax.
    headerDiscountSpread: Number,
    roundOff: Number,
    grandTotal: Number,
    // India GST: the document's tax by component, summed from its lines and charges (cgst + sgst + igst = lineVat + chargesVat);
    // rcmGst is the self-assessed reverse-charge tax split the same way. Absent when the document was not priced under GST.
    gst: { cgst: Number, sgst: Number, igst: Number },
    rcmGst: { cgst: Number, sgst: Number, igst: Number },
  },
  // India GST: where the supply is made and whether it is within the supplier's state ("intra": CGST + SGST) or between states
  // ("inter": IGST), decided once when the document is priced and kept, so a later change to a party's state never rewrites it.
  // A document made in a foreign currency (USD, EUR ...). Every money field of the document and its lines is in the BASE currency; this is the same
  // document as the customer or supplier sees it, and what they owe or are owed: the rate it was made at, its totals, and how much is settled in that
  // currency. Absent on a base-currency document, which reads exactly as it always did. Written only by the server (utils/fxDocument.js).
  fx: {
    currency: { type: String, uppercase: true, trim: true },
    rate: { type: Number, min: 0 }, // base units per 1 foreign unit
    decimals: Number,
    rateDate: Date,
    rateSource: String,
    rateOverridden: Boolean,
    rateOverrideReason: { type: String, maxlength: 250 },
    totalAmount: { type: Number, min: 0 },
    paidAmount: { type: Number, default: 0, min: 0 },
    creditedAmount: { type: Number, default: 0, min: 0 },
    outstandingAmount: { type: Number, default: 0, min: 0 },
    appliedToInvoice: { type: Number, min: 0 }, // a return: how much of its invoice's open foreign amount it took off (so deleting it gives exactly that back)
    pricing: {
      gross: Number, lineDiscount: Number, net: Number, lineVat: Number, rcmVat: Number, chargesNet: Number, chargesVat: Number,
      headerDiscount: Number, headerDiscountSpread: Number, roundOff: Number, grandTotal: Number,
    },
  },
  placeOfSupply: { type: String, trim: true },
  supplierState: { type: String, trim: true },
  gstType: { type: String, enum: ["intra", "inter"] },
  // Returns reference the document they return; quantities are validated against it.
  returnOf: {
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction", default: null },
    transactionNo: { type: String, default: null },
    // What a tax credit note must say about the supply it corrects (VAT Executive Regulation Art. 60(1)(e),(g)), kept as
    // the server read it from the invoice, in the base currency: the invoice's date, its value before tax and its tax, and
    // what other approved returns had already credited of that value. Written by the server only; absent on older returns.
    date: { type: Date },
    value: { type: Number },
    vat: { type: Number },
    creditedBefore: { type: Number },
  },
  // An APPROVED document is never deleted: "Delete" reverses everything it posted and keeps it here, cancelled, with its
  // number still used (FTA: no hard deletes of posted entries). Absent on every other document.
  cancelled: {
    type: new mongoose.Schema({ at: Date, by: String, byName: String, reason: { type: String, trim: true, maxlength: 300 }, wasApproved: Boolean }, { _id: false }),
    default: undefined,
  },
  // Why the goods came back (Art. 60(1)(f)): printed on the credit note. Absent on older returns.
  returnReason: { type: String, trim: true, maxlength: 300 },
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
  // The job card this invoice was raised from (services/garage/jobCardService.createInvoice), so the printed
  // tax invoice can carry the job number and the vehicle it was for - what a garage invoice needs and a free-text
  // note cannot answer for ("Job card JC-..." in `notes` cannot be read back). Absent on every other document.
  // Plate AND chassis, as two fields: a car may be on file with one and not the other (an old import has no
  // plate yet, a pre-1981 car no VIN - see the partial indexes on vehicleModel.js), and a single combined
  // string could not be read back. Both come off the job card's own vehicle snapshot, so no Vehicle read.
  jobCardRef: {
    jobCardId: { type: mongoose.Schema.Types.ObjectId, ref: "JobCard" },
    jobNo: { type: String, trim: true },
    plateNumber: { type: String, trim: true },
    chassisNo: { type: String, trim: true },
  },
  // The sales order (TradeOrder, SORD) this invoice was converted from in ONE step, for an organisation that
  // does not hold delivery notes (TradeOrderService.createInvoice, the direct path). It is what the order reads
  // back to know it has been invoiced - live, so deleting or rejecting the invoice gives the order back with no
  // link to keep in step - and what the printed sheet prints as "Sales order no.". Set only by that service;
  // a request body can never reach it (stripped in transactionController.js and updateTransaction, like
  // jobCardRef). Absent on every other document, including an invoice raised through delivery notes.
  tradeOrderRef: {
    tradeOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "TradeOrder" },
    orderNo: { type: String, trim: true },
  },
  // The van trip this invoice (or sales return) was raised on (services/vansales/vanTripService.js). Set only by that
  // service; stripped from a request body like jobCardRef. Approving a document that carries it re-checks the trip is
  // still out and the stock is on the van. Absent on every other document.
  vanTripRef: {
    tripId: { type: mongoose.Schema.Types.ObjectId, ref: "VanTrip" },
    tripNo: { type: String, trim: true },
    vanCode: { type: String, trim: true },
  },
  // The recurring invoice that made this draft (services/orderPurchase/recurringInvoiceService.js). Set only by that service;
  // stripped from a request body like vanTripRef. Absent on every other document.
  recurringRef: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: "RecurringInvoice" },
    name: { type: String, trim: true },
  },
  // Credit and re-issue (EInvoiceService.reissue): an invoice priced before 18 Nov 2026 whose discount came off after VAT, the credit note
  // that cancels it and the invoice that replaces it all carry this, so they know they belong together. The first two are never
  // e-invoiced; the credit note mirrors the old invoice exactly and neither paper document moves stock (services/orderPurchase/reissueLinks.js).
  // Set only by that service, stripped from a request body like vanTripRef, cleared when the pair is broken. Absent on every other document.
  reissue: {
    type: new mongoose.Schema({
      role: { type: String, enum: ["original", "credit", "invoice"] },
      originalId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction" },
      originalNo: String,
      creditNoteId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction" },
      creditNoteNo: String,
      invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Transaction" },
      invoiceNo: String,
      dueDate: Date, // the new invoice keeps the old one's due date (the customer's terms do not restart)
      appliedCredit: Number, // the new invoice: what the credit note could not use on the old (already paid) invoice, taken off this one
      at: Date,
    }, { _id: false }),
    default: undefined,
  },
  creditNoteIssued: { type: Boolean, default: false },
  // Whether the organisation was registered for VAT on this document's date (UAE organisations only; services/financial/vatRegistrationService.js).
  // Stamped when it is priced and never defaulted: ABSENT means the document predates the rule and reads as it always did. A purchase
  // stamped false carries no recoverable VAT - it is part of the cost (utils/vatRegistration.js).
  vatRegistered: { type: Boolean },
  // A sales order the customer will not take the rest of (utils/closeShort.js).
  closedShort: { type: closedShortSchema, default: undefined },
  lastSend: { type: lastSendSchema, default: undefined },
  lastReminder: { type: lastReminderSchema, default: undefined },
  // Who has approved it so far. Always one entry once approved; two when the policy asked for a second approver, and
  // then the first entry is the document waiting for its second (utils/approvalRules.js).
  approvals: [{ _id: false, by: { type: String }, name: { type: String }, at: { type: Date }, step: { type: Number } }],
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
    // returns applied to this invoice come off what is owed, as payments do (a later receipt must not give them back)
    this.outstandingAmount = Math.max(0, this.totalAmount - this.paidAmount - (this.creditedAmount || 0));
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
transactionSchema.index({ "tradeOrderRef.tradeOrderId": 1 }, { sparse: true });
transactionSchema.index({ status: 1 });
// The order lists read one type, newest first, by date or by when it was saved: without these every list sorted the whole collection.
// The _id on the end is the tie-breaker that keeps a page boundary stable; without it the sort falls back to an
// in-memory sort of every matching document. (Declared once: a second, identical declaration lower down warned
// "Duplicate schema index" on every boot.)
transactionSchema.index({ type: 1, createdAt: -1, _id: -1 });
transactionSchema.index({ type: 1, date: -1 });
transactionSchema.index({ type: 1, totalAmount: 1 });
transactionSchema.index({ type: 1, status: 1, date: -1 });
transactionSchema.index({ date: -1 });
transactionSchema.index({ isOpening: 1, type: 1, partyId: 1 });
// a customer's latest approved invoices, newest first (the van salesman's "what do they usually buy" read)
transactionSchema.index({ partyId: 1, type: 1, status: 1, date: -1 });
transactionSchema.index({ createdAt: -1, _id: -1 });

transactionSchema.index({ transactionNo: 1 }, { unique: true }); // unique within an organisation - NOT per branch: a tax invoice number must be unique per taxpayer, so branches take their own prefix in the number format

// Scope every query and write to the organisation in scope, and make every declared index per-organisation.
// documents belong to a branch: a person working in one branch sees only that branch's (utils/tenantPlugin.js)
transactionSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

// every change a person makes is logged with its old and new values, and a deleted record is kept (utils/auditPlugin.js)
transactionSchema.plugin(require("../../utils/auditPlugin"), { entity: "Transaction", diff: false });
module.exports = mongoose.model("Transaction", transactionSchema);
