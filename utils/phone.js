// Phone numbers for WhatsApp. Pure. wa.me wants the number as digits only, with the country code and
// no plus or leading zeros: 971501112222. People type it a dozen ways ("050 111 2222", "+971 50 111
// 2222", "00971501112222"), and this app is built for the UAE, so a national number is read as UAE.

const digitsOf = (v) => String(v ?? "").replace(/\D/g, "");

// Digits with the country code, or null if the text cannot be a phone number.
function toWaNumber(input, { defaultCountry = "971" } = {}) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (!/^[+\d\s().-]+$/.test(raw)) return null; // letters and the like are not a number
  const compact = raw.replace(/\s/g, "");
  const international = compact.startsWith("+") || compact.startsWith("00");
  let d = digitsOf(raw);
  if (!d) return null;
  if (compact.startsWith("00")) d = d.slice(2);

  if (international) return d.length >= 8 && d.length <= 15 ? d : null;

  // Written with the country code but no plus: 971 50 111 2222
  if (d.startsWith(defaultCountry) && d.length >= defaultCountry.length + 8 && d.length <= defaultCountry.length + 9) return d;
  // A UAE national number: 050 111 2222 (mobile, 10 digits with the zero) or 04 123 4567 (landline, 9)
  if (d.startsWith("0")) {
    const rest = d.slice(1);
    return rest.length === 8 || rest.length === 9 ? defaultCountry + rest : null;
  }
  // 50 111 2222: the zero left off
  return d.length === 9 && d.startsWith("5") ? defaultCountry + d : null;
}

// The link that opens WhatsApp with the text ready. Without a number it opens the contact picker.
const waMeUrl = (number, text) => `https://wa.me/${number || ""}?text=${encodeURIComponent(String(text ?? ""))}`;

module.exports = { toWaNumber, waMeUrl };
