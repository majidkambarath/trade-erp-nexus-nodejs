const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// An insurance claim: the fork of §1.2 the garage's own flow takes for accident work (utils/garage.js) - the
// estimate goes to the insurer instead of (or alongside) the customer, a surveyor inspects the car before
// anything starts, and the insurer's approval splits the bill between what it pays and what the customer
// pays instead (the excess, any depreciation on new parts, and anything simply not approved).
//
// DRAFT -> SUBMITTED -> SURVEYED -> APPROVED | PARTLY_APPROVED | REJECTED -> INVOICED. One claim per job
// card (jobCardId is single, not an array - the simpler, more common case; a job split across two insurers
// is not built). Rules: utils/insuranceClaims.js. Service: services/garage/insuranceClaimService.js.
const id = mongoose.Schema.Types.ObjectId;

const insuranceClaimSchema = new mongoose.Schema(
  {
    claimNo: { type: String, trim: true }, // given when created; a draft has none (partial index below)
    status: {
      type: String,
      enum: ["DRAFT", "SUBMITTED", "SURVEYED", "APPROVED", "PARTLY_APPROVED", "REJECTED", "INVOICED"],
      default: "DRAFT",
    },

    insurerId: { type: id, ref: "Customer", required: true }, // a Customer flagged isInsurer: true
    insurer: { name: String },
    insurerClaimNo: { type: String, trim: true, maxlength: 60, default: "" }, // the insurer's OWN reference
    policyNo: { type: String, trim: true, maxlength: 60, required: true },
    policyHolder: { type: String, trim: true, maxlength: 150, default: "" },

    jobCardId: { type: id, ref: "JobCard", required: true },
    vehicleId: { type: id, ref: "Vehicle" },

    accidentDate: Date,
    reportedDate: Date,
    policeReportNo: { type: String, trim: true, maxlength: 60, default: "" },

    submittedAt: Date,

    survey: {
      surveyorName: { type: String, trim: true, maxlength: 150 },
      company: { type: String, trim: true, maxlength: 150, default: "" },
      visitedAt: Date,
      notes: { type: String, trim: true, maxlength: 1000, default: "" },
      photos: { type: [String], default: [] }, // Attachment ids (AttachmentService, ownerType "claim")
    },

    approval: {
      lpoNo: { type: String, trim: true, maxlength: 60, default: "" },
      approvedAt: Date,
      approvedAmount: { type: Number, min: 0, default: 0 },
      note: { type: String, trim: true, maxlength: 300, default: "" },
    },

    // What the customer pays instead of the insurer - see utils/insuranceClaims.js splitBill, the one place
    // the arithmetic lives. `depreciablePartsAmount` is the value of the NEW parts the percentage applies to.
    deductions: {
      excess: { type: Number, min: 0, default: 0 },
      partsDepreciationPct: { type: Number, min: 0, max: 100, default: 0 },
      depreciablePartsAmount: { type: Number, min: 0, default: 0 },
    },

    // The result of splitBill at the moment invoices were raised - kept so the claim's own screen can show
    // the split without recomputing it from a job card that may have since moved on.
    split: {
      insurerAmount: Number,
      customerAmount: Number,
    },

    invoices: {
      type: [
        {
          transactionId: { type: id, ref: "Transaction" },
          no: String,
          billTo: { type: String, enum: ["insurer", "customer"] },
          amount: Number,
          status: String,
        },
      ],
      default: [],
    },

    rejectedAt: Date,
    rejectReason: { type: String, trim: true, maxlength: 300, default: "" },

    notes: { type: String, trim: true, maxlength: 1000, default: "" },
    createdBy: String,
    updatedBy: String,
    companyId: { type: String, required: true },
    branchId: { type: String, default: "main" },
  },
  { timestamps: true }
);

insuranceClaimSchema.index({ claimNo: 1 }, { unique: true, partialFilterExpression: { claimNo: { $type: "string" } } });
insuranceClaimSchema.index({ status: 1, submittedAt: 1 });
insuranceClaimSchema.index({ jobCardId: 1 }, { unique: true }); // one claim per job card; jobCardId is required, so no partial filter is needed
insuranceClaimSchema.index({ insurerId: 1, createdAt: -1 });
insuranceClaimSchema.index({ createdAt: -1 });

// Branch scoped: a claim belongs to the branch that took the job in, like the job card itself.
insuranceClaimSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.models.InsuranceClaim || mongoose.model("InsuranceClaim", insuranceClaimSchema);
