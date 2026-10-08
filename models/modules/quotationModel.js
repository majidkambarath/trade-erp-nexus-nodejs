const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");
const { baseLineFields, chargeSchema, pricingSchema, linkSchema } = require("./salesDocumentParts");

// An offer to a customer. Posts nothing and moves no stock (see utils/salesDocuments.js); when the
// customer says yes it is converted into a DRAFT sales order, which is the invoice.
const quotationSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, required: true },
    // QT-2026-0007 from the number series; a revision adds -R1, -R2 to the same base.
    quotationNo: { type: String, required: true, trim: true },
    revision: { type: Number, default: 0, min: 0 },
    revisionOf: { type: linkSchema(["quotation"]), default: undefined },
    supersededBy: { type: linkSchema(["quotation"]), default: undefined },
    // What it was before a newer revision replaced it, so discarding that revision can put it back.
    statusBeforeSupersede: { type: String, default: null },

    partyId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    date: { type: Date, required: true },
    validUntil: { type: Date, required: true },
    reference: { type: String, trim: true, default: "" }, // the customer's enquiry / RFQ number
    status: { type: String, required: true, default: "DRAFT" },

    items: { type: [new mongoose.Schema(baseLineFields)], default: [] },
    charges: { type: [chargeSchema], default: [] },
    discount: { type: Number, default: 0, min: 0 }, // taken off the VAT-inclusive total
    pricing: { type: pricingSchema, default: undefined },
    totalAmount: { type: Number, required: true, min: 0 },

    terms: { type: String, trim: true, default: "" }, // printed on the offer
    notes: { type: String, trim: true, default: "" }, // internal

    sentAt: { type: Date, default: null },
    acceptedAt: { type: Date, default: null },
    acceptedBy: { type: String, trim: true, default: "" }, // who at the customer, or their LPO reference
    rejectedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true, default: "" },

    convertedTo: { type: linkSchema(["sales_order", "delivery_note"]), default: undefined },
    convertedAt: { type: Date, default: null },

    createdBy: { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

quotationSchema.index({ companyId: 1, branchId: 1, quotationNo: 1 }, { unique: true });
quotationSchema.index({ companyId: 1, status: 1, date: -1 });
quotationSchema.index({ companyId: 1, partyId: 1, date: -1 });
quotationSchema.index({ companyId: 1, "convertedTo.id": 1 }, { sparse: true });
quotationSchema.index({ companyId: 1, createdAt: -1 });

// Scope every query and write to the organisation in scope (utils/tenantPlugin.js).
// documents belong to a branch: a person working in one branch sees only that branch's (utils/tenantPlugin.js)
quotationSchema.plugin(tenantPlugin, { branchScoped: true });

module.exports = mongoose.model("Quotation", quotationSchema);
