// The AI provider registry and the provider that needs no account. Pure: no network, no key.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
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
  assert.deepEqual(Object.keys(ai.PROVIDERS), ["echo", "anthropic"]);
  assert.equal(echo.needsKey, false, "the whole pipeline must stay testable with no account");
  assert.equal(ai.providerFor("anthropic").needsKey, true);
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

// ---- the real provider, with the SDK replaced -----------------------------------------------------
//
// No key, no network: a fake client records the request and returns what the API would. These are
// the six facts about this API that are easy to get wrong, so they are asserted rather than trusted.

const fakeClient = (reply) => {
  const seen = [];
  return {
    seen,
    messages: {
      create: async (body) => {
        seen.push(body);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
};

const ANSWER = {
  id: "msg_1",
  model: "claude-opus-5-5",
  stop_reason: "end_turn",
  content: [{ type: "text", text: "Open Accounting setup." }],
  usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
};

const callAnthropic = async (reply, opts = {}) => {
  const client = fakeClient(reply);
  const provider = ai.providerFor("anthropic");
  const out = await provider.complete(
    { stable: "THE RULES", context: "<context>who</context>", messages: [{ role: "user", content: "hello" }], tools: [{ name: "search_help" }], model: "claude-opus-5-5", maxTokens: 1024, effort: "medium" },
    { client, ...opts }
  );
  return { out, body: client.seen[0] };
};

test("the request sends no thinking parameter and does not force a tool", async () => {
  const { body } = await callAnthropic(ANSWER);
  assert.equal("thinking" in body, false, "thinking is a 400 on this model family at every effort");
  assert.equal("budget_tokens" in body, false);
  assert.equal("tool_choice" in body, false, "a forced tool_choice is a 400 on this model family");
  assert.equal(body.output_config.effort, "medium", "effort is the only control over depth");
  assert.equal(body.max_tokens, 1024);
});

test("the cache breakpoint is on the rules alone, so one cached prefix serves every client", async () => {
  const { body } = await callAnthropic(ANSWER);
  assert.equal(body.system.length, 2, "the rules and the volatile context are separate blocks");
  assert.equal(body.system[0].text, "THE RULES");
  assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
  assert.equal(body.system[1].text, "<context>who</context>");
  assert.equal("cache_control" in body.system[1], false, "caching the volatile half would never hit");
});

test("usage comes back mapped, including what was read from cache", async () => {
  const { out } = await callAnthropic(ANSWER);
  assert.equal(out.stopReason, "end_turn");
  assert.deepEqual(out.usage, { inputTokens: 120, outputTokens: 40, cacheReadTokens: 2000, cacheCreationTokens: 0 });
  // 120 in at $4, 40 out at $20, 2000 cached at $0.20 per million
  assert.equal(ai.costMicros("claude-opus-5-5", out.usage), 480 + 800 + 400);
});

test("a refusal is a normal response, and content is passed through untouched", async () => {
  const refusal = { ...ANSWER, stop_reason: "refusal", content: [], stop_details: { type: "refusal", category: "general_harms" } };
  const { out } = await callAnthropic(refusal);
  assert.equal(out.stopReason, "refusal");
  assert.deepEqual(out.content, []);
  assert.equal(out.raw.stopDetails.category, "general_harms");
  // Thinking blocks have to survive: the API requires them back unchanged on the next turn.
  const withThinking = { ...ANSWER, content: [{ type: "thinking", thinking: "" }, { type: "text", text: "hi" }] };
  const { out: kept } = await callAnthropic(withThinking);
  assert.deepEqual(kept.content.map((b) => b.type), ["thinking", "text"]);
});

test("every class of failure becomes a ProviderError the retry ladder understands", async () => {
  const cases = [
    [401, "PROVIDER_AUTH", false],
    [429, "PROVIDER_RATE_LIMITED", true],
    [400, "AI_REQUEST_INVALID", false],
    [503, "PROVIDER_UNREACHABLE", true],
  ];
  for (const [status, code, retryable] of cases) {
    const err = Object.assign(new Error("boom"), { status });
    await assert.rejects(() => callAnthropic(err), (e) => {
      assert.equal(e.name, "ProviderError", String(status));
      assert.equal(e.code, code, String(status));
      assert.equal(e.retryable, retryable, String(status));
      return true;
    });
  }
  await assert.rejects(
    () => ai.providerFor("anthropic").complete({ messages: [] }, {}),
    (e) => e.code === "PROVIDER_AUTH" && e.retryable === false
  );
});

test("the SDK is given an explicit timeout and no retries of its own", () => {
  // Asserted against the source: the SDK defaults to ten minutes and two retries, which would let
  // one background pass hold for half an hour and silently triple a request.
  const src = fs.readFileSync(path.join(__dirname, "..", "assistant", "aiProviders.js"), "utf8");
  assert.match(src, /maxRetries: 0/, "our own ladder owns retries");
  assert.match(src, /timeout: timeoutMs/, "milliseconds in this SDK, and the default is ten minutes");
  assert.match(src, /require\("@anthropic-ai\/sdk"\)/, "required lazily so the server boots without it");
});
