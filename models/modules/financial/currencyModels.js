const mongoose = require("mongoose");
const tenantPlugin = require("../../../utils/tenantPlugin");

// ---------------------------------------------------------------------------------------------
// Currency master. One row per currency the company deals in; exactly one is the base currency
// (AED for the first client), in which the whole ledger is kept. A foreign currency is usable on a
// voucher only while it is active AND has a rate on or before the voucher date.
// ---------------------------------------------------------------------------------------------
const currencySchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    code: { type: String, required: true, trim: true, uppercase: true, match: [/^[A-Z]{3}$/, "A currency code is three letters (ISO 4217)"] },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    symbol: { type: String, trim: true, maxlength: 8, default: "" },
    // Minor-unit places of the currency: 2 for most, 3 for KWD / BHD / OMR, 0 for JPY.
    decimals: { type: Number, default: 2, min: 0, max: 4, validate: { validator: Number.isInteger, message: "Decimals must be a whole number" } },
    isBase: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);
currencySchema.index({ companyId: 1, code: 1 }, { unique: true });

// ---------------------------------------------------------------------------------------------
// Exchange-rate history. rate = base units per 1 foreign unit (USD 1 = AED 3.6725), > 0, at most
// 6 decimal places. effectiveDate is a Dubai calendar day, stored as 00:00 Dubai. A rate applies
// from its day until the next one. Rows are append-only: a correction for the same day replaces
// that day's row, and the replaced value is kept in the audit log.
// ---------------------------------------------------------------------------------------------
const exchangeRateSchema = new mongoose.Schema(
  {
    companyId: { type: String, required: true },
    code: { type: String, required: true, trim: true, uppercase: true, match: /^[A-Z]{3}$/ },
    rate: { type: Number, required: true, validate: { validator: (v) => Number.isFinite(v) && v > 0, message: "A rate must be greater than zero" } },
    effectiveDate: { type: Date, required: true },
    source: { type: String, enum: ["manual", "cbuae", "import"], default: "manual" },
    note: { type: String, trim: true, maxlength: 200, default: "" },
    createdBy: { type: String, default: null },
  },
  { timestamps: true }
);
exchangeRateSchema.index({ companyId: 1, code: 1, effectiveDate: 1 }, { unique: true });

// Scope every query and write to the organisation in scope (utils/tenantPlugin.js).
currencySchema.plugin(tenantPlugin);
exchangeRateSchema.plugin(tenantPlugin);

const Currency = mongoose.models.Currency || mongoose.model("Currency", currencySchema);
const ExchangeRate = mongoose.models.ExchangeRate || mongoose.model("ExchangeRate", exchangeRateSchema);

module.exports = { Currency, ExchangeRate };
