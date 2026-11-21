const test = require("node:test");
const assert = require("node:assert/strict");
const { sign, verify } = require("../standardWebhooks");

const secret = "whsec_" + Buffer.from("a-test-signing-secret-of-32-bytes!").toString("base64");
const body = JSON.stringify({ id: "evt_1", type: "document.status", data: { document_id: "inv_1" } });
const now = 1_800_000_000_000;
const ts = String(now / 1000);
const good = () => ({ secret, id: "msg_1", timestamp: ts, rawBody: body, now, signature: `v1,${sign(secret, "msg_1", ts, body)}` });

test("a correctly signed delivery verifies", () => assert.deepEqual(verify(good()), { ok: true }));
test("a raw Buffer body verifies the same", () => assert.equal(verify({ ...good(), rawBody: Buffer.from(body) }).ok, true));
test("a tampered body is refused", () => assert.equal(verify({ ...good(), rawBody: body.replace("inv_1", "inv_2") }).reason, "bad_signature"));
test("a wrong secret is refused", () => assert.equal(verify({ ...good(), secret: "whsec_" + Buffer.from("other").toString("base64") }).reason, "bad_signature"));
test("a stale timestamp is refused", () => assert.equal(verify({ ...good(), now: now + 6 * 60 * 1000 }).reason, "stale_timestamp"));
test("a future timestamp beyond tolerance is refused", () => assert.equal(verify({ ...good(), now: now - 6 * 60 * 1000 }).reason, "stale_timestamp"));
test("any one of several signatures may match (secret rotation)", () => {
  const g = good();
  assert.equal(verify({ ...g, signature: `v1,AAAA ${g.signature}` }).ok, true);
});
test("an unknown version or a missing header is refused", () => {
  const g = good();
  assert.equal(verify({ ...g, signature: g.signature.replace("v1,", "v2,") }).ok, false);
  assert.equal(verify({ ...g, id: undefined }).reason, "missing_headers");
  assert.equal(verify({ ...g, secret: "" }).reason, "no_secret");
});
