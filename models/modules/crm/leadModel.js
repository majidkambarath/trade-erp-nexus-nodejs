// An enquiry from somebody who is not a customer yet: the one thing the ERP had nowhere to put. It lives here until it
// is qualified, at which point it becomes a real Customer (with its ledger account) and an Opportunity - see
// services/crm/leadService.js `qualify`. Quotation.partyId still points only at a Customer, deliberately: nothing in
// the engine had to learn about leads.
//
// Branch scoped: an enquiry belongs to the branch that took it, like every other document. The masters it eventually
// creates (the customer) stay organisation-wide, as masters do.
const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");
const crm = require("../../../utils/crm");

const leadSchema = new mongoose.Schema(
  {
    // No `required` and no field-level unique: a lead is numbered when it is saved, and the partial index below is what
    // makes the number unique per organisation (utils/tenantPlugin.js leadIndexes puts companyId in front of it).
    leadNo: { type: String, trim: true },

    name: { type: String, required: true, trim: true, maxlength: 150 },
    company: { type: String, trim: true, maxlength: 150, default: "" },
    phone: { type: String, trim: true, maxlength: 40, default: "" },
    email: { type: String, trim: true, lowercase: true, maxlength: 150, default: "" },
    city: { type: String, trim: true, maxlength: 80, default: "" },

    source: { type: String, enum: crm.LEAD_SOURCES, default: "other" },
    sourceNote: { type: String, trim: true, maxlength: 200, default: "" }, // "Gulfood stand 4B", the referrer's name
    interest: { type: String, trim: true, maxlength: 500, default: "" }, // what they asked for, in their words
    expectedValue: { type: Number, default: 0, min: 0 },

    status: { type: String, enum: crm.LEAD_STATUS, default: "NEW" },
    ownerId: { type: String, default: null }, // the Admin whose job it is to chase this
    ownerName: { type: String, trim: true, default: "" },

    // Derived by utils/crm.js `leadScore` and stored so a list can sort by it without recomputing per row. It is
    // refreshed whenever anything about the lead changes, never trusted from a request body.
    score: { type: Number, default: 0, min: 0, max: 100 },
    band: { type: String, enum: ["hot", "warm", "cold"], default: "cold" },

    contactCount: { type: Number, default: 0, min: 0 }, // how many follow-ups have been completed against it
    lastActivityAt: { type: Date, default: null },
    lastActivityDay: { type: String, default: null }, // "YYYY-MM-DD" in the organisation's zone: what the pure rules read
    nextActionAt: { type: String, default: null }, // the day the earliest open follow-up falls due

    // Where it ended up. Both are set by `qualify`, in one transaction with the customer and the deal.
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    opportunityId: { type: mongoose.Schema.Types.ObjectId, ref: "Opportunity", default: null },
    convertedAt: { type: Date, default: null },

    lostReason: { type: String, enum: [...crm.LOST_REASONS, null], default: null },
    lostNote: { type: String, trim: true, maxlength: 300, default: "" },
    lostAt: { type: Date, default: null },

    notes: { type: String, trim: true, maxlength: 2000, default: "" },

    createdBy: { type: String, default: "system" },
    updatedBy: { type: String, default: null },

    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
    branchId: { type: String, default: "main" }, // the branch; head office is "main"
  },
  { timestamps: true }
);

leadSchema.index({ leadNo: 1 }, { unique: true, partialFilterExpression: { leadNo: { $type: "string" } } });
leadSchema.index({ status: 1, createdAt: -1 });
leadSchema.index({ ownerId: 1, status: 1 });
leadSchema.index({ phone: 1 });
leadSchema.index({ email: 1 });
leadSchema.index({ createdAt: -1 });

leadSchema.plugin(tenantPlugin, { leadIndexes: true, branchScoped: true });

module.exports = mongoose.models.Lead || mongoose.model("Lead", leadSchema);
