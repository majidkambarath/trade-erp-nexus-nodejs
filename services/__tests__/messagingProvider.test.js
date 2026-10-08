// The email providers, with fetch replaced: no network, no database, no account. It asserts the exact
// request Resend would receive, and what each kind of answer becomes. This is the only place the wire
// format is pinned down, so a change to it fails here and not in a client inbox.
const test = require("node:test");
const assert = require("node:assert/strict");
const { PROVIDERS, ProviderError, formatFrom, RESEND_URL } = require("../messaging/providers");

const message = (over = {}) => ({
  from: "Harbour Trading <accounts@harbour.ae>", to: ["ali@alnoor.ae"], cc: ["boss@alnoor.ae"], bcc: [], replyTo: "ar@harbour.ae",
  subject: "Tax invoice INV-1", html: "<p>hi</p>", text: "hi", idempotencyKey: "send-123",
  attachments: [{ filename: "Tax-invoice_INV-1.pdf", content: Buffer.from("%PDF-1.4 fake"), contentType: "application/pdf" }],
  ...over,
});
const reply = (status, body, headers = {}) => async () => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const send = (fetchImpl, msg = message(), extra = {}) => PROVIDERS.resend.send(msg, { apiKey: "re_test_key", fetch: fetchImpl, ...extra });
const failureOf = async (fetchImpl) => {
  try { await send(fetchImpl); } catch (e) { return e; }
  throw new Error("expected a failure");
};

test("the request is exactly what Resend expects", async () => {
  let seen;
  const r = await send(async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ id: "re-1" }), { status: 200 }); });
  assert.equal(seen.url, RESEND_URL);
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.Authorization, "Bearer re_test_key");
  assert.equal(seen.init.headers["Content-Type"], "application/json");
  assert.equal(seen.init.headers["Idempotency-Key"], "send-123");
  assert.deepEqual(seen.body.to, ["ali@alnoor.ae"]);
  assert.deepEqual(seen.body.cc, ["boss@alnoor.ae"]);
  assert.equal("bcc" in seen.body, false, "an empty list is left out");
  assert.equal(seen.body.from, "Harbour Trading <accounts@harbour.ae>");
  assert.equal(seen.body.reply_to, "ar@harbour.ae");
  assert.equal(seen.body.subject, "Tax invoice INV-1");
  assert.equal(seen.body.html, "<p>hi</p>");
  assert.equal(seen.body.text, "hi");
  assert.deepEqual(seen.body.attachments, [{ filename: "Tax-invoice_INV-1.pdf", content: Buffer.from("%PDF-1.4 fake").toString("base64") }]);
  assert.ok(seen.init.signal, "a time limit is set");
  assert.deepEqual(r, { messageId: "re-1", raw: { id: "re-1" } });
});

test("a message with no attachment and no reply-to sends neither", async () => {
  let body;
  await send(async (_u, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ id: "x" }), { status: 200 }); }, message({ attachments: [], replyTo: "", cc: [] }));
  assert.equal("attachments" in body, false);
  assert.equal("reply_to" in body, false);
  assert.equal("cc" in body, false);
});

test("what each kind of answer becomes", async () => {
  const cases = [
    [401, { name: "invalid_api_key" }, "PROVIDER_AUTH", false],
    [403, { message: "The harbour.ae domain is not verified" }, "FROM_NOT_VERIFIED", false],
    [422, { name: "validation_error", message: "Invalid `to` email address" }, "INVALID_ADDRESS", false],
    [429, { name: "rate_limit_exceeded" }, "PROVIDER_RATE_LIMIT", true],
    [429, { name: "daily_quota_exceeded" }, "PROVIDER_QUOTA", false],
    [500, { message: "oops" }, "PROVIDER_UNAVAILABLE", true],
  ];
  for (const [status, body, code, retryable] of cases) {
    const e = await failureOf(reply(status, body));
    assert.ok(e instanceof ProviderError, `${status}`);
    assert.equal(e.code, code, `${status}`);
    assert.equal(e.retryable, retryable, `${status}`);
    assert.equal(e.status, status);
  }
});

test("Retry-After on a 429 becomes the delay before the next attempt", async () => {
  const e = await failureOf(reply(429, { name: "rate_limit_exceeded" }, { "retry-after": "30" }));
  assert.equal(e.retryAfterMs, 30000);
});

test("a provider that answers with nothing readable is still classified by its status", async () => {
  const e = await failureOf(async () => new Response("<html>bad gateway</html>", { status: 502 }));
  assert.equal(e.code, "PROVIDER_UNAVAILABLE");
  assert.equal(e.retryable, true);
});

test("the network failing is retryable and says so", async () => {
  const e = await failureOf(async () => { throw new TypeError("fetch failed"); });
  assert.equal(e.code, "PROVIDER_UNREACHABLE");
  assert.equal(e.retryable, true);
});

test("a provider that never answers is cut off, and that is retryable too", async () => {
  const hang = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  let e;
  // AbortSignal.timeout does not keep the process alive; a running server always is, a test is not
  const keepAlive = setTimeout(() => {}, 2000);
  try { await send(hang, message(), { timeoutMs: 30 }); } catch (err) { e = err; }
  clearTimeout(keepAlive);
  assert.equal(e.code, "PROVIDER_TIMEOUT");
  assert.equal(e.retryable, true);
});

test("the console provider records and sends nothing, and fails on request so the pipeline can be exercised", async () => {
  const ok = await PROVIDERS.console.send(message());
  assert.match(ok.messageId, /^console-/);
  for (const [local, code, retryable] of [["netfail", "PROVIDER_UNREACHABLE", true], ["ratelimit", "PROVIDER_RATE_LIMIT", true], ["badaddr", "INVALID_ADDRESS", false], ["authfail", "PROVIDER_AUTH", false]]) {
    await assert.rejects(() => PROVIDERS.console.send(message({ to: [`${local}@example.com`] })), (e) => e.code === code && e.retryable === retryable, local);
  }
});

test("netfailonce fails the first attempt of a message and accepts the next", async () => {
  const m = message({ to: ["netfailonce@example.com"], idempotencyKey: "once-1" });
  await assert.rejects(() => PROVIDERS.console.send(m), (e) => e.code === "PROVIDER_UNREACHABLE");
  assert.match((await PROVIDERS.console.send(m)).messageId, /^console-/);
});

test("the sender line cannot be broken out of by a company name", () => {
  assert.equal(formatFrom("Harbour <Trading> \"LLC\"\r\nBcc: x@y.z", "a@h.ae"), "Harbour Trading LLCBcc: x@y.z <a@h.ae>");
  assert.equal(formatFrom("", "a@h.ae"), "a@h.ae");
});
