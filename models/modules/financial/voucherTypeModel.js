const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");
const V = require("../../../utils/voucherTypes");

// How a kind of document is named and numbered. One row per series, seeded from utils/voucherTypes.js
// SEED on first read (services/core/voucherTypeService.js), so an organisation already trading keeps
// every number it has issued.
//
// An organisation-wide MASTER, like FiscalYear, TaxCode and CompanySettings: `tenantPlugin` with no
// `branchScoped`. Branch behaviour is a FIELD here, not a scope - a branch user has to read the same
// configuration head office set, and only the counter and the documents are per branch.
const branchPrefixSchema = new mongoose.Schema(
  {
    branchId: { type: String, required: true, lowercase: true, trim: true },
    prefix: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z0-9]{1,10}$/ },
  },
  { _id: false }
);

const voucherTypeSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },

    // Identity. `key` is the series code the generator is called with ("RV"), and a variant invents its
    // own ("PCV"). `postsAs` is what the ENGINE sees - a variant carries its parent's value, which is
    // why none of the code that compares voucherType against "payment" has to know variants exist.
    key: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z0-9]{2,8}$/ },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    parentKey: { type: String, default: null, uppercase: true, trim: true },
    kind: { type: String, required: true, enum: V.KINDS },
    postsAs: { type: String, default: null, trim: true },

    // The number's shape. Defaults are today's hardcoded behaviour.
    prefix: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z0-9]{1,10}$/ },
    suffix: { type: String, default: "", uppercase: true, trim: true, match: /^[A-Z0-9]{0,6}$/ },
    separator: { type: String, default: "-", enum: V.SEPARATORS },
    includeYear: { type: Boolean, default: true },
    numberLength: { type: Number, default: 4, min: 3, max: 10 },

    // When the counter restarts, and how the branch appears in front.
    resetPolicy: { type: String, default: "yearly", enum: V.RESET_POLICIES },
    branchPrefix: { type: String, default: "auto", enum: ["auto", "none"] },
    branchPrefixes: { type: [branchPrefixSchema], default: undefined },

    // How a number is given out, and whether a deleted one may be handed to the next document.
    // `statutory` comes from the seed and is never editable: it is what forbids reuse on a document we
    // issue bearing tax (utils/voucherTypes.js mayReuse).
    method: { type: String, default: "auto", enum: V.METHODS },
    allowReuse: { type: Boolean, default: false },
    statutory: { type: Boolean, default: false },

    isSystem: { type: Boolean, default: false }, // seeded: editable, never deletable
    isActive: { type: Boolean, default: true },
    createdBy: { type: String, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true }
);

// Unique per organisation. The name is case-insensitively unique too, so two types cannot be told apart
// only by their capitals on a screen.
voucherTypeSchema.index({ companyId: 1, key: 1 }, { unique: true });
voucherTypeSchema.index({ companyId: 1, name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });
voucherTypeSchema.index({ companyId: 1, parentKey: 1 });

voucherTypeSchema.plugin(tenantPlugin);

module.exports = mongoose.models.VoucherType || mongoose.model("VoucherType", voucherTypeSchema);
