const mongoose = require("mongoose");

// A VAT return as it stood when it was finalised: the boxes are copied here so that a later change
// to a document cannot silently restate a return that has been prepared or filed. The live figures
// always come from the documents (services/reports/vatReturnService.js); this is the record.
const boxSchema = new mongoose.Schema(
  { box: String, label: String, amount: { type: Number, default: 0 }, vat: { type: Number, default: 0 } },
  { _id: false }
);

const vatReturnSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    returnNo: { type: String, required: true, trim: true },
    periodFrom: { type: String, required: true }, // Dubai calendar day, YYYY-MM-DD
    periodTo: { type: String, required: true },
    emirate: { type: String, default: "" },
    boxes: [boxSchema],
    totals: {
      outputVat: { type: Number, default: 0 }, // box 12
      recoverableVat: { type: Number, default: 0 }, // box 13
      netPayable: { type: Number, default: 0 }, // box 14
    },
    unclassifiedLines: { type: Number, default: 0 },
    status: { type: String, enum: ["DRAFT", "FINALIZED", "FILED"], default: "DRAFT" },
    notes: { type: String, trim: true, default: "" },
    finalizedAt: Date,
    finalizedBy: String,
    filedAt: Date,
    filedBy: String,
    filingReference: { type: String, trim: true, default: "" }, // the FTA's reference for the filing
    createdBy: String,
  },
  { timestamps: true }
);

vatReturnSchema.index({ companyId: 1, returnNo: 1 }, { unique: true });
vatReturnSchema.index({ companyId: 1, periodFrom: 1, periodTo: 1 });

module.exports = mongoose.model("VATReturn", vatReturnSchema);
