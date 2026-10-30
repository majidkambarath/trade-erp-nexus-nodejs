const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// A job card: a vehicle comes in with complaints, an estimate of parts/labour/sublet is built and approved (whole
// or in part, by the customer or by an insurer), tasks are worked, the car is invoiced and handed back. It is a
// NON-POSTING document in its own collection, like a delivery note or a goods receipt: nothing here moves stock
// or touches the ledger. Approving the sales invoice it raises does both, exactly as approving any other invoice
// does (services/garage/jobCardService.js createInvoice calls TransactionService.createTransaction).
//
// DRAFT -> AWAITING_APPROVAL -> IN_PROGRESS -> READY -> DELIVERED -> CLOSED, or CANCELLED at any point before
// delivery. "Closed" means invoiced AND handed over; a card can be DELIVERED (car gone) before it is invoiced
// (the counter rings it up later), which is exactly the "delivered, not invoiced" trap the board calls out.
//
// Rules: utils/garage.js. Service: services/garage/jobCardService.js. The invoice link follows the delivery-note
// pattern (utils/salesDocuments.js INVOICE_STATE) so lists and screens already know that shape.
const id = mongoose.Schema.Types.ObjectId;

// A complaint in the customer's own words, and what was found and done about it, kept apart on purpose as the
// trade's "3 Cs": Concern (what they said), Cause (what the technician found), Correction (what was done).
const complaintSchema = new mongoose.Schema(
  {
    seq: Number,
    concern: { type: String, trim: true, maxlength: 400, required: true },
    cause: { type: String, trim: true, maxlength: 400, default: "" },
    correction: { type: String, trim: true, maxlength: 400, default: "" },
    status: { type: String, enum: ["OPEN", "DIAGNOSED", "DONE", "NOT_DONE"], default: "OPEN" },
  },
  { _id: true }
);

// One line of the estimate/invoice: a part or consumable (goods - moves stock when the invoice is approved), or
// labour or sublet (a service item - never moves stock; utils/itemKinds.js). `itemId` always points at a Stock
// document; which kind decides whether it is stocked, not the Stock document's own itemType (a labour operation
// and a part are both just the item a line bills). `approved` left unset means approved (utils/garage.js
// isApproved): an estimate is accepted whole far more often than it is picked apart.
const lineSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["part", "labour", "sublet", "consumable"], required: true },
    itemId: { type: id, ref: "Stock", required: true },
    itemCode: String,
    description: { type: String, trim: true, maxlength: 200 },
    qty: { type: Number, required: true, min: 0 },
    issuedQty: { type: Number, default: 0 }, // parts actually handed to the technician (committed, not yet moved)
    price: { type: Number, required: true, min: 0 },
    discountPercent: { type: Number, min: 0, max: 100, default: 0 },
    discountAmount: { type: Number, min: 0, default: 0 },
    // The VAT the pricing engine (TransactionService.buildPricing, via priceDocument/storedLine - the same
    // shape a Transaction line keeps) computed for this line. Declared here on purpose: Mongoose strict mode
    // silently drops an undeclared path on save, which is how a job card used to compute real VAT and then
    // lose it before the estimate or the invoice could read it back.
    itemType: { type: String, enum: ["goods", "service"] },
    grossAmount: { type: Number, default: 0, min: 0 },
    taxableAmount: { type: Number, default: 0, min: 0 },
    taxCodeId: { type: id, ref: "TaxCode" },
    taxKind: { type: String, default: null }, // snapshot of the tax code's kind at pricing time
    vatPercent: { type: Number, default: 0, min: 0 },
    vatAmount: { type: Number, default: 0, min: 0 },
    rcmVat: { type: Number, min: 0 }, // reverse-charge self-assessed VAT, absent on every other line
    lineTotal: { type: Number, min: 0 }, // the priced total (qty x price less discount, plus VAT) - present() recomputes it, this is the stored snapshot
    vendorId: { type: id, ref: "Vendor" }, // sublet only: who the work goes out to
    vendorName: String,
    complaintId: { type: id }, // which complaint this line answers, for the printed estimate to group by
    approved: { type: Boolean, default: undefined }, // undefined/true = approved; false = the customer said no
    invoiced: { type: Boolean, default: false }, // billed on SOME invoice already (jobCardService.createInvoice sets
    // it on the lines it actually bills) - stops the same line being billed twice, whether by two presses of the
    // ordinary "Raise invoice" button or by it racing an insurance claim's own raiseInvoices for the same lines.
    addedInVersion: { type: Number, default: 1 }, // which estimate version introduced this line
  },
  { _id: true }
);

// One task: in-house (a Staff member, optionally one with a login - see assigneeId) or sublet (a Vendor, on a
// job-work challan, the same mechanism utils/jobWork.js already provides). Tasks share a STAGE and run in
// parallel within it; the next stage opens only once every task in this one is settled (utils/garage.js advance).
// This is the one structural difference from a process order's strictly sequential steps (utils/processOrders.js).
const taskSchema = new mongoose.Schema(
  {
    seq: Number,
    stage: { type: Number, min: 1, max: 50, default: 1 },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    mode: { type: String, enum: ["in_house", "sublet"], required: true },
    staffId: { type: id, ref: "Staff" },
    staffName: { type: String, trim: true, maxlength: 120 },
    assigneeId: { type: String }, // the Staff member's own account id, if they have a login (see processOrderModel)
    vendorId: { type: id, ref: "Vendor" }, // sublet only
    vendorName: String,
    bayId: { type: id, ref: "Bay" },
    bayName: String,
    complaintId: { type: id },
    standardHours: { type: Number, min: 0, default: 0 },
    actualHours: { type: Number, min: 0, default: 0 },
    status: { type: String, enum: ["WAITING", "READY", "IN_PROGRESS", "DONE", "SKIPPED"], default: "WAITING" },
    holdReason: { type: String, trim: true, maxlength: 80 }, // why it is stuck, if it is
    jobWorkId: { type: id, ref: "JobWorkOrder" }, // sublet: the challan sent for it
    jobWorkNo: String,
    readyAt: Date,
    startedAt: Date,
    startedBy: String,
    doneAt: Date,
    doneBy: String,
    notes: { type: String, trim: true, maxlength: 500 },
  },
  { _id: true }
);

// A snapshot of an invoice raised from this card: which bill-to it went to (the garage's own customer or the
// insurer) and where it stands, so a split job prints two invoices and the card knows both of them.
const invoiceLinkSchema = new mongoose.Schema(
  {
    transactionId: { type: id, ref: "Transaction" },
    no: String,
    billTo: { type: String, enum: ["customer", "insurer"], default: "customer" },
    amount: Number,
    status: String,
    lineIds: { type: [id], default: [] }, // which estimate lines this invoice actually billed, so
    // jobCardLinks.js can free exactly those lines (set invoiced back to false) if this invoice is
    // later rejected, cancelled or deleted - never every line on the card.
  },
  { _id: false }
);

// A purchase order raised because a part this card needs was not on hand (utils/garage.js shortages / plan
// part 1.2 step 8: "if a part is not in stock, a purchase order goes to a vendor, goods are received, then
// the part reaches the job"). The same shape as invoiceLinkSchema for the same reason - a record of what was
// raised, never a trigger for anything else: the storekeeper receives it and issues the part like any other,
// through the ordinary Purchase screens, not through this card.
const purchaseOrderLinkSchema = new mongoose.Schema(
  {
    tradeOrderId: { type: id, ref: "TradeOrder" },
    no: String,
    vendorId: { type: id, ref: "Vendor" },
    vendorName: String,
    amount: Number,
    itemIds: { type: [id], default: [] }, // which Stock items this order was raised for
  },
  { _id: false }
);

// A point marked on the check-in body diagram, and what was found there: the garage's only defence when a
// customer later claims the damage was not there on arrival.
const damagePointSchema = new mongoose.Schema(
  {
    panel: { type: String, trim: true, maxlength: 60 }, // "front bumper", "rear door - left", ...
    kind: { type: String, enum: ["scratch", "dent", "crack", "chip", "rust", "missing", "broken"] },
    notes: { type: String, trim: true, maxlength: 200, default: "" },
  },
  { _id: false }
);

const jobCardSchema = new mongoose.Schema(
  {
    jobNo: { type: String, trim: true }, // given when the card is created (like a delivery note's own number)
    status: {
      type: String,
      enum: ["DRAFT", "AWAITING_APPROVAL", "IN_PROGRESS", "READY", "DELIVERED", "CLOSED", "CANCELLED"],
      default: "DRAFT",
    },
    jobType: { type: String, enum: ["retail", "insurance", "warranty", "internal", "fleet"], default: "retail" },

    vehicleId: { type: id, ref: "Vehicle", required: true },
    vehicle: {
      plateNumber: String,
      make: String,
      model: String,
      year: Number,
      colour: String,
      chassisNo: String,
    },
    customerId: { type: id, ref: "Customer", required: true },
    customer: { name: String, phone: String },

    receivedAt: { type: Date, default: Date.now },
    promisedAt: Date,
    odometerIn: { type: Number, min: 0 },
    fuelLevelIn: { type: String, enum: ["E", "1/4", "1/2", "3/4", "F", ""], default: "" },

    checkIn: {
      damagePoints: { type: [damagePointSchema], default: [] },
      itemsPresent: { type: [String], default: [] }, // chosen from utils/garage.js CHECK_IN_ITEMS, free text allowed
      photos: { type: [String], default: [] }, // Attachment ids (AttachmentService, ownerType "jobcard")
      signatureAttachmentId: { type: id, ref: "Attachment" },
      notes: { type: String, trim: true, maxlength: 500, default: "" },
    },

    complaints: { type: [complaintSchema], default: [] },
    tasks: { type: [taskSchema], default: [] },
    lines: { type: [lineSchema], default: [] },

    estimate: {
      version: { type: Number, default: 0 },
      sentAt: Date,
      sentBy: String,
      decidedAt: Date,
      decidedBy: String,
      method: { type: String, enum: ["whatsapp", "email", "signed", "call", "counter", "lpo", "portal"] },
      reference: { type: String, trim: true, maxlength: 60, default: "" }, // an LPO number, a message id, ...
      note: { type: String, trim: true, maxlength: 300, default: "" },
      total: { type: Number, default: 0 },
    },
    estimateHistory: { type: [mongoose.Schema.Types.Mixed], default: [] }, // a copy of `estimate` each time it changed

    claimId: { type: id, ref: "InsuranceClaim" },

    invoices: { type: [invoiceLinkSchema], default: [] },
    invoiceStatus: { type: String, enum: ["NONE", "DRAFT", "INVOICED"], default: "NONE" },
    purchaseOrders: { type: [purchaseOrderLinkSchema], default: [] },

    delivery: {
      gatePassAt: Date,
      releasedBy: String,
      odometerOut: { type: Number, min: 0 }, // D11: had no floor at all, unlike odometerIn below
      handedTo: { type: String, trim: true, maxlength: 150, default: "" },
      signatureAttachmentId: { type: id, ref: "Attachment" },
    },

    warranty: {
      months: { type: Number, min: 0, default: 0 },
      kilometres: { type: Number, min: 0, default: 0 },
      until: String, // "YYYY-MM-DD", the org's calendar day
      untilOdometer: Number,
    },
    comebackOf: { type: id, ref: "JobCard" }, // the earlier job this one is a warranty return against, if marked so

    notes: { type: String, trim: true, maxlength: 1000, default: "" },
    cancelledAt: Date,
    cancelledBy: String,
    cancelReason: { type: String, trim: true, maxlength: 300, default: "" },

    createdBy: String,
    updatedBy: String,
    companyId: { type: String, required: true },
    branchId: { type: String, default: "main" },
  },
  { timestamps: true }
);

jobCardSchema.index({ jobNo: 1 }, { unique: true, partialFilterExpression: { jobNo: { $type: "string" } } });
jobCardSchema.index({ status: 1, promisedAt: 1 });
jobCardSchema.index({ vehicleId: 1, createdAt: -1 });
jobCardSchema.index({ customerId: 1, createdAt: -1 });
jobCardSchema.index({ "tasks.assigneeId": 1, status: 1 }); // "my work"
jobCardSchema.index({ invoiceStatus: 1 });
jobCardSchema.index({ claimId: 1 });
jobCardSchema.index({ "delivery.gatePassAt": 1 }); // analysis period
jobCardSchema.index({ createdAt: -1 });

// Branch scoped: a job card belongs to the branch that took the car in, like every other trade document.
jobCardSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.models.JobCard || mongoose.model("JobCard", jobCardSchema);
