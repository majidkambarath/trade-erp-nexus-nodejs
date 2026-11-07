const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

/**
 * A plain periodic appraisal (W6, D16): a dated record, no scoring algorithm, no calibration workflow.
 * Read against the employee's own EmployeeContract history for context (so a reviewer can see what they
 * were paid when) - that join happens in the service layer, nothing is duplicated onto this document.
 */
const appraisalSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    staffName: { type: String, trim: true, maxlength: 120 },
    periodLabel: { type: String, required: true, trim: true, maxlength: 60 }, // e.g. "2026 annual review", free text on purpose
    reviewDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    reviewerId: { type: String, default: null },
    reviewerName: { type: String, trim: true, maxlength: 120, default: "" },
    strengths: { type: String, trim: true, maxlength: 3000, default: "" },
    improvements: { type: String, trim: true, maxlength: 3000, default: "" },
    goals: { type: String, trim: true, maxlength: 3000, default: "" },
    rating: { type: String, trim: true, maxlength: 40, default: "" }, // free text (e.g. "Exceeds expectations") - no fixed scale imposed
    createdBy: { type: String },
  },
  { timestamps: true }
);

// Organisation-wide, NOT branchScoped: an appraisal belongs to the employee record, which is itself
// branch-scoped (Staff.branchId) - reading it through the employee's own page already narrows correctly,
// and a head-office reviewer appraising a branch employee should not need the branch switcher to do it.
appraisalSchema.index({ staffId: 1, reviewDate: -1 });
appraisalSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.model("Appraisal", appraisalSchema);
