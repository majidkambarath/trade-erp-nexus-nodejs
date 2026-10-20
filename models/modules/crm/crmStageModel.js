// The organisation's own pipeline. This is the configuration the automation runs on: `advanceOn` names the event that
// moves a deal INTO this stage, `followUpDays` how soon the next action falls due once it is here, `staleDays` how long
// it may stand with nothing happening. Changing these changes the behaviour, which is the whole of the "built-in
// automation with a settings screen" decision - there is no rule builder, because the pipeline IS the rules.
//
// A MASTER, like the chart of accounts and the tax codes: organisation-wide, not branch scoped. Every branch sells
// through the same stages; what differs is the deals on them. Seeded once from utils/crm.js STARTER_STAGES by
// services/crm/crmSetupService.js `ensureStarter`, the same lazy idempotent shape as TaxCodeService.ensureStarter.
const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");
const crm = require("../../../utils/crm");

const crmStageSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 40 },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    order: { type: Number, required: true, min: 1 },
    probability: { type: Number, default: 0, min: 0, max: 100 },
    advanceOn: { type: String, enum: [...crm.EVENTS, null], default: null },
    followUpDays: { type: Number, default: 0, min: 0, max: 365 },
    staleDays: { type: Number, default: 0, min: 0, max: 365 },
    type: { type: String, enum: crm.STAGE_TYPES, default: "open" },

    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  },
  { timestamps: true }
);

crmStageSchema.index({ key: 1 }, { unique: true });
crmStageSchema.index({ order: 1 });

crmStageSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.models.CrmStage || mongoose.model("CrmStage", crmStageSchema);
