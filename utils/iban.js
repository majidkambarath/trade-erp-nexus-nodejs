// IBAN helpers. An IBAN is validated by its checksum (ISO 13616 mod-97), not just its shape, so a
// mistyped digit is caught when the bank account is saved rather than when a transfer bounces.

const normalizeIban = (s) => String(s || "").replace(/\s+/g, "").toUpperCase();

function isValidIban(value) {
  const v = normalizeIban(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v)) return false;
  if (v.startsWith("AE") && v.length !== 23) return false; // UAE IBANs are always 23 characters
  const rearranged = v.slice(4) + v.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

// Only the last four characters are shown wherever a number appears in a list or on a voucher.
const maskTail = (value) => {
  const s = String(value || "").replace(/\s+/g, "");
  return s.length <= 4 ? s : `•••• ${s.slice(-4)}`;
};

module.exports = { normalizeIban, isValidIban, maskTail };
