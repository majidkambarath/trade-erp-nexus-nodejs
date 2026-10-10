// The small secrets of account security, pure (no database, no request):
//   - the password-reset link's token
//   - the recovery codes that stand in for an authenticator when the phone is lost
//   - the short-lived "challenge" a sign-in holds between the password and the two-factor code
//
// Every one of them is stored as a hash (or not at all), never as the secret itself, so a copy of the database opens nothing.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { jwtSecret } = require("./productionConfig");

const sha256 = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");

// ---- password reset

// 256 random bits, base64url (43 characters). A fast hash is right: the token is already unguessable, so there is no
// dictionary for a slow hash to resist. The hash IS the stored row's id, so finding the row is comparing the hash.
const RESET_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
function newResetToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, id: sha256(token) };
}
const looksLikeResetToken = (text) => typeof text === "string" && RESET_TOKEN_RE.test(text);
const resetTokenId = (token) => sha256(token);

// ---- recovery codes

// Crockford base32 without I, L, O, U: a code read off paper is not mistaken. 10 characters = 50 random bits, shown as
// two groups of five. A code is good once.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const normaliseRecoveryCode = (text) => (typeof text === "string" ? text : "").toUpperCase().replace(/[^0-9A-Z]/g, "")
  .replace(/O/g, "0").replace(/[IL]/g, "1"); // the usual misreadings of a handwritten code
const looksLikeRecoveryCode = (text) => normaliseRecoveryCode(text).length === 10;
// A recovery code has 50 bits, which a plain hash would not protect if the database leaked (the whole space can be walked offline).
// So it is hashed with a key only the server holds - the same key that encrypts the two-factor secret (utils/secretBox.js).
const pepper = () => process.env.SECRET_BOX_KEY || process.env.EINVOICE_SECRET_KEY || process.env.JWT_SECRET || "";
const hashRecoveryCode = (text) => crypto.createHmac("sha256", `recovery-codes:${pepper()}`).update(normaliseRecoveryCode(text)).digest("hex");

function newRecoveryCodes(count = 10) {
  const codes = [];
  while (codes.length < count) {
    const bytes = crypto.randomBytes(10);
    // 256 is a multiple of 32, so a byte mod 32 is uniform
    const raw = Array.from(bytes, (b) => CODE_ALPHABET[b % 32]).join("");
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

// ---- the challenge between password and code

// Proves "this person's password was just checked" for five minutes and for ONE purpose. It carries its own audience, so it
// is not an access token and no route that wants an access token will take it, and an access token is not a challenge.
const CHALLENGE_SECONDS = 5 * 60;
const CUSTOMER_CHALLENGE = { audience: "ERP-2fa-challenge", purpose: "two-factor-sign-in" };
const PLATFORM_CHALLENGE = { audience: "ERP-platform-2fa-challenge", purpose: "platform-two-factor-sign-in" };

// (the signing key itself is read in one place, utils/productionConfig.js: no placeholder fallback in production)
const customerSecret = () => `${jwtSecret()}::2fa-challenge`;
const platformSecret = () => `${process.env.PLATFORM_JWT_SECRET || `${jwtSecret()}::platform-console`}::2fa-challenge`;

function signChallenge(claims, { kind = CUSTOMER_CHALLENGE, secret = customerSecret(), seconds = CHALLENGE_SECONDS } = {}) {
  return jwt.sign({ ...claims, purpose: kind.purpose }, secret, { expiresIn: seconds, issuer: "ERP-system", audience: kind.audience });
}

// The claims, or throws an Error with `code` "CHALLENGE_EXPIRED" or "CHALLENGE_INVALID".
function verifyChallenge(token, { kind = CUSTOMER_CHALLENGE, secret = customerSecret() } = {}) {
  let claims;
  try {
    claims = jwt.verify(String(token ?? ""), secret, { issuer: "ERP-system", audience: kind.audience });
  } catch (error) {
    const failure = new Error(error.name === "TokenExpiredError" ? "Your sign-in took too long. Start again." : "This sign-in cannot be continued. Start again.");
    failure.code = error.name === "TokenExpiredError" ? "CHALLENGE_EXPIRED" : "CHALLENGE_INVALID";
    throw failure;
  }
  if (claims.purpose !== kind.purpose) {
    const failure = new Error("This sign-in cannot be continued. Start again.");
    failure.code = "CHALLENGE_INVALID";
    throw failure;
  }
  return claims;
}

module.exports = {
  sha256,
  newResetToken, looksLikeResetToken, resetTokenId,
  newRecoveryCodes, normaliseRecoveryCode, looksLikeRecoveryCode, hashRecoveryCode,
  signChallenge, verifyChallenge, customerSecret, platformSecret, CUSTOMER_CHALLENGE, PLATFORM_CHALLENGE, CHALLENGE_SECONDS,
};
