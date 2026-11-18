// India's GST state and union territory codes (the first two digits of a GSTIN). Pure.
//
// Code 25 (Daman and Diu) was merged into 26 in 2020 and is not listed. 97 and 99 are not states: "Other territory"
// and "Centre jurisdiction", used as a place of supply for offshore and centre-administered cases.
// A union territory WITHOUT a legislature charges UTGST where a state charges SGST; the amount and the split are the
// same, only the name of the second half differs (`secondHalfName`).
const STATES = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands",
  "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other territory", "99": "Centre jurisdiction",
};
// union territories with no legislature of their own: UTGST instead of SGST
const UT_WITHOUT_LEGISLATURE = new Set(["04", "26", "31", "35", "38"]);

const isStateCode = (code) => Object.prototype.hasOwnProperty.call(STATES, String(code ?? ""));
const stateName = (code) => (isStateCode(code) ? STATES[String(code)] : null);
const stateList = () => Object.entries(STATES).map(([code, name]) => ({ code, name }));
const secondHalfName = (code) => (UT_WITHOUT_LEGISLATURE.has(String(code)) ? "UTGST" : "SGST");

// The state a GSTIN belongs to: its first two digits, when they are a real code. null otherwise.
function stateCodeOfGstin(gstin) {
  const m = /^(\d{2})/.exec(String(gstin ?? "").trim());
  return m && isStateCode(m[1]) ? m[1] : null;
}

// A state typed as a code ("27", 27), a name ("maharashtra") or left blank. Returns the code, or null for blank,
// or undefined for something that is neither (the caller refuses it).
function normaliseState(input) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  const padded = /^\d{1,2}$/.test(text) ? text.padStart(2, "0") : text;
  if (isStateCode(padded)) return padded;
  const byName = Object.entries(STATES).find(([, name]) => name.toLowerCase() === text.toLowerCase().replace(/\s+&\s+/g, " and "));
  return byName ? byName[0] : undefined;
}

module.exports = { STATES, UT_WITHOUT_LEGISLATURE, isStateCode, stateName, stateList, secondHalfName, stateCodeOfGstin, normaliseState };
