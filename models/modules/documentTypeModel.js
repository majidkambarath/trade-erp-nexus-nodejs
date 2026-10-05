const mongoose = require("mongoose");

// A kind of KYC document a customer or vendor can hold (trade licence, Emirates ID...). It says
// whether the document expires and how long its number may be, so the party form can check both.
// Unique per company; the defaults are created on first use (services/masters/documentTypeService.js).
const documentTypeSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    branchId: { type: String, default: "main" },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 12, match: /^[A-Z0-9_]+$/ },
    requiresExpiry: { type: Boolean, default: false },
    minLength: { type: Number, default: null, min: 0, max: 60 }, // characters in the document number
    maxLength: { type: Number, default: null, min: 0, max: 60 },
    isActive: { type: Boolean, default: true },
    isSystem: { type: Boolean, default: false }, // a seeded default: it can be edited or switched off, not deleted
  },
  { timestamps: true }
);

// Case-insensitive names, so "passport" and "Passport" cannot both exist.
documentTypeSchema.index({ companyId: 1, name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });
documentTypeSchema.index({ companyId: 1, code: 1 }, { unique: true });

module.exports = mongoose.models.DocumentType || mongoose.model("DocumentType", documentTypeSchema);
