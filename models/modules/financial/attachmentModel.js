const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// A stored file. The bytes live on disk under uploads/attachments (never served statically); this
// row is the access-controlled record. Documents that reference a file carry its id.
const attachmentSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    key: { type: String, required: true, unique: true }, // path under uploads/, generated server-side
    originalName: { type: String, required: true, trim: true, maxlength: 255 },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    uploadedBy: { type: String, default: null },
    // Where it is attached. null until linked.
    ownerType: {
      type: String,
      enum: ["transaction", "voucher", "account", "einvoice", "customer", "vendor", null],
      default: null,
    },
    ownerId: { type: mongoose.Schema.Types.ObjectId, default: null },
    label: { type: String, trim: true, maxlength: 120 },
  },
  { timestamps: true }
);

attachmentSchema.index({ companyId: 1, ownerType: 1, ownerId: 1 });

// Scope every query and write to the organisation in scope (utils/tenantPlugin.js).
attachmentSchema.plugin(tenantPlugin);

module.exports = mongoose.model("Attachment", attachmentSchema);
