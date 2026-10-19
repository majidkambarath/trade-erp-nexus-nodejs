// The in-app notification feed: something nobody was told before (Stage 4, 19 Oct 2026 - see CLAUDE.md
// "Automation" audit: "no Notification model, no route, no service, no bell").
//
// One row per CONDITION, not per person. `audience.permission` names who may see it (anyone in the
// organisation holding that permission key, judged the same way the approvals queue judges a document) -
// there is no fan-out write per recipient, because the audience can change as roles do and a stored copy
// per person would drift. `dedupeKey` is unique per organisation, so a background check that runs every
// few minutes re-detecting the same condition (an item still below its reorder level) never creates a
// second row for it - it only touches `occurredAt`. See utils/notifications.js for the create/touch/reopen
// rule and services/core/notificationService.js for how it is applied.
//
// Deliberately no `branchId` in this first slice: the one trigger built so far (low stock) is
// organisation-wide, like the stock it watches (CLAUDE.md: "stock is not held per branch"). A future
// branch-scoped trigger (an overdue invoice, say) can add the field then - tenantPlugin would otherwise
// auto-stamp it from the ambient branch on every write, which is wrong for a condition with no branch of
// its own.
const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

const notificationSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    kind: { type: String, required: true, trim: true }, // "low_stock", more as triggers are added
    severity: { type: String, enum: ["info", "warning", "critical"], default: "info" },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, trim: true, maxlength: 500, default: "" },
    link: { type: String, trim: true, default: null },
    dedupeKey: { type: String, required: true, trim: true },
    audience: {
      permission: { type: String, default: null },
    },
    readBy: { type: [String], default: [] },
    occurredAt: { type: Date, default: Date.now }, // last time the condition was (re)detected
    resolvedAt: { type: Date, default: null }, // set once the condition is no longer true
  },
  { timestamps: true }
);

notificationSchema.index({ companyId: 1, dedupeKey: 1 }, { unique: true });
notificationSchema.index({ companyId: 1, resolvedAt: 1, createdAt: -1 });

notificationSchema.plugin(tenantPlugin);

module.exports = mongoose.models.Notification || mongoose.model("Notification", notificationSchema);
