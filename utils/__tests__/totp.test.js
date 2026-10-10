// Time-based one-time passwords, checked against the numbers the RFCs themselves publish, so "it works with an authenticator app"
// does not rest on our own arithmetic agreeing with itself.
const test = require("node:test");
const assert = require("node:assert/strict");
const totp = require("../totp");

const SHA1_SECRET = Buffer.from("12345678901234567890");
const SHA256_SECRET = Buffer.from("12345678901234567890123456789012");
const SHA512_SECRET = Buffer.from("1234567890123456789012345678901234567890123456789012345678901234");

test("RFC 4226 appendix D: the HMAC one-time password for counters 0 to 9", () => {
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  expected.forEach((code, counter) => assert.equal(totp.hotp(SHA1_SECRET, counter), code, `counter ${counter}`));
});

test("RFC 6238 appendix B: every published SHA-1 value (8 digits)", () => {
  const vectors = [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]];
  for (const [seconds, code] of vectors) assert.equal(totp.totp(SHA1_SECRET, { time: seconds * 1000, digits: 8 }), code, `T=${seconds}`);
});

test("RFC 6238 appendix B: SHA-256 and SHA-512 values (8 digits)", () => {
  const sha256 = [[59, "46119246"], [1111111109, "68084774"], [1111111111, "67062674"], [1234567890, "91819424"], [2000000000, "90698825"], [20000000000, "77737706"]];
  const sha512 = [[59, "90693936"], [1111111109, "25091201"], [1111111111, "99943326"], [1234567890, "93441116"], [2000000000, "38618901"], [20000000000, "47863826"]];
  for (const [seconds, code] of sha256) assert.equal(totp.totp(SHA256_SECRET, { time: seconds * 1000, digits: 8, algorithm: "sha256" }), code, `sha256 T=${seconds}`);
  for (const [seconds, code] of sha512) assert.equal(totp.totp(SHA512_SECRET, { time: seconds * 1000, digits: 8, algorithm: "sha512" }), code, `sha512 T=${seconds}`);
});

test("the default is what authenticator apps use: SHA-1, 30 seconds, 6 digits (the last six of the RFC's eight)", () => {
  assert.equal(totp.totp(SHA1_SECRET, { time: 59 * 1000 }), "287082");
  assert.equal(totp.totp(SHA1_SECRET, { time: 1111111109 * 1000 }), "081804");
});

test("base32: round trips, ignores the spaces and case people retype, and refuses what is not base32", () => {
  assert.equal(totp.base32Encode(Buffer.from("12345678901234567890")), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"); // the RFC 6238 secret, as an app is given it
  assert.deepEqual(totp.base32Decode("gezd gnbv-GY3TQOJQ GEZDGNBVGY3TQOJQ=="), Buffer.from("12345678901234567890"));
  for (const length of [1, 5, 10, 19, 20, 33]) {
    const bytes = Buffer.from(Array.from({ length }, (_, i) => (i * 37 + 11) % 256));
    assert.deepEqual(totp.base32Decode(totp.base32Encode(bytes)), bytes, `${length} bytes`);
  }
  assert.throws(() => totp.base32Decode("not base32 !!"), /valid base32/);
});

test("a new secret is 160 random bits as 32 base32 characters, and never the same twice", () => {
  const a = totp.generateSecret();
  const b = totp.generateSecret();
  assert.match(a, /^[A-Z2-7]{32}$/);
  assert.notEqual(a, b);
  assert.equal(totp.base32Decode(a).length, 20);
});

test("verifying: this step and one either side are good (a phone's clock drifts), two steps away is not", () => {
  const secret = totp.base32Encode(SHA1_SECRET);
  const now = 1_700_000_000_000;
  const at = (offsetSteps) => totp.totp(secret, { time: now + offsetSteps * 30_000 });
  assert.deepEqual(totp.verifyTotp(secret, at(0), { time: now }), { ok: true, step: totp.stepAt(now) });
  assert.equal(totp.verifyTotp(secret, at(-1), { time: now }).ok, true);
  assert.equal(totp.verifyTotp(secret, at(1), { time: now }).ok, true);
  assert.deepEqual(totp.verifyTotp(secret, at(-2), { time: now }), { ok: false, reason: "invalid" });
  assert.deepEqual(totp.verifyTotp(secret, at(2), { time: now }), { ok: false, reason: "invalid" });
});

test("verifying: a code for a step already accepted is a replay, one for a later step is fine", () => {
  const secret = totp.base32Encode(SHA1_SECRET);
  const now = 1_700_000_000_000;
  const step = totp.stepAt(now);
  const code = totp.totp(secret, { time: now });
  assert.deepEqual(totp.verifyTotp(secret, code, { time: now, afterStep: step }), { ok: false, reason: "replayed" });
  assert.deepEqual(totp.verifyTotp(secret, code, { time: now, afterStep: step + 1 }), { ok: false, reason: "replayed" });
  assert.equal(totp.verifyTotp(secret, code, { time: now, afterStep: step - 1 }).ok, true);
  // the code for the NEXT step is accepted ahead of its time and is not a replay of this one
  assert.equal(totp.verifyTotp(secret, totp.totp(secret, { time: now + 30_000 }), { time: now, afterStep: step }).ok, true);
});

test("verifying: only six digits will do, spaces and a hyphen are forgiven, anything else is simply wrong", () => {
  const secret = totp.base32Encode(SHA1_SECRET);
  const now = 1_700_000_000_000;
  const code = totp.totp(secret, { time: now });
  assert.equal(totp.verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, { time: now }).ok, true);
  for (const bad of ["", "12345", "1234567", "abcdef", undefined, null, 123456.5, "12 34 5x"]) assert.equal(totp.verifyTotp(secret, bad, { time: now }).ok, false, String(bad));
  assert.equal(totp.verifyTotp(secret, code === "000000" ? "000001" : "000000", { time: now }).ok, false);
});

test("the otpauth address carries the secret, the issuer twice, and the account, escaped", () => {
  const uri = totp.otpauthUri({ secret: "GEZDGNBVGY3TQOJQ", account: "Nadia O'Neil+x@example.com", issuer: "Zarvia ERP" });
  assert.match(uri, /^otpauth:\/\/totp\/Zarvia%20ERP:Nadia%20O'Neil%2Bx%40example\.com\?/);
  const params = new URL(uri).searchParams;
  assert.equal(params.get("secret"), "GEZDGNBVGY3TQOJQ");
  assert.equal(params.get("issuer"), "Zarvia ERP");
  assert.equal(params.get("algorithm"), "SHA1");
  assert.equal(params.get("digits"), "6");
  assert.equal(params.get("period"), "30");
});

test("the setup key is shown in groups of four", () => {
  assert.equal(totp.formatSecret("GEZDGNBVGY3TQOJQ"), "GEZD GNBV GY3T QOJQ");
});
