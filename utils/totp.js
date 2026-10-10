// Time-based one-time passwords (RFC 6238, built on the HMAC one-time password of RFC 4226), with nothing but `crypto`.
// This is what an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password ...) computes, so a
// person enrols once by scanning a QR code and from then on types the six digits it shows.
//
// Pure: no database, no clock of its own (the time is an argument), so the RFC's own test vectors can be checked exactly
// (utils/__tests__/totp.test.js). Defaults are what every authenticator app assumes: HMAC-SHA1, 30-second steps, 6 digits.
const crypto = require("crypto");

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648 base32, the alphabet an otpauth:// secret uses

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// Spaces, hyphens, case and "=" padding are ignored (people retype a key from the screen in groups of four).
function base32Decode(text) {
  const clean = String(text ?? "").toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const index = B32.indexOf(ch);
    if (index < 0) throw new Error("That is not a valid base32 key");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

const toKey = (secret) => (Buffer.isBuffer(secret) ? secret : base32Decode(secret));

// RFC 4226 section 5.3: HMAC the 8-byte counter, take 31 bits from the offset the last nibble names, keep `digits` of them.
function hotp(secret, counter, { digits = 6, algorithm = "sha1" } = {}) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, toKey(secret)).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

// The step (counter) a moment falls in. `time` is milliseconds since the epoch.
const stepAt = (time, period = 30) => Math.floor(time / 1000 / period);

function totp(secret, { time = Date.now(), period = 30, digits = 6, algorithm = "sha1" } = {}) {
  return hotp(secret, stepAt(time, period), { digits, algorithm });
}

const sameText = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Is `code` the code for the current step, or one step either side (a phone's clock is rarely exact)?
 *
 * `afterStep` is the last step already accepted for this person: a code for that step or an earlier one is a REPLAY (someone
 * who watched the code being typed, or a link retried) and is refused, so one code is good for one sign-in. Every candidate
 * step is compared whether or not an earlier one matched, in constant time, so the time taken says nothing about which.
 *
 * Returns { ok: true, step } or { ok: false, reason: "invalid" | "replayed" }.
 */
function verifyTotp(secret, code, { time = Date.now(), window = 1, period = 30, digits = 6, algorithm = "sha1", afterStep = -1 } = {}) {
  // text or a number and nothing else: String() on an object with its own toString throws, and a request body can send one
  const text = (typeof code === "string" || typeof code === "number" ? String(code) : "").replace(/[\s-]/g, "");
  if (!new RegExp(`^\\d{${digits}}$`).test(text)) return { ok: false, reason: "invalid" };
  const key = toKey(secret);
  const now = stepAt(time, period);
  let matched = null;
  for (let step = now - window; step <= now + window; step += 1) {
    if (step < 0) continue;
    if (sameText(hotp(key, step, { digits, algorithm }), text) && (matched === null || step > matched)) matched = step;
  }
  if (matched === null) return { ok: false, reason: "invalid" };
  if (matched <= afterStep) return { ok: false, reason: "replayed" };
  return { ok: true, step: matched };
}

// 160 random bits, the length RFC 4226 recommends for an HMAC-SHA1 secret, as the base32 text an authenticator app is given.
const generateSecret = (bytes = 20) => base32Encode(crypto.randomBytes(bytes));

// The address a QR code carries (the "Key URI Format" every authenticator app reads). `issuer` appears twice, as the label's
// prefix and as a parameter, because older apps read one and newer apps the other.
function otpauthUri({ secret, account, issuer, period = 30, digits = 6, algorithm = "sha1" }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: algorithm.toUpperCase(), digits: String(digits), period: String(period) });
  return `otpauth://totp/${label}?${params.toString().replace(/\+/g, "%20")}`;
}

// The key as people read it off the screen: groups of four.
const formatSecret = (secret) => String(secret).replace(/(.{4})/g, "$1 ").trim();

module.exports = { base32Encode, base32Decode, hotp, totp, stepAt, verifyTotp, generateSecret, otpauthUri, formatSecret };
