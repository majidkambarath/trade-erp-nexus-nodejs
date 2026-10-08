// Encrypts secrets (ASP and email provider API keys, webhook secrets) at rest with AES-256-GCM. The
// key is SECRET_BOX_KEY (64 hex chars) when set, else EINVOICE_SECRET_KEY (its earlier name), else
// derived from JWT_SECRET - in which case rotating JWT_SECRET makes every stored secret unreadable.
// Secrets are decrypted only inside the server and are never returned by any API.
const crypto = require("crypto");

function key() {
  for (const name of ["SECRET_BOX_KEY", "EINVOICE_SECRET_KEY"]) {
    const k = process.env[name];
    if (k && /^[0-9a-f]{64}$/i.test(k)) return Buffer.from(k, "hex");
  }
  const base = process.env.JWT_SECRET;
  if (!base) throw new Error("Set SECRET_BOX_KEY (or JWT_SECRET) to store integration secrets");
  return crypto.scryptSync(base, "erp-einvoice-secrets", 32);
}

function encrypt(plain) {
  if (plain === undefined || plain === null || plain === "") return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

function decrypt(blob) {
  if (!blob) return null;
  const [v, iv, tag, ct] = String(blob).split(":");
  if (v !== "v1") throw new Error("Unknown secret format");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

const hmac = (secret, raw) => crypto.createHmac("sha256", secret).update(raw).digest("hex");
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

module.exports = { encrypt, decrypt, hmac, safeEqual };
