// Standard Webhooks (standardwebhooks.com) signature check. Pure. Wafeq signs its deliveries this way: headers `webhook-id`,
// `webhook-timestamp`, `webhook-signature`; signed content `${id}.${timestamp}.${rawBody}`; HMAC-SHA256, base64; the header holds
// space-separated `v1,<signature>` entries (several while a secret is being rotated). The secret is `whsec_<base64>`.
const crypto = require("crypto");

const TOLERANCE_SECONDS = 5 * 60;

const keyOf = (secret) => {
  const s = String(secret || "");
  return Buffer.from(s.startsWith("whsec_") ? s.slice(6) : s, s.startsWith("whsec_") ? "base64" : "utf8");
};

function sign(secret, id, timestamp, rawBody) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ""), "utf8");
  return crypto.createHmac("sha256", keyOf(secret)).update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`), body])).digest("base64");
}

/** -> { ok: true } or { ok: false, reason } */
function verify({ secret, id, timestamp, signature, rawBody, now = Date.now() }) {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!id || !timestamp || !signature || rawBody === undefined || rawBody === null) return { ok: false, reason: "missing_headers" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(now / 1000 - ts) > TOLERANCE_SECONDS) return { ok: false, reason: "stale_timestamp" };
  const expected = Buffer.from(sign(secret, id, timestamp, rawBody));
  for (const part of String(signature).split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const got = Buffer.from(sig);
    if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) return { ok: true };
  }
  return { ok: false, reason: "bad_signature" };
}

module.exports = { sign, verify, TOLERANCE_SECONDS };
