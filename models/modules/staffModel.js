const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");

const staffSchema = new mongoose.Schema({
  companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
  staffId: { type: String, required: true }, // unique within an organisation: see below
  name: { type: String, required: true, trim: true },
  designation: { type: String, required: true, trim: true },
  contactNo: {
    type: String,
    required: true,
    trim: true,
    match: /^\+?\d{10,15}$/,
  },
  idNo: { type: String, required: true, trim: true }, // unique within an organisation: see below
  joiningDate: { type: Date, required: true },
  idProof: { type: String }, // Cloudinary public_id
  idProofUrl: { type: String }, // Cloudinary URL
  addressProof: { type: String }, // Cloudinary public_id
  addressProofUrl: { type: String }, // Cloudinary URL
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    default: "Active",
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  createdBy: { type: String, required: true },
});

staffSchema.index({ staffId: 1 }, { unique: true }); // unique within an organisation
staffSchema.index({ idNo: 1 }, { unique: true }); // unique within an organisation

// Scope every query and write to the organisation in scope, and make every declared index per-organisation.
staffSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.model("Staff", staffSchema);
