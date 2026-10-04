const mongoose = require("mongoose");

const CATEGORIES = ["ASSET", "LIABILITY", "INCOME", "EXPENSE", "EQUITY"];

// A group says what KIND of account something is. Its category decides how a balance is read
// (see utils/accounting.js naturalBalance), which is what makes Trial Balance, Balance Sheet
// and P&L correct. Groups form a tree.
const accountGroupSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    prefix: { type: String, required: true, uppercase: true, trim: true, match: /^[A-Z0-9]{1,5}$/ },
    category: { type: String, enum: CATEGORIES, required: true },
    // High-water mark for minting account codes (PREFIX0001, PREFIX0002, ...).
    lastAccountSeq: { type: Number, default: 0, min: 0 },
    parentGroup: { type: mongoose.Schema.Types.ObjectId, ref: "AccountGroup", default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

accountGroupSchema.index({ companyId: 1, name: 1 }, { unique: true });
accountGroupSchema.index({ companyId: 1, prefix: 1 }, { unique: true });
accountGroupSchema.index({ companyId: 1, parentGroup: 1 });

const AccountGroup = mongoose.model("AccountGroup", accountGroupSchema);
AccountGroup.CATEGORIES = CATEGORIES;
module.exports = AccountGroup;
