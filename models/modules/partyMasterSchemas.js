const mongoose = require("mongoose");
const { VAT_STATUSES, MAX_CREDIT_DAYS, termsToDays } = require("../../utils/partyMaster");

// The master data customers and vendors share: VAT configuration, credit terms, contacts, bank
// accounts and KYC documents. The legacy flat fields (trnNumber / trnNO, paymentTerms, contactPerson,
// email, phone) stay on the models and are kept in step by services/masters/partyMasterService.js.
const { Schema } = mongoose;

const vatFields = {
  // No schema default: the service decides (registered when a TRN exists, else unregistered), and
  // the JSON output derives it for records saved before this block existed.
  status: { type: String, enum: VAT_STATUSES },
  trn: { type: String, trim: true }, // exactly 15 digits when registered / designated zone; unique per collection when set
  tradeLicenseNo: { type: String, trim: true, default: "" },
};

const creditFields = {
  days: { type: Number, min: 0, max: MAX_CREDIT_DAYS }, // days to pay; paymentTerms is the matching label
};

const contactSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    designation: { type: String, trim: true, maxlength: 100, default: "" },
    email: { type: String, trim: true, lowercase: true, maxlength: 120, default: "" },
    phone: { type: String, trim: true, maxlength: 30, default: "" },
    isPrimary: { type: Boolean, default: false },
  },
  { _id: true }
);

const bankAccountSchema = new Schema(
  {
    bankId: { type: Schema.Types.ObjectId, ref: "BankMaster", default: null },
    bankName: { type: String, trim: true, maxlength: 120, default: "" },
    accountNumber: { type: String, trim: true, default: "" },
    iban: { type: String, trim: true, uppercase: true, default: "" },
    swiftCode: { type: String, trim: true, uppercase: true, default: "" },
    isPrimary: { type: Boolean, default: false },
  },
  { _id: true }
);

const documentSchema = new Schema(
  {
    documentTypeId: { type: Schema.Types.ObjectId, ref: "DocumentType", default: null },
    typeName: { type: String, trim: true, maxlength: 100, default: "" }, // the type's name when the row was saved
    number: { type: String, trim: true, maxlength: 60, default: "" },
    issueDate: { type: Date, default: null },
    expiryDate: { type: Date, default: null },
    attachmentId: { type: Schema.Types.ObjectId, ref: "Attachment", default: null },
    fileName: { type: String, trim: true, default: "" },
    isVerified: { type: Boolean, default: false },
  },
  { _id: true }
);

// toJSON for records saved before the master data existed: they have no vat / credit block, so the
// response derives it from the legacy fields. (Lean queries skip this; they read the legacy fields.)
function jsonTransform(kind) {
  const legacy = kind === "vendor" ? "trnNO" : "trnNumber";
  return (_doc, ret) => {
    const trn = ret.vat?.trn || ret[legacy] || null;
    ret.vat = { status: ret.vat?.status || (trn ? "registered" : "unregistered"), trn, tradeLicenseNo: ret.vat?.tradeLicenseNo || "" };
    ret.credit = { days: ret.credit?.days ?? termsToDays(ret.paymentTerms) };
    return ret;
  };
}

// The TRN lives in two places (vat.trn and the older trnNumber / trnNO). The party services write both
// together; this keeps them equal for code that saves one of them alone, such as the e-invoice
// readiness page editing a customer's trnNumber. A brand-new document built from the older field alone
// is left as it is (the block is derived when it is read), so only the services set vat.trn on create.
function keepTrnInStep(schema, legacy) {
  schema.pre("save", function (next) {
    const legacyChanged = this.isModified(legacy);
    const vatChanged = this.isModified("vat.trn");
    if (legacyChanged && !vatChanged && !this.isNew) {
      const trn = String(this.get(legacy) || "").trim() || undefined;
      this.set("vat.trn", trn);
      const status = this.get("vat.status");
      if (trn && (!status || status === "unregistered")) this.set("vat.status", "registered");
      else if (!trn && (status === "registered" || status === "designated_zone")) this.set("vat.status", "unregistered");
    } else if (vatChanged && !legacyChanged) {
      this.set(legacy, this.get("vat.trn") || null);
    }
    next();
  });
}

module.exports = { vatFields, creditFields, contactSchema, bankAccountSchema, documentSchema, jsonTransform, keepTrnInStep };
