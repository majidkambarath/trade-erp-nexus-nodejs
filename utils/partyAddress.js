// A customer's or vendor's address country and emirate (pure). The address itself stays one free-text box; what a document, the
// VAT return's split by emirate and a future e-invoice need is the COUNTRY and, in the UAE, the EMIRATE, held as fields of their own.
//
// Not part of utils/partyMaster.js on purpose: that module is mirrored line for line in zarvia-platform, and this adds a field, not a
// rule the mirror has to agree on.

const EMIRATES = ["Abu Dhabi", "Dubai", "Sharjah", "Ajman", "Umm Al Quwain", "Ras Al Khaimah", "Fujairah"];
const DEFAULT_COUNTRY = "AE";

const AppError = require("./AppError");
const { normaliseState } = require("./gstStates");

const bad = (message, code) => new AppError(message, 400, code);
const blank = (v) => v === undefined || v === null || String(v).trim() === "";

// "Ras al khaimah" -> "Ras Al Khaimah"; anything that is not one of the seven -> null
const emirateOf = (text) => {
  const key = String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  return EMIRATES.find((e) => e.toLowerCase() === key) || null;
};

/**
 * What a request that names a country or an emirate means for the party, or null when it names neither (a record saved before
 * these fields existed, or a caller that never heard of them, is left exactly as it was).
 *   { country: "AE", emirate: "Dubai" }   the UAE needs one of the seven emirates
 *   { country: "IN", emirate: null }      any other country has no emirate, whatever was sent
 * `existing` is the stored party on an update: a request that sends only the emirate is judged against the stored country, and
 * one that sends only the country keeps the stored emirate when the country is still the UAE.
 */
function resolveAddress({ country, emirate, stateCode } = {}, existing) {
  if (country === undefined && emirate === undefined && stateCode === undefined) return null;
  const stored = String(existing?.country || "").toUpperCase();
  // a GST state only means something in India, so a request that names one and no country is an Indian address
  const fallback = stored || (!blank(stateCode) ? "IN" : DEFAULT_COUNTRY);
  const code = blank(country) ? fallback : String(country).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw bad("Choose the country from the list", "INVALID_COUNTRY");
  // India: the GST state (code "27", number or name). Elsewhere there is none, and one that was stored is cleared.
  const state = () => {
    if (code === "IN") {
      const typed = stateCode === undefined ? existing?.stateCode : stateCode;
      const found = normaliseState(typed);
      if (found === undefined) throw bad(`"${String(typed).trim()}" is not a GST state or union territory`, "INVALID_STATE");
      return stateCode === undefined && !existing?.stateCode ? {} : { stateCode: found };
    }
    return stateCode !== undefined || existing?.stateCode ? { stateCode: null } : {};
  };
  if (code !== "AE") return { country: code, emirate: null, ...state() };
  const typed = emirate === undefined ? existing?.emirate : emirate;
  const found = emirateOf(typed);
  if (!found) throw bad(blank(typed) ? "Choose an emirate" : `"${String(typed).trim()}" is not an emirate of the UAE`, "INVALID_EMIRATE");
  return { country: "AE", emirate: found, ...state() };
}

module.exports = { EMIRATES, DEFAULT_COUNTRY, emirateOf, resolveAddress };
