const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

/**
 * One row per onboarding or exit checklist ITEM (W6, talent). The plan's own first draft called for
 * reusing CrmActivity directly (D16) - deliberately NOT done: CrmActivity.parentOf() (services/crm/
 * activityService.js) only knows four regarding kinds (lead, opportunity, customer, contact) and has no
 * branch for a staff id, and its own list queries (the CRM's Follow-ups worklist, the Communications log)
 * read the WHOLE collection with no filter narrowing them to CRM-only regarding kinds - so a staff
 * checklist item stored there would either break parentOf's validation or silently show up in a
 * customer-facing communications log. A small model of the SAME shape (a task with an owner and a due
 * day) gets the real benefit - no second task-tracking PARADIGM to learn - without touching a heavily
 * relied-on CRM service this wave did not need to risk.
 */
const staffChecklistSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, default: "main" },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    staffName: { type: String, trim: true, maxlength: 120 },
    listType: { type: String, enum: ["onboarding", "exit"], required: true },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    dueAt: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ }, // a day, organisation calendar
    status: { type: String, enum: ["OPEN", "DONE", "CANCELLED"], default: "OPEN" },
    completedAt: { type: Date, default: null },
    completedBy: { type: String, default: null },
    ownerId: { type: String, default: null },
    ownerName: { type: String, trim: true, default: "" },
    createdBy: { type: String, default: "system" },
  },
  { timestamps: true }
);

staffChecklistSchema.index({ staffId: 1, listType: 1, status: 1 });
staffChecklistSchema.index({ status: 1, dueAt: 1 });
staffChecklistSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.model("StaffChecklistItem", staffChecklistSchema);
