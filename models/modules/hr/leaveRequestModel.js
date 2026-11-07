const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

/**
 * A leave request. DRAFT isn't a status here - a request is submitted PENDING and decided from there, the
 * same two-state shape a voucher's approval starts from. `approvals[]` is the EXACT shape Transaction and
 * Voucher already carry (models/modules/transactionModel.js) - a request is the THIRD kind
 * services/core/approvalQueueService.js reads (D13), judged by the same rules.decide a trade document or
 * voucher already is, so it needed no new field to join that queue.
 */
const leaveRequestSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
    branchId: { type: String, default: "main" }, // the employee's branch; head office is "main"
    requestNo: { type: String }, // allocated on submit, the LV series
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    staffName: { type: String, trim: true, maxlength: 120 }, // a snapshot, so the queue needs no join
    leaveTypeId: { type: mongoose.Schema.Types.ObjectId, ref: "LeaveType", required: true },
    leaveTypeName: { type: String, trim: true, maxlength: 80 },
    fromDay: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    toDay: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    reason: { type: String, trim: true, maxlength: 500 },
    status: { type: String, enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"], default: "PENDING" },
    // The exact shape a trade document's approvals already carry - judged by the SAME rules.decide, so the
    // approvals queue's third branch needed no new logic, only a new source to read from (D13).
    approvals: [{ _id: false, by: { type: String }, name: { type: String }, at: { type: Date }, step: { type: Number } }],
    decidedBy: { type: String },
    decidedAt: { type: Date },
    rejectReason: { type: String, trim: true, maxlength: 500 },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String },
    createdBy: { type: String, required: true },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

leaveRequestSchema.index({ requestNo: 1 }, { unique: true, sparse: true });
leaveRequestSchema.index({ staffId: 1, status: 1 });
leaveRequestSchema.index({ status: 1, createdAt: 1 }); // the approvals queue's own listing

leaveRequestSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.model("LeaveRequest", leaveRequestSchema);
