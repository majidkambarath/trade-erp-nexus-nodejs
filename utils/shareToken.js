// The secret link to a document. Pure: no database, no request.
//
//   token    = <publicId> "." <secret>
//   publicId = 11 characters from a 32-symbol alphabet. NOT secret: it is the indexed selector.
//   secret   = 32 random bytes (256 bits), base64url. Only its SHA-256 is ever stored.
//
// Looking up by the selector and then comparing hashes means the index never holds a credential, and
// a wrong guess cannot be told apart by query timing. A fast hash is right here: the secret is already
// 256 random bits, so there is no dictionary for a slow hash to resist, and a slow one on a route
// anyone can call would only make it cheaper to overload us.
const crypto = require("crypto");
const { safeEqual } = require("./secretBox");

// Crockford base32: no I, L, O or U, so a link read aloud or retyped is not mistaken.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TOKEN_RE = /^[0-9A-HJKMNP-TV-Z]{11}\.[A-Za-z0-9_-]{43}$/;

// 256 is a multiple of 32, so taking a byte mod 32 is uniform: no symbol is likelier than another.
const newPublicId = () => Array.from(crypto.randomBytes(11), (b) => ALPHABET[b % 32]).join("");
const newSecret = () => crypto.randomBytes(32).toString("base64url");
const hashSecret = (secret) => crypto.createHash("sha256").update(String(secret)).digest("hex");

function newToken() {
  const publicId = newPublicId();
  const secret = newSecret();
  return { publicId, secret, token: `${publicId}.${secret}`, secretHash: hashSecret(secret) };
}

// { publicId, secret } for something shaped like a token, otherwise null. Shape only: whether it
// exists is the database's answer.
function parseToken(text) {
  const s = String(text ?? "").trim();
  if (!TOKEN_RE.test(s)) return null;
  const [publicId, secret] = s.split(".");
  return { publicId, secret };
}

const secretMatches = (secret, storedHash) => safeEqual(hashSecret(secret), storedHash);

module.exports = { newToken, parseToken, hashSecret, secretMatches, newPublicId, TOKEN_RE };
