const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

const sequenceSchema = new mongoose.Schema({
  companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  year: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    enum: ["vendor", "customer"],
    required: true,
  },
  usedNumbers: {
    type: [Number],
    default: [],
  },
  deletedNumbers: {
    type: [Number],
    default: [],
  },
});

// One counter row per type FOR EACH ORGANISATION (the plugin puts companyId in front). It used to be one per
// type in the whole database, which left room for exactly two rows in total: a second organisation had nowhere
// to count its customer and vendor ids.
sequenceSchema.index({ type: 1 }, { unique: true });

// Scope every query and write to the organisation in scope, and make every declared index per-organisation.
sequenceSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.model("Sequence", sequenceSchema);
