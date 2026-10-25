const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// A stored file. This row is the access-controlled record; `storage` says where the bytes are.
//
// `cloudinary` is where new files go: a Render instance's disk is wiped by every deploy and restart, so files
// written there vanished while these rows survived, and the client clicked a document that was no longer
// anywhere. The asset is uploaded PRIVATE, so its plain address answers 401 and only a short-lived signed
// address built with the api secret opens it - it is reachable only through the download route, and only after
// the organisation has been checked.
//
// `disk` is the old home (uploads/attachments, never served statically) and the default, so every row written
// before this keeps being read from where it actually is. It is still used where Cloudinary is not configured:
// a laptop with no account, and the tests.
const attachmentSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    key: { type: String, required: true, unique: true }, // year/<random>.<ext>, generated server-side
    // "disk" is the default on purpose: a row written before this field existed is on disk, and reading it as
    // anything else would look for bytes that were never there.
    storage: { type: String, enum: ["disk", "cloudinary"], default: "disk" },
    publicId: { type: String, default: null }, // the Cloudinary asset id; null for a file on disk
    originalName: { type: String, required: true, trim: true, maxlength: 255 },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    uploadedBy: { type: String, default: null },
    // Where it is attached. null until linked.
    ownerType: {
      type: String,
      enum: ["transaction", "voucher", "account", "einvoice", "customer", "vendor", "lead", "opportunity", "jobcard", "vehicle", null],
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
