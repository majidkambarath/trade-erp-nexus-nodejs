const test = require("node:test");
const assert = require("node:assert/strict");
const { newToken, parseToken, hashSecret, secretMatches, newPublicId } = require("../shareToken");
const { toWaNumber, waMeUrl } = require("../phone");

// ---- share token ----
test("a token is a selector and a 256-bit secret, and only the hash is kept", () => {
  const t = newToken();
  assert.match(t.token, /^[0-9A-HJKMNP-TV-Z]{11}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(t.token, `${t.publicId}.${t.secret}`);
  assert.equal(t.secretHash, hashSecret(t.secret));
  assert.equal(t.secretHash.length, 64);
  assert.equal(JSON.stringify(t.secretHash).includes(t.secret), false);
});

test("parseToken reads a real token and refuses everything else", () => {
  const t = newToken();
  assert.deepEqual(parseToken(t.token), { publicId: t.publicId, secret: t.secret });
  assert.deepEqual(parseToken(`  ${t.token}  `), { publicId: t.publicId, secret: t.secret }, "pasted with spaces");
  for (const bad of ["", null, undefined, "abc", "nodot", `${t.publicId}.`, `.${t.secret}`, `${t.publicId}.${t.secret}x`, `${t.publicId.toLowerCase()}.${t.secret}`, `${t.publicId}.${"!".repeat(43)}`, `${t.token}.extra`, "../../etc/passwd"]) {
    assert.equal(parseToken(bad), null, JSON.stringify(bad));
  }
});

test("the secret is matched against the stored hash, and a near miss does not match", () => {
  const t = newToken();
  assert.equal(secretMatches(t.secret, t.secretHash), true);
  assert.equal(secretMatches(t.secret.slice(0, -1) + (t.secret.endsWith("A") ? "B" : "A"), t.secretHash), false);
  assert.equal(secretMatches("", t.secretHash), false);
});

test("ten thousand tokens: no repeated selector, no repeated secret", () => {
  const ids = new Set();
  const secrets = new Set();
  for (let i = 0; i < 10000; i += 1) {
    const t = newToken();
    ids.add(t.publicId);
    secrets.add(t.secret);
  }
  assert.equal(ids.size, 10000);
  assert.equal(secrets.size, 10000);
  assert.equal(newPublicId().length, 11);
});

// ---- phone ----
test("a UAE number is read however it was typed", () => {
  for (const [typed, want] of [
    ["050 111 2222", "971501112222"], ["0501112222", "971501112222"], ["050-111-2222", "971501112222"], ["(050) 111 2222", "971501112222"],
    ["+971 50 111 2222", "971501112222"], ["00971501112222", "971501112222"], ["971501112222", "971501112222"], ["501112222", "971501112222"],
    ["04 123 4567", "97141234567"],
  ]) assert.equal(toWaNumber(typed), want, typed);
});

test("a number from another country keeps its own code, and junk is refused", () => {
  assert.equal(toWaNumber("+91 98765 43210"), "919876543210");
  assert.equal(toWaNumber("0044 20 7946 0958"), "442079460958");
  for (const bad of ["", null, undefined, "abc", "123", "050 111", "+1", "call me", "05011122223333"]) assert.equal(toWaNumber(bad), null, JSON.stringify(bad));
});

test("the WhatsApp link encodes the text, and opens the contact picker with no number", () => {
  assert.equal(waMeUrl("971501112222", "Hi\nthere & more"), "https://wa.me/971501112222?text=Hi%0Athere%20%26%20more");
  assert.equal(waMeUrl("", "Hi"), "https://wa.me/?text=Hi");
  assert.equal(waMeUrl(null, "x y"), "https://wa.me/?text=x%20y");
});
