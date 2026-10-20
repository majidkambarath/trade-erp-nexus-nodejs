// A call, a visit, a meeting, a message or a note: the contact itself, and - when it is still open - the next action
// somebody owes. This is what the follow-up worklist and the notification feed read.
//
// Named CrmActivity, not Activity, because `ActivityLog` is already the audit trail (models/modules/financial/
// activityLogModel.js). That one records what the SYSTEM was told to do; this one records what a person did with a
// customer. They are never mixed.
//
// `dedupeKey` is how an automatic follow-up is created at most once per stage entry: the automation sets it, a person
// never does, and the unique index (per organisation, via the plugin) makes a replay a no-op instead of a second
// reminder. The shape is borrowed from models/core/notificationModel.js, but the writer is a conditional upsert in one
// session, not a find-then-create.
const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");
const crm = require("../../../utils/crm");

const crmActivitySchema = new mongoose.Schema(
  {
    kind: { type: String, enum: crm.ACTIVITY_KINDS, required: true },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    notes: { type: String, trim: true, maxlength: 2000, default: "" },

    // What it is about. One shape for all three so a timeline can be assembled with one query per screen.
    regarding: {
      kind: { type: String, enum: crm.REGARDING_KINDS, required: true },
      id: { type: mongoose.Schema.Types.ObjectId, required: true },
    },
    // Kept beside `regarding` so the customer's own CRM tab needs no join through the deal.
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },

    ownerId: { type: String, default: null },
    ownerName: { type: String, trim: true, default: "" },

    dueAt: { type: String, default: null }, // a day, "YYYY-MM-DD", in the organisation's zone
    status: { type: String, enum: crm.ACTIVITY_STATUS, default: "OPEN" },
    completedAt: { type: Date, default: null },
    completedBy: { type: String, default: null },
    outcome: { type: String, enum: [...crm.OUTCOMES, null], default: null },

    auto: { type: Boolean, default: false }, // the automation left it, not a person
    dedupeKey: { type: String, default: null },

    createdBy: { type: String, default: "system" },
    updatedBy: { type: String, default: null },

    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
    branchId: { type: String, default: "main" }, // the branch; head office is "main"
  },
  { timestamps: true }
);

crmActivitySchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } });
crmActivitySchema.index({ "regarding.id": 1, status: 1, dueAt: 1 });
crmActivitySchema.index({ ownerId: 1, status: 1, dueAt: 1 });
crmActivitySchema.index({ status: 1, dueAt: 1 });
crmActivitySchema.index({ customerId: 1, createdAt: -1 });
crmActivitySchema.index({ createdAt: -1 });

crmActivitySchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.models.CrmActivity || mongoose.model("CrmActivity", crmActivitySchema);
