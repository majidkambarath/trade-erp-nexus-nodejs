// The small secrets of account security: the reset link's token, the recovery codes, and the challenge between a password and a code.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const t = require("../accountTokens");

test("a reset token is 256 random bits, and only its SHA-256 is the stored id", () => {
  const a = t.newResetToken();
  const b = t.newResetToken();
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.id, crypto.createHash("sha256").update(a.token).digest("hex"));
  assert.equal(t.resetTokenId(a.token), a.id);
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.id, a.token, "the id is not the token");
  assert.ok(!a.id.includes(a.token));
});

test("what looks like a reset token: exactly the shape, nothing else", () => {
  const { token } = t.newResetToken();
  assert.equal(t.looksLikeResetToken(token), true);
  for (const bad of ["", "short", `${token}x`, token.slice(1), `${token.slice(0, 42)}!`, undefined, null, 12, `${token} `, { toString: () => token }]) {
    assert.equal(t.looksLikeResetToken(bad), false, JSON.stringify(bad));
  }
});

test("ten recovery codes: two groups of five from an alphabet with nothing to mistake, all different", () => {
  const codes = t.newRecoveryCodes(10);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/, c);
  const many = t.newRecoveryCodes(500);
  assert.equal(new Set(many).size, 500);
  assert.ok(!many.join("").match(/[ILOU]/), "no I, L, O or U to be misread");
});

test("a recovery code is read the way a person retypes it: case, spaces, the hyphen and the usual misreadings do not matter", () => {
  const [code] = t.newRecoveryCodes(1);
  const hash = t.hashRecoveryCode(code);
  assert.equal(t.hashRecoveryCode(code.toLowerCase()), hash);
  assert.equal(t.hashRecoveryCode(code.replace("-", "")), hash);
  assert.equal(t.hashRecoveryCode(` ${code.replace("-", " ")} `), hash);
  assert.equal(t.hashRecoveryCode("O0O0O-1l1I1"), t.hashRecoveryCode("00000-11111"), "O reads as 0, I and l as 1");
  assert.notEqual(t.hashRecoveryCode("00000-00001"), t.hashRecoveryCode("00000-00002"));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(!hash.includes(t.normaliseRecoveryCode(code)), "the hash does not contain the code");
  assert.equal(t.looksLikeRecoveryCode(code), true);
  for (const bad of ["", "123456", "12345-6789", "12345-678901", undefined]) assert.equal(t.looksLikeRecoveryCode(bad), false, String(bad));
});

test("a recovery code's hash depends on a key only the server holds, so a copy of the database cannot be walked offline", () => {
  const saved = { SECRET_BOX_KEY: process.env.SECRET_BOX_KEY, JWT_SECRET: process.env.JWT_SECRET };
  try {
    process.env.SECRET_BOX_KEY = "a".repeat(64);
    const one = t.hashRecoveryCode("AAAAA-BBBBB");
    assert.notEqual(one, crypto.createHash("sha256").update("recovery:AAAAABBBBB").digest("hex"), "not a plain hash of the code");
    assert.equal(t.hashRecoveryCode("aaaaa bbbbb"), one, "the same code, however typed");
    process.env.SECRET_BOX_KEY = "b".repeat(64);
    assert.notEqual(t.hashRecoveryCode("AAAAA-BBBBB"), one, "another key, another hash");
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("a code and a six-digit app code can never be mistaken for each other", () => {
  assert.equal(t.looksLikeRecoveryCode("123456"), false);
  assert.equal(t.normaliseRecoveryCode("12345-67890").length, 10);
});

test("the challenge carries who, for five minutes, for one purpose", () => {
  const token = t.signChallenge({ sub: "abc", cid: "acme" });
  const claims = t.verifyChallenge(token);
  assert.equal(claims.sub, "abc");
  assert.equal(claims.cid, "acme");
  assert.equal(claims.purpose, "two-factor-sign-in");
  assert.equal(claims.exp - claims.iat, 300);
  assert.equal(t.CHALLENGE_SECONDS, 300);
});

test("an expired, forged, or foreign challenge is refused, and says which", () => {
  const expired = t.signChallenge({ sub: "abc" }, { seconds: -10 });
  assert.throws(() => t.verifyChallenge(expired), (e) => e.code === "CHALLENGE_EXPIRED");
  const other = t.signChallenge({ sub: "abc" }, { secret: "some other secret" });
  assert.throws(() => t.verifyChallenge(other), (e) => e.code === "CHALLENGE_INVALID");
  for (const junk of ["", "x.y.z", undefined, null, "Bearer abc"]) assert.throws(() => t.verifyChallenge(junk), (e) => e.code === "CHALLENGE_INVALID", String(junk));
});

test("a challenge is not an access token, and an access token is not a challenge", () => {
  const secret = process.env.JWT_SECRET || "your-secret-key";
  const challenge = t.signChallenge({ sub: "abc" });
  // two separate barriers: the access token verifier does not share the challenge's secret, and it asks for audience ERP-admin
  assert.throws(() => jwt.verify(challenge, secret, { issuer: "ERP-system", audience: "ERP-admin" }), /invalid signature/);
  assert.throws(() => jwt.verify(challenge, `${secret}::2fa-challenge`, { issuer: "ERP-system", audience: "ERP-admin" }), /audience invalid/);
  // ...and the other way round: an access token signed with the real secret
  const access = jwt.sign({ id: "abc", type: "viewer" }, secret, { expiresIn: "15m", issuer: "ERP-system", audience: "ERP-admin" });
  assert.throws(() => t.verifyChallenge(access), (e) => e.code === "CHALLENGE_INVALID");
  // even one signed with the challenge secret but the wrong audience or purpose
  const disguised = jwt.sign({ sub: "abc", purpose: "two-factor-sign-in" }, t.customerSecret(), { expiresIn: 60, issuer: "ERP-system", audience: "ERP-admin" });
  assert.throws(() => t.verifyChallenge(disguised), (e) => e.code === "CHALLENGE_INVALID");
  const wrongPurpose = jwt.sign({ sub: "abc", purpose: "something-else" }, t.customerSecret(), { expiresIn: 60, issuer: "ERP-system", audience: "ERP-2fa-challenge" });
  assert.throws(() => t.verifyChallenge(wrongPurpose), (e) => e.code === "CHALLENGE_INVALID");
});

test("the developer console's challenge is its own: neither side accepts the other's", () => {
  const platform = t.signChallenge({ sub: "p1" }, { kind: t.PLATFORM_CHALLENGE, secret: t.platformSecret() });
  assert.equal(t.verifyChallenge(platform, { kind: t.PLATFORM_CHALLENGE, secret: t.platformSecret() }).sub, "p1");
  assert.throws(() => t.verifyChallenge(platform), (e) => e.code === "CHALLENGE_INVALID", "a customer sign-in does not take it");
  const customer = t.signChallenge({ sub: "c1" });
  assert.throws(() => t.verifyChallenge(customer, { kind: t.PLATFORM_CHALLENGE, secret: t.platformSecret() }), (e) => e.code === "CHALLENGE_INVALID", "the console does not take a customer's");
});
