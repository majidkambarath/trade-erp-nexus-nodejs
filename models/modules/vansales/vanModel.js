const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// A van: an organisation-wide master (a van is the organisation's, whichever branch a trip is raised in), like a
// vehicle in the garage module. It names the salesman who normally drives it, the route it normally runs, and the
// chart account the money it takes in goes through: a cash account of its own ("Van Cash - <code>") under the Cash
// group, so what the van took is the account's balance and settling is a plain transfer of it.
const vanSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 20 },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    plate: { type: String, trim: true, uppercase: true, maxlength: 20, default: "" },
    // an Admin id (the same reference process orders and job cards use) and the name at the time it was set
    salesmanId: { type: String, default: "" },
    salesmanName: { type: String, default: "" },
    defaultRouteId: { type: mongoose.Schema.Types.ObjectId, ref: "VanRoute", default: null },
    cashAccountId: { type: mongoose.Schema.Types.ObjectId, ref: "LedgerAccount", default: null },
    // the most cash the van should carry before it hands some in (null = no limit): a warning, never a refusal
    cashLimit: { type: Number, min: 0, default: null },
    active: { type: Boolean, default: true },

    createdBy: String,
    updatedBy: String,
    companyId: { type: String, required: true },
  },
  { timestamps: true }
);

// declared with schema.index, not field-level unique, so the tenant plugin puts companyId in front of it
vanSchema.index({ code: 1 }, { unique: true });
vanSchema.index({ salesmanId: 1, active: 1 });

vanSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.models.Van || mongoose.model("Van", vanSchema);
