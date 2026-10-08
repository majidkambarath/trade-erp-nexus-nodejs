// The currencies an organisation may keep its books in. Pure data.
//
// Only two-decimal currencies are offered. Money is rounded to two places throughout the pricing and
// ledger code (utils/pricing.js and most of the services), so a three-decimal currency such as the Kuwaiti
// dinar would be silently rounded wrong - the worst kind of error in a ledger. They are refused with a
// reason, not hidden, so the limit is visible. Lifting it is a project of its own.
const SUPPORTED = {
  AED: { name: "UAE Dirham", symbol: "AED" },
  SAR: { name: "Saudi Riyal", symbol: "SAR" },
  QAR: { name: "Qatari Riyal", symbol: "QAR" },
  USD: { name: "US Dollar", symbol: "$" },
  EUR: { name: "Euro", symbol: "\u20ac" },
  GBP: { name: "Pound Sterling", symbol: "\u00a3" },
  INR: { name: "Indian Rupee", symbol: "\u20b9" },
  PKR: { name: "Pakistani Rupee", symbol: "PKR" },
  EGP: { name: "Egyptian Pound", symbol: "EGP" },
  BDT: { name: "Bangladeshi Taka", symbol: "BDT" },
  LKR: { name: "Sri Lankan Rupee", symbol: "LKR" },
  PHP: { name: "Philippine Peso", symbol: "PHP" },
  TRY: { name: "Turkish Lira", symbol: "TRY" },
  ZAR: { name: "South African Rand", symbol: "ZAR" },
  CAD: { name: "Canadian Dollar", symbol: "CAD" },
  AUD: { name: "Australian Dollar", symbol: "AUD" },
  SGD: { name: "Singapore Dollar", symbol: "SGD" },
  CNY: { name: "Chinese Yuan", symbol: "CNY" },
};

// Real currencies that use three decimals, listed so the refusal can name the reason.
const THREE_DECIMAL = ["KWD", "BHD", "OMR", "JOD", "TND", "LYD", "IQD"];

const isSupportedBase = (code) => Object.prototype.hasOwnProperty.call(SUPPORTED, String(code || "").toUpperCase());
const isThreeDecimal = (code) => THREE_DECIMAL.includes(String(code || "").toUpperCase());

// The row to seed into the currency master as the base: { code, name, symbol, decimals, isBase, isActive }.
function baseCurrencyRow(code) {
  const c = String(code || "").toUpperCase();
  if (!isSupportedBase(c)) return null;
  return { code: c, name: SUPPORTED[c].name, symbol: SUPPORTED[c].symbol, decimals: 2, isBase: true, isActive: true };
}

const list = () => Object.entries(SUPPORTED).map(([code, v]) => ({ code, ...v, decimals: 2 }));

module.exports = { SUPPORTED, THREE_DECIMAL, isSupportedBase, isThreeDecimal, baseCurrencyRow, list };
