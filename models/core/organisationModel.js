// An organisation: one customer of the product. This is the tenant registry, so it is NOT scoped by the
// tenant plugin (it has no companyId: its `code` IS the companyId stamped on every other record).
//
// What it holds is what the DEVELOPER controls: who the customer is, which plan they are on, which
// optional features are switched on for them, their limits and when their subscription ends. Their own
// company details (letterhead, TRN, bank details) stay in CompanySettings, edited by the customer.
const mongoose = require("mongoose");
const { PLAN_CODES, FEATURE_KEYS, LIMIT_KEYS } = require("../../utils/plans");

// Lower-case letters, digits and hyphens; not starting or ending with a hyphen. It becomes a key in every
// collection and may appear in a URL, so it stays boring on purpose.
const CODE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const RESERVED_CODES = ["platform", "admin", "system", "api", "root", "www", "null", "undefined", "tenant", "organisation", "organization"];

const featureOverrides = {
  type: mongoose.Schema.Types.Mixed,
  default: {},
  validate: {
    validator: (v) => v && typeof v === "object" && !Array.isArray(v) && Object.entries(v).every(([k, val]) => FEATURE_KEYS.includes(k) && typeof val === "boolean"),
    message: `featureOverrides may only switch known features on or off (${FEATURE_KEYS.join(", ")})`,
  },
};
const limitOverrides = {
  type: mongoose.Schema.Types.Mixed,
  default: {},
  validate: {
    validator: (v) => v && typeof v === "object" && !Array.isArray(v) && Object.entries(v).every(([k, val]) => LIMIT_KEYS.includes(k) && (val === null || (Number.isInteger(val) && val >= 0))),
    message: `limitOverrides may only set known limits to a whole number or null for unlimited (${LIMIT_KEYS.join(", ")})`,
  },
};

const organisationSchema = new mongoose.Schema(
  {
    code: {
      type: String, required: true, unique: true, lowercase: true, trim: true, minlength: 2, maxlength: 32,
      validate: [
        { validator: (v) => CODE_RE.test(v), message: "The code may contain only lower-case letters, digits and hyphens, and cannot start or end with a hyphen" },
        { validator: (v) => !RESERVED_CODES.includes(v), message: "That code is reserved" },
      ],
    },
    legalName: { type: String, required: true, trim: true, maxlength: 160 },
    tradeName: { type: String, trim: true, maxlength: 160 },
    country: { type: String, required: true, uppercase: true, trim: true, match: [/^[A-Z]{2}$/, "Country must be a two-letter code, for example AE"] },
    baseCurrency: { type: String, required: true, uppercase: true, trim: true, match: [/^[A-Z]{3}$/, "Currency must be a three-letter code, for example AED"] },
    timezone: { type: String, required: true, trim: true },

    // trial and active behave alike; suspended and closed block the organisation outright (utils/plans.js).
    status: { type: String, enum: ["trial", "active", "suspended", "closed"], default: "trial" },
    planCode: { type: String, required: true, enum: PLAN_CODES },
    featureOverrides,
    limitOverrides,
    subscription: {
      startsAt: { type: Date, default: Date.now },
      endsAt: { type: Date, default: null }, // the END of the last paid day; null = never expires
      graceDays: { type: Number, default: 0, min: 0, max: 90 },
      // block: after the grace period nobody can use it. readonly: they can sign in and read, not post.
      onExpiry: { type: String, enum: ["block", "readonly"], default: "block" },
    },

    // What setting the organisation up has finished, so a half-provisioned one is visible, not silent.
    provisioning: { type: mongoose.Schema.Types.Mixed, default: {} },

    createdBy: { type: String, default: null }, // the platform user who made it
    notes: { type: String, trim: true, maxlength: 1000 },
  },
  { timestamps: true }
);

organisationSchema.index({ status: 1 });

const Organisation = mongoose.models.Organisation || mongoose.model("Organisation", organisationSchema);
module.exports = Organisation;
module.exports.CODE_RE = CODE_RE;
module.exports.RESERVED_CODES = RESERVED_CODES;
