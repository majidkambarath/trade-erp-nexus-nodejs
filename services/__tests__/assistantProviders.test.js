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
  assert.deepEqual(Object.keys(ai.PROVIDERS), ["echo", "anthropic", "openai"]);
  assert.equal(echo.needsKey, false, "the whole pipeline must stay testable with no account");
  assert.equal(ai.providerFor("anthropic").needsKey, true);
  assert.equal(ai.providerFor("openai").needsKey, false, "a self-hosted Ollama has no key");
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

// ---- which provider answers ----------------------------------------------------------------------

test("a client is never served canned stub answers as if they were real", () => {
  const AssistantService = require("../assistant/assistantService");
  const pick = (row, env) => AssistantService.resolveProvider(row, env);
  // nothing configured anywhere: the stub, and the answer carries testMode so the panel says so
  assert.equal(pick({}, {}), "echo");
  // our key in the environment is enough: an organisation that never chose gets the real one
  assert.equal(pick({}, { ASSISTANT_API_KEY: "sk-ant-x" }), "anthropic");
  // or their own key, saved against the organisation
  assert.equal(pick({ apiKeyEnc: "v1:..." }, {}), "anthropic");
  // but a deliberate choice always stands, in either direction
  assert.equal(pick({ providerChosen: true, provider: "echo" }, { ASSISTANT_API_KEY: "sk-ant-x" }), "echo");
  assert.equal(pick({ providerChosen: true, provider: "anthropic" }, {}), "anthropic");
});

test("the installation can default every organisation to an open model, and a choice still stands", () => {
  const AssistantService = require("../assistant/assistantService");
  const pick = (row, env) => AssistantService.resolveProvider(row, env);
  const open = { ASSISTANT_PROVIDER: "openai", ASSISTANT_OPEN_BASE_URL: "https://api.groq.com/openai/v1", ASSISTANT_OPEN_MODEL: "openai/gpt-oss-120b" };
  assert.equal(pick({}, open), "openai");
  // half configured is not configured: no model, no open provider, so nobody gets a broken assistant
  assert.equal(pick({}, { ASSISTANT_PROVIDER: "openai", ASSISTANT_OPEN_BASE_URL: "https://x.example/v1" }), "echo");
  // explicit beats an old Claude key in the environment
  assert.equal(pick({}, { ...open, ASSISTANT_API_KEY: "sk-ant-x" }), "openai");
  // an organisation's own Claude key, and its own choice, still win
  assert.equal(pick({ apiKeyEnc: "v1:..." }, open), "anthropic");
  assert.equal(pick({ providerChosen: true, provider: "anthropic" }, open), "anthropic");
  assert.equal(pick({ providerChosen: true, provider: "openai" }, {}), "openai");
});

test("the installation's open-model key goes only to the installation's own address", () => {
  const AssistantService = require("../assistant/assistantService");
  const env = {
    ASSISTANT_PROVIDER: "openai",
    ASSISTANT_OPEN_BASE_URL: "https://api.groq.com/openai/v1/",
    ASSISTANT_OPEN_MODEL: "openai/gpt-oss-120b",
    ASSISTANT_OPEN_API_KEY: "gsk_OURS",
  };
  const ours = AssistantService.connection({}, env);
  assert.deepEqual(
    { provider: ours.provider, model: ours.model, baseUrl: ours.baseUrl, key: ours.key, source: ours.source },
    { provider: "openai", model: "openai/gpt-oss-120b", baseUrl: "https://api.groq.com/openai/v1", key: "gsk_OURS", source: "installation" }
  );
  // an organisation that typed its own address gets its own key or none - never ours
  const typed = AssistantService.connection({ providerChosen: true, provider: "openai", openBaseUrl: "https://attacker.example/v1", openModel: "x" }, env);
  assert.equal(typed.baseUrl, "https://attacker.example/v1");
  assert.equal(typed.key, "", "our key must never be sent to an address somebody typed");
  assert.equal(typed.source, "organisation");
  // it may choose another model at our address, and still use our key there
  const ownModel = AssistantService.connection({ openModel: "openai/gpt-oss-20b" }, env);
  assert.equal(ownModel.model, "openai/gpt-oss-20b");
  assert.equal(ownModel.key, "gsk_OURS");
  assert.equal(ownModel.timeoutMs, 60_000);
});

// ---- the open-model provider -----------------------------------------------------------------------

const openai = ai.providerFor("openai");
const TOOLS = require("../assistant/toolkit").definitions();

// A fetch that records what it was sent and answers with `reply`.
function fakeFetch(reply, { status = 200, headers = {} } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const text = typeof reply === "string" ? reply : JSON.stringify(reply);
    return { status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] }, text: async () => text };
  };
  fn.calls = calls;
  return fn;
}

const toolReply = {
  id: "chatcmpl-1",
  model: "openai/gpt-oss-120b",
  choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "search_help", arguments: '{"question":"fiscal year"}' } }] } }],
  usage: { prompt_tokens: 900, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 300 } },
};

test("an open model is asked in the chat-completions shape, with nothing only Claude understands", async () => {
  const f = fakeFetch(toolReply);
  const history = [
    { role: "user", content: "<question>How do I close a year?</question>" },
    { role: "assistant", content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "call_0", name: "search_help", input: { question: "close year" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_0", content: '{"found":1}' }] },
  ];
  await openai.complete(
    { stable: "RULES", context: "CONTEXT", messages: history, tools: TOOLS, model: "qwen/qwen3-32b", maxTokens: 512, effort: "high" },
    { key: "gsk_test", baseUrl: "https://api.groq.com/openai/v1", fetchImpl: f }
  );
  const { url, init, body } = f.calls[0];
  assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "manual", "a redirect is how an allowed address leads somewhere that is not");
  assert.equal(init.headers.Authorization, "Bearer gsk_test");
  assert.equal(body.model, "qwen/qwen3-32b");
  assert.equal(body.max_tokens, 512);
  assert.deepEqual(body.messages[0], { role: "system", content: "RULES\n\nCONTEXT" });
  assert.deepEqual(body.messages[1], { role: "user", content: "<question>How do I close a year?</question>" });
  assert.equal(body.messages[2].role, "assistant");
  assert.equal(body.messages[2].content, "Let me look.");
  assert.deepEqual(body.messages[2].tool_calls, [{ id: "call_0", type: "function", function: { name: "search_help", arguments: '{"question":"close year"}' } }]);
  assert.deepEqual(body.messages[3], { role: "tool", tool_call_id: "call_0", content: '{"found":1}' });
  assert.equal(body.messages.length, 4);
  assert.equal(body.tools.length, TOOLS.length);
  assert.equal(body.tools[0].type, "function");
  assert.equal(body.tools[0].function.name, "search_help");
  assert.deepEqual(body.tools[0].function.parameters, TOOLS[0].input_schema);
  assert.equal(body.tool_choice, "auto");
  const raw = JSON.stringify(body);
  for (const word of ["strict", "effort", "cache_control", "output_config", "input_schema"]) {
    assert.ok(!raw.includes(word), `${word} is Claude's, and some hosts refuse an unknown field`);
  }
});

test("gpt-oss is told how hard to think, because its thinking counts against the per-minute allowance; another model is not", async () => {
  const sent = async (model, effort) => {
    const f = fakeFetch({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] });
    await openai.complete({ messages: [{ role: "user", content: "q" }], model, effort }, { baseUrl: "https://h.example/v1", fetchImpl: f });
    return f.calls[0].body;
  };
  assert.equal((await sent("openai/gpt-oss-120b", "low")).reasoning_effort, "low");
  assert.equal((await sent("openai/gpt-oss-20b", "high")).reasoning_effort, "high");
  assert.equal("reasoning_effort" in (await sent("openai/gpt-oss-120b", "")), false, "no effort given, none sent");
  assert.equal("reasoning_effort" in (await sent("openai/gpt-oss-120b", "extreme")), false, "a value the host does not know is not sent");
  assert.equal("reasoning_effort" in (await sent("qwen3:8b", "high")), false, "another host may refuse the field");
});

test("its reply comes back in the shape the service reads: tool calls, stop reason, usage", async () => {
  const out = await openai.complete({ messages: [{ role: "user", content: "q" }], tools: TOOLS, model: "m" }, { baseUrl: "https://h.example/v1", fetchImpl: fakeFetch(toolReply) });
  assert.equal(out.stopReason, "tool_use");
  assert.deepEqual(out.content, [{ type: "tool_use", id: "call_1", name: "search_help", input: { question: "fiscal year" } }]);
  assert.deepEqual(out.usage, { inputTokens: 900, outputTokens: 20, cacheReadTokens: 300 });

  const text = await openai.complete({ messages: [{ role: "user", content: "q" }], model: "m" }, {
    baseUrl: "https://h.example/v1",
    fetchImpl: fakeFetch({ choices: [{ finish_reason: "stop", message: { content: "  Open Accounting setup.  " } }] }),
  });
  assert.equal(text.stopReason, "end_turn");
  assert.deepEqual(text.content, [{ type: "text", text: "Open Accounting setup." }]);
  assert.deepEqual(text.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, "a host that reports no usage reads as nothing, not NaN");
});

test("the finish reasons map, and tool calls win over a host that says 'stop' anyway", () => {
  const r = (finish, msg = { content: "x" }) => ai.fromOpenReply({ choices: [{ finish_reason: finish, message: msg }] }).stopReason;
  assert.equal(r("stop"), "end_turn");
  assert.equal(r("length"), "max_tokens");
  assert.equal(r("content_filter"), "refusal", "a refusal must reach the service as a refusal");
  assert.equal(r(undefined), "end_turn");
  assert.equal(r("stop", { tool_calls: [{ id: "a", function: { name: "search_help", arguments: "{}" } }] }), "tool_use");
});

test("arguments a small model mangled become no arguments, never a lost turn", () => {
  const out = ai.fromOpenReply({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          tool_calls: [
            { id: "a", function: { name: "search_help", arguments: "{question: fiscal" } },
            { id: "b", function: { name: "open_screen", arguments: "[1,2]" } },
            { id: "c", function: { name: "search_help", arguments: { question: "already an object" } } },
            { id: "d", function: {} },
            { function: { name: "ask_support", arguments: "" } },
          ],
        },
      },
    ],
  });
  assert.deepEqual(
    out.content.map((b) => [b.name, b.input]),
    [
      ["search_help", {}],
      ["open_screen", {}],
      ["search_help", { question: "already an object" }],
      ["ask_support", {}],
    ]
  );
  assert.ok(out.content[3].id, "a call with no id gets one, or its result could not be matched to it");
});

test("no key means no Authorization header, so a self-hosted Ollama works", async () => {
  const f = fakeFetch({ choices: [{ finish_reason: "stop", message: { content: "hi" } }] });
  await openai.complete({ messages: [{ role: "user", content: "q" }], model: "qwen3:8b" }, { baseUrl: "http://localhost:11434/v1", fetchImpl: f });
  assert.equal(f.calls[0].init.headers.Authorization, undefined);
  assert.equal(f.calls[0].body.tools, undefined, "no tools, no tools field: some servers refuse an empty list");
});

test("an open model's failures are the same error codes as Claude's", async () => {
  const fail = (status, headers) =>
    openai.complete({ messages: [{ role: "user", content: "q" }], model: "m" }, { baseUrl: "https://h.example/v1", fetchImpl: fakeFetch({ error: "no" }, { status, headers }) });
  await assert.rejects(fail(401), (e) => e.code === "PROVIDER_AUTH" && e.retryable === false);
  await assert.rejects(fail(429, { "retry-after": "7" }), (e) => e.code === "PROVIDER_RATE_LIMITED" && e.retryAfterMs === 7000);
  await assert.rejects(fail(404), (e) => e.code === "AI_REQUEST_INVALID");
  // Groq's 400 when the model wrote a malformed tool call: the model's slip, worth one more try - not our request being wrong
  const slip = openai.complete({ messages: [{ role: "user", content: "q" }], model: "m" }, { baseUrl: "https://h.example/v1", fetchImpl: fakeFetch({ error: { message: "Failed to call a function.", type: "invalid_request_error", code: "tool_use_failed" } }, { status: 400 }) });
  await assert.rejects(slip, (e) => e.code === "PROVIDER_TOOL_FAILED" && e.retryable === true);
  await assert.rejects(fail(400), (e) => e.code === "AI_REQUEST_INVALID" && e.retryable === false, "any other 400 is still our request");
  await assert.rejects(fail(503), (e) => e.code === "PROVIDER_UNREACHABLE" && e.retryable === true);
  await assert.rejects(fail(302), (e) => e.code === "AI_REQUEST_INVALID" && /redirect/.test(e.message));
  // 200 with an error body, and 200 with something that is not JSON (an address missing /v1)
  await assert.rejects(
    openai.complete({ messages: [], model: "m" }, { baseUrl: "https://h.example/v1", fetchImpl: fakeFetch({ error: { message: "model not found" } }) }),
    (e) => e.code === "AI_REQUEST_INVALID"
  );
  await assert.rejects(
    openai.complete({ messages: [], model: "m" }, { baseUrl: "https://h.example", fetchImpl: fakeFetch("<html>hello</html>") }),
    (e) => e.code === "AI_REQUEST_INVALID" && /\/v1/.test(e.message)
  );
  const down = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(openai.complete({ messages: [], model: "m" }, { baseUrl: "https://h.example/v1", fetchImpl: down }), (e) => e.code === "PROVIDER_UNREACHABLE" && e.retryable);
  // a missing address or model is refused before any request is made
  await assert.rejects(openai.complete({ messages: [], model: "m" }, {}), (e) => e.code === "AI_REQUEST_INVALID");
  await assert.rejects(openai.complete({ messages: [] }, { baseUrl: "https://h.example/v1" }), (e) => e.code === "AI_REQUEST_INVALID");
});

test("a slow service is cut off at the timeout, not left hanging", async () => {
  const hang = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  const started = Date.now();
  await assert.rejects(
    openai.complete({ messages: [], model: "m" }, { baseUrl: "https://h.example/v1", timeoutMs: 50, fetchImpl: hang }),
    (e) => e.code === "PROVIDER_UNREACHABLE" && /too long/.test(e.message)
  );
  assert.ok(Date.now() - started < 2000);
});

test("the presets are data the screen can draw, each with an address the rules accept", () => {
  const { checkAiEndpoint } = require("../../utils/aiEndpoint");
  assert.deepEqual(ai.OPEN_PRESETS.map((p) => p.key), ["groq", "openrouter", "ollama", "custom"]);
  for (const p of ai.OPEN_PRESETS) {
    assert.ok(p.label && p.note, p.key);
    assert.ok(Array.isArray(p.models));
    if (p.baseUrl) assert.ok(checkAiEndpoint(p.baseUrl).ok, p.key);
  }
  // the hosted free ones are https, so they pass in production too
  for (const k of ["groq", "openrouter"]) {
    assert.ok(checkAiEndpoint(ai.OPEN_PRESETS.find((p) => p.key === k).baseUrl, { production: true }).ok, k);
  }
});
