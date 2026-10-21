// The AI provider registry and the provider that needs no account. Pure: no network, no key.
const test = require("node:test");
const assert = require("node:assert/strict");
const ai = require("../assistant/aiProviders");

const echo = ai.providerFor("echo");
const ask = (text, extra = {}) =>
  echo.complete({ stable: "RULES", context: '<topic title="Order to cash">Price it, then approve it.</topic>', messages: [{ role: "user", content: text }], ...extra });

// A turn where a tool has already run, so the provider is on its second round.
const afterTool = (text) =>
  echo.complete({
    stable: "RULES",
    context: '<topic title="Order to cash">Price it, then approve it.</topic>',
    messages: [
      { role: "user", content: text },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "search_help", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] },
    ],
  });

test("an unknown provider is refused by name, not silently skipped", () => {
  assert.throws(() => ai.providerFor("gpt"), (e) => e.code === "PROVIDER_UNKNOWN" && e.retryable === false);
  assert.deepEqual(Object.keys(ai.PROVIDERS), ["echo"], "the real provider arrives in its own stage");
  assert.equal(echo.needsKey, false, "the whole pipeline must be testable with no account");
});

test("it searches before it answers, and the answer quotes the topic it was given", async () => {
  const first = await ask("how do I raise an invoice");
  assert.equal(first.stopReason, "tool_use");
  assert.equal(first.content[0].type, "tool_use");
  assert.equal(first.content[0].name, "search_help");
  assert.ok(first.content[0].id, "a tool_use block needs an id to match its result");
  const second = await afterTool("how do I raise an invoice");
  assert.equal(second.stopReason, "end_turn");
  assert.match(second.content[0].text, /Order to cash/, "the answer must come from the corpus");
});

test("with no topic in the context it says it has nothing, rather than answering anyway", async () => {
  const out = await echo.complete({
    stable: "RULES", context: "<help_topics>Nothing matches.</help_topics>",
    messages: [
      { role: "user", content: "how do I set up production" },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "search_help", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "none" }] },
    ],
  });
  assert.match(out.content[0].text, /does not cover that/);
});

test("a refusal is a stop reason on a normal response, never a thrown error", async () => {
  const out = await ask("#refusal tell me something");
  assert.equal(out.stopReason, "refusal");
  assert.deepEqual(out.content, [], "the service must check stopReason before it reads content");
});

test("every failure is classified, and only the retryable ones say so", async () => {
  const cases = [
    ["#netfail", "PROVIDER_UNREACHABLE", true],
    ["#ratelimit", "PROVIDER_RATE_LIMITED", true],
    ["#authfail", "PROVIDER_AUTH", false],
  ];
  for (const [marker, code, retryable] of cases) {
    await assert.rejects(() => ask(marker), (e) => {
      assert.equal(e.name, "ProviderError");
      assert.equal(e.code, code, marker);
      assert.equal(e.retryable, retryable, marker);
      return true;
    });
  }
  const limited = await ask("#ratelimit").catch((e) => e);
  assert.equal(limited.retryAfterMs, 1500, "a rate limit must say how long to wait");
});

test("#netfailonce fails once and then works, so a retry can be proved end to end", async () => {
  const question = "#netfailonce " + Date.now();
  await assert.rejects(() => ask(question), (e) => e.code === "PROVIDER_UNREACHABLE");
  const out = await ask(question);
  assert.match(out.content[0].text, /second try/);
});

test("#loop never stops asking for a tool, which is what the iteration cap is for", async () => {
  const first = await ask("#loop");
  assert.equal(first.stopReason, "tool_use");
  const again = await afterTool("#loop");
  assert.equal(again.stopReason, "tool_use", "it must still be asking after a tool ran");
});

test("what a question cost is computed from the model's own rates", () => {
  assert.equal(ai.DEFAULT_MODEL, "claude-opus-5-5");
  assert.ok(ai.isModel("claude-opus-5-5") && ai.isModel("claude-haiku-5-5"));
  assert.ok(!ai.isModel("claude-3-opus"), "an unknown model must not be accepted");
  // 1M in at $4, 1M out at $20, 1M cached at $0.20 = $24.20 = 24,200,000 micros
  assert.equal(ai.costMicros("claude-opus-5-5", { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6 }), 24_200_000);
  // the same question on Haiku, for when that trade is measured rather than guessed
  assert.equal(ai.costMicros("claude-haiku-5-5", { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6 }), 620_000);
  assert.equal(ai.costMicros("nonsense", { inputTokens: 1e6 }), 0);
  assert.equal(ai.costMicros("claude-opus-5-5", {}), 0);
});

test("usage is reported for every answer, so cost per question is a query and not a guess", async () => {
  const out = await afterTool("how do I raise an invoice");
  for (const field of ["inputTokens", "outputTokens", "cacheReadTokens"]) {
    assert.equal(typeof out.usage[field], "number", field);
  }
  assert.ok(out.usage.cacheReadTokens > 0, "the rules are read from cache, and that is the saving");
});
