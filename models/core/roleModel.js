// A role an organisation made for itself ("Sales supervisor"): a name, a rank and a list of permissions. The built-in
// roles are not here - they are code (utils/permissions.js) and cannot be edited or deleted. A person holds a role
// through Admin.roleKey, which names either kind.
//
// Scoped to its organisation like everything else, so two customers may each have a role called "supervisor" and
// neither can see, use or change the other's.
const mongoose = require("mongoose");
const tenantPlugin = require("../../utils/tenantPlugin");
const { isBuiltIn, unknownKeys } = require("../../utils/permissions");

const roleSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true }, // the organisation (utils/tenantPlugin.js)
    key: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      validate: [
        { validator: (v) => /^[a-z][a-z0-9_]{1,29}$/.test(v), message: "A role key is 2 to 30 lower-case letters, digits or underscores, starting with a letter" },
        { validator: (v) => !isBuiltIn(v), message: "That key belongs to a built-in role" },
      ],
    },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 300, default: "" },
    // What the role names. Stored as typed and expanded when read (utils/permissions.js expand), so a permission added
    // to the catalogue later never needs this to be rewritten.
    permissions: {
      type: [String],
      default: [],
      validate: { validator: (v) => unknownKeys(v).length === 0, message: "A role may only name permissions that exist" },
    },
    // Who may manage whom is decided by rank: a person manages only those below their own. A custom role sits between
    // the viewer and the administrator (10 to 90); the owner's 100 is not available.
    rank: { type: Number, required: true, min: 10, max: 90, validate: { validator: Number.isInteger, message: "A rank is a whole number" } },
    // The largest document a person in this role may approve, in the organisation's base currency. Empty (null) = no limit.
    // Built-in roles have none. Only the Approve actions are affected (utils/approvalRules.js).
    approvalLimit: { type: Number, min: 0, default: null },
    isActive: { type: Boolean, default: true },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true }
);

roleSchema.index({ companyId: 1, key: 1 }, { unique: true });
roleSchema.plugin(tenantPlugin, { leadIndexes: true });

module.exports = mongoose.models.Role || mongoose.model("Role", roleSchema);
