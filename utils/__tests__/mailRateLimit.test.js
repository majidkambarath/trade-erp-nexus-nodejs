const test = require("node:test");
const assert = require("node:assert/strict");
const { classify, retryAfterMsFrom } = require("../mailErrors");
const { rateLimit, clientIp, coarseIp } = require("../../middleware/rateLimit");

// ---- provider failures ----
test("every provider answer is classified, with whether trying again can help", () => {
  const cases = [
    [401, { name: "invalid_api_key" }, "PROVIDER_AUTH", false],
    [403, { message: "The example.com domain is not verified" }, "FROM_NOT_VERIFIED", false],
    [403, { message: "forbidden" }, "PROVIDER_AUTH", false],
    [422, { name: "validation_error", message: "Invalid `to` email address" }, "INVALID_ADDRESS", false],
    [422, { name: "validation_error", message: "Missing html or text" }, "PROVIDER_REJECTED", false],
    [400, { message: "bad" }, "PROVIDER_REJECTED", false],
    [409, { name: "invalid_idempotent_request" }, "PROVIDER_REJECTED", false],
    [409, { name: "concurrent_idempotent_requests" }, "PROVIDER_BUSY", true],
    [429, { name: "rate_limit_exceeded" }, "PROVIDER_RATE_LIMIT", true],
    [429, { name: "daily_quota_exceeded" }, "PROVIDER_QUOTA", false],
    [500, null, "PROVIDER_UNAVAILABLE", true],
    [503, { message: "down" }, "PROVIDER_UNAVAILABLE", true],
  ];
  for (const [status, body, code, retryable] of cases) {
    const r = classify(status, body);
    assert.equal(r.code, code, `${status} ${JSON.stringify(body)}`);
    assert.equal(r.retryable, retryable, `${status} ${JSON.stringify(body)}`);
    assert.ok(r.message.length > 10);
  }
});

test("Retry-After is honoured, in seconds or as a date, and capped at an hour", () => {
  assert.equal(classify(429, { name: "rate_limit_exceeded" }, { retryAfter: "30" }).retryAfterMs, 30000);
  assert.equal(retryAfterMsFrom("99999"), 3600 * 1000);
  assert.equal(retryAfterMsFrom(""), undefined);
  assert.equal(retryAfterMsFrom("soon"), undefined);
  const ms = retryAfterMsFrom(new Date(Date.now() + 10000).toUTCString());
  assert.ok(ms > 7000 && ms <= 11000, String(ms));
  assert.equal(classify(500, null, { retryAfter: "30" }).retryAfterMs, 30000, "a retryable failure may carry it");
  assert.equal(classify(401, null, { retryAfter: "30" }).retryAfterMs, undefined, "a refusal never does");
});

test("a refusal carries the provider's own detail so a person can act on it", () => {
  assert.match(classify(403, { message: "The example.com domain is not verified" }).message, /example\.com domain is not verified/);
});

// ---- rate limit ----
const run = (mw, req) => new Promise((resolve) => mw(req, {}, (err) => resolve(err || null)));
const from = (ip) => ({ headers: { "x-forwarded-for": ip }, ip: "10.0.0.1" });

test("a client is let through up to the limit, then told to wait, with a code the screen can use", async () => {
  const mw = rateLimit({ windowMs: 60000, max: 3, code: "SHARE_RATE_LIMIT", message: "Slow down" });
  for (let i = 0; i < 3; i += 1) assert.equal(await run(mw, from("1.1.1.1")), null);
  const err = await run(mw, from("1.1.1.1"));
  assert.equal(err.statusCode, 429);
  assert.equal(err.errorCode ?? err.code, "SHARE_RATE_LIMIT");
  assert.equal(err.message, "Slow down");
});

test("two clients have separate allowances, and the allowance returns after the window", async () => {
  const mw = rateLimit({ windowMs: 25, max: 1 });
  assert.equal(await run(mw, from("1.1.1.1")), null);
  assert.ok(await run(mw, from("1.1.1.1")));
  assert.equal(await run(mw, from("2.2.2.2")), null);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await run(mw, from("1.1.1.1")), null);
});

test("the key can be anything: per link, per company, per person", async () => {
  const mw = rateLimit({ windowMs: 60000, max: 1, key: (req) => req.params.publicId });
  assert.equal(await run(mw, { ...from("1.1.1.1"), params: { publicId: "A" } }), null);
  assert.ok(await run(mw, { ...from("9.9.9.9"), params: { publicId: "A" } }), "another address, same link");
  assert.equal(await run(mw, { ...from("1.1.1.1"), params: { publicId: "B" } }), null);
});

test("behind a proxy the left-most forwarded address is the client, not the proxy", () => {
  assert.equal(clientIp({ headers: { "x-forwarded-for": "198.51.100.4, 10.0.0.1" }, ip: "10.0.0.9" }), "198.51.100.4");
  assert.equal(clientIp({ headers: {}, ip: "10.0.0.9" }), "10.0.0.9");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "10.0.0.8" } }), "10.0.0.8");
});

test("a stored address is shortened: enough to show a view happened, not to track a person", () => {
  assert.equal(coarseIp("203.0.113.77"), "203.0.113.0");
  assert.equal(coarseIp("2001:db8:85a3:8d3:1319:8a2e:370:7348"), "2001:db8:85a3::");
  assert.equal(coarseIp(""), "");
});
