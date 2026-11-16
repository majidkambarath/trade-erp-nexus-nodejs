// Who actually answers. Duck-typed registry, the house pattern from services/messaging/providers.js.
//
//   complete({ stable, context, messages, tools, model, maxTokens, effort }, { key, timeoutMs, baseUrl })
//   (baseUrl is read by the open-model provider only; see the end of this file)
//     -> { content[], stopReason, usage: { inputTokens, outputTokens, cacheReadTokens }, raw }
//     throws ProviderError({ retryable, code, status, retryAfterMs })
//
// `content` mirrors the Messages API: blocks of { type: "text", text } and
// { type: "tool_use", id, name, input }. The service never sees a provider's own shape.
//
// `echo` is the provider that needs no account and no network, and it is the reason the whole
// pipeline - retrieval, the tools, the hand-over, the caps, the HTTP suite - can be tested with no
// key. It drives its behaviour off a marker at the start of the question, exactly as the email
// console provider drives off a recipient's local part. The real provider arrives in its own stage;
// everything around it is already proved by then, so the only new risk is one HTTP call.

const { ProviderError } = require("../../utils/providerError");

const MODELS = {
  // Each entry is { input, output } in dollars per million tokens, for reporting what a question
  // cost. Keep it beside the model list so the two cannot drift.
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.02 },
};
const DEFAULT_MODEL = "claude-opus-5-5";
const isModel = (m) => Object.hasOwn(MODELS, m);

/** What a question cost, in millionths of a dollar, so it can be summed as an integer. */
function costMicros(model, usage = {}) {
  const p = MODELS[model];
  if (!p) return 0;
  const m = (tokens, rate) => Math.round(((Number(tokens) || 0) / 1e6) * rate * 1e6);
  return m(usage.inputTokens, p.input) + m(usage.outputTokens, p.output) + m(usage.cacheReadTokens, p.cacheRead);
}

const textBlock = (text) => ({ type: "text", text });
let echoCall = 0;
const toolBlock = (name, input) => ({ type: "tool_use", id: `echo_${++echoCall}`, name, input });

// The markers echo answers to. Named so a test reads as the thing it is proving.
const MARKERS = {
  "#help": "searches the documentation, then answers from what came back",
  "#screen": "offers a link to a screen",
  "#badscreen": "asks for a screen that does not exist",
  "#escalate": "hands the question to the Zarvia team",
  "#loop": "asks for a tool every single turn, for ever",
  "#refusal": "is declined by the model's own safety classifier",
  "#netfail": "fails with a network error every time",
  "#netfailonce": "fails once, then works",
  "#ratelimit": "is rate limited, with a retry-after",
  "#authfail": "is refused because the key is wrong",
};

const lastUserText = (messages = []) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    const t = (m.content || []).find((b) => b.type === "text");
    if (t) return t.text;
  }
  return "";
};

const toolResultsIn = (messages = []) =>
  messages.filter((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result")).length;

const failedOnce = new Set();

// Longest first: "#netfailonce" starts with "#netfail", and scanning in declaration order matched
// the shorter one, so the fail-once case could never succeed on its second try.
const MARKER_KEYS = Object.keys(MARKERS).sort((a, b) => b.length - a.length);

const usage = (stable, context, out) => ({
  // Rough but honest: a quarter of a token per character is close enough for a stub, and it means
  // the usage rollup and the cost report are exercised with plausible numbers rather than zeros.
  inputTokens: Math.ceil((String(context || "").length + String(out || "").length) / 4),
  outputTokens: Math.ceil(String(out || "").length / 4),
  cacheReadTokens: Math.ceil(String(stable || "").length / 4),
});

const echoProvider = {
  name: "echo",
  needsKey: false,
  async complete({ stable = "", context = "", messages = [], model = DEFAULT_MODEL } = {}, { key = "" } = {}) {
    const asked = String(lastUserText(messages) || "").trim();
    const marker = MARKER_KEYS.find((m) => asked.toLowerCase().startsWith(m)) || "";
    const rounds = toolResultsIn(messages);
    const done = (blocks, stopReason = "end_turn") => ({
      content: blocks,
      stopReason,
      usage: usage(stable, context, blocks.map((b) => b.text || JSON.stringify(b.input || {})).join(" ")),
      raw: { provider: "echo", marker, rounds },
    });

    switch (marker) {
      case "#netfail":
        throw new ProviderError("The AI service could not be reached.", { retryable: true, code: "PROVIDER_UNREACHABLE" });
      case "#netfailonce": {
        const k = `${model}:${asked}`;
        if (!failedOnce.has(k)) {
          failedOnce.add(k);
          throw new ProviderError("The AI service could not be reached.", { retryable: true, code: "PROVIDER_UNREACHABLE" });
        }
        return done([textBlock("That worked on the second try.")]);
      }
      case "#ratelimit":
        throw new ProviderError("Too many requests to the AI service.", { retryable: true, code: "PROVIDER_RATE_LIMITED", status: 429, retryAfterMs: 1500 });
      case "#authfail":
        throw new ProviderError("The AI service refused the key.", { retryable: false, code: "PROVIDER_AUTH", status: 401 });
      case "#refusal":
        // A refusal arrives as a normal response with a stop reason, never as an error. The service
        // has to check stopReason before it reads content, and this is what proves it does.
        return { content: [], stopReason: "refusal", usage: usage(stable, context, ""), raw: { provider: "echo", refusal: "general_harms" } };
      case "#loop":
        return done([toolBlock("search_help", { question: `round ${rounds + 1}` })], "tool_use");
      case "#escalate":
        if (!rounds) return done([toolBlock("ask_support", { summary: "Needs a person", question: asked })], "tool_use");
        return done([textBlock("I have passed that to the Zarvia team and they will come back to you.")]);
      case "#screen":
        if (!rounds) return done([toolBlock("open_screen", { path: "/accounting-setup", label: "Open setup" })], "tool_use");
        return done([textBlock("Open Accounting setup and set the fiscal year there.")]);
      case "#badscreen":
        if (!rounds) return done([toolBlock("open_screen", { path: "/not-a-real-screen", label: "Go" })], "tool_use");
        return done([textBlock("I cannot link you there, but the answer is in Accounting setup.")]);
      case "#help":
      default: {
        if (!rounds) return done([toolBlock("search_help", { question: asked.replace(/^#help\s*/i, "") || "help" })], "tool_use");
        // Quote the first topic it was handed, so a test can prove the answer came from the corpus
        // and not from the model's own memory.
        const title = (context.match(/<topic title="([^"]+)">/) || [])[1];
        return done([
          textBlock(
            title
              ? `Here is what the documentation says, from "${title}".`
              : "The documentation does not cover that, so I have nothing reliable to tell you."
          ),
        ]);
      }
    }
  },
};

const PROVIDERS = { echo: echoProvider };

const providerFor = (name) => {
  const p = PROVIDERS[name];
  if (!p) throw new ProviderError(`There is no AI provider called ${name}.`, { retryable: false, code: "PROVIDER_UNKNOWN" });
  return p;
};

module.exports = { PROVIDERS, providerFor, MODELS, DEFAULT_MODEL, isModel, costMicros, MARKERS, ProviderError };

// ---- the real one ------------------------------------------------------------------------------
//
// Six things about this API are easy to get wrong, and all six are deliberate here:
//
//  1. No `thinking` parameter. On claude-opus-5-5 adaptive thinking is on by default, and both
//     { type: "disabled" } and a token budget are refused with a 400 at every effort level.
//     output_config.effort is the only control, and its default is medium, not high.
//  2. No forced tool_choice. { type: "any" } and { type: "tool" } are a 400 on this model family;
//     `strict: true` on each tool is what keeps the arguments schema-valid instead.
//  3. A refusal arrives as a NORMAL response - HTTP 200 with stop_reason "refusal" - so stop_reason
//     is read before content, every time.
//  4. `timeout` is MILLISECONDS in this SDK, and it defaults to ten minutes with two retries. Both
//     are set explicitly: our own ladder owns retries, and a background pass must not be able to
//     hold for half an hour.
//  5. The cache breakpoint goes on the FIRST system block, so the prefix it caches is the rules
//     alone - identical for every organisation, so one cached prefix serves the installation.
//  6. Thinking blocks must be passed back unchanged, so content is returned as the API gave it and
//     the service pushes the whole array into the next turn rather than picking blocks out of it.

const classifyAi = (err) => {
  const status = Number(err?.status || err?.statusCode || 0);
  const after = Number(err?.headers?.["retry-after"] || 0);
  const retryAfterMs = after > 0 ? after * 1000 : undefined;
  if (status === 401 || status === 403) {
    return { message: "The AI service refused the key.", retryable: false, code: "PROVIDER_AUTH", status };
  }
  if (status === 429) {
    return { message: "The AI service is rate limiting us.", retryable: true, code: "PROVIDER_RATE_LIMITED", status, retryAfterMs };
  }
  if (status === 400 || status === 404 || status === 422) {
    // Our own request is wrong. Retrying sends the identical request, so it cannot help.
    return { message: `The AI service rejected the request (${status}).`, retryable: false, code: "AI_REQUEST_INVALID", status };
  }
  if (status >= 500) {
    return { message: "The AI service is having trouble.", retryable: true, code: "PROVIDER_UNREACHABLE", status };
  }
  return { message: "The AI service could not be reached.", retryable: true, code: "PROVIDER_UNREACHABLE", status: status || undefined };
};

let Sdk = null;
const sdk = () => {
  // Required lazily so the server still boots, and the echo provider still works, when the package
  // is not installed - which is every environment before this feature is switched on.
  if (!Sdk) Sdk = require("@anthropic-ai/sdk");
  return Sdk.default || Sdk;
};

const anthropicProvider = {
  name: "anthropic",
  needsKey: true,
  async complete({ stable = "", context = "", messages = [], tools = [], model = DEFAULT_MODEL, maxTokens = 1024, effort = "medium" } = {}, { key = "", timeoutMs = 60_000, client = null } = {}) {
    if (!client && !key) {
      throw new ProviderError("No AI service key is set.", { retryable: false, code: "PROVIDER_AUTH" });
    }
    const Anthropic = client ? null : sdk();
    const api = client || new Anthropic({ apiKey: key, timeout: timeoutMs, maxRetries: 0 });
    let res;
    try {
      res = await api.messages.create({
        model,
        max_tokens: maxTokens,
        system: [
          { type: "text", text: stable, cache_control: { type: "ephemeral" } },
          { type: "text", text: context },
        ],
        messages,
        tools,
        output_config: { effort },
      });
    } catch (err) {
      const c = classifyAi(err);
      throw new ProviderError(c.message, { retryable: c.retryable, code: c.code, status: c.status, retryAfterMs: c.retryAfterMs, raw: String(err?.message || "").slice(0, 300) });
    }
    const u = res.usage || {};
    return {
      content: res.content || [],
      stopReason: res.stop_reason || "end_turn",
      usage: {
        inputTokens: Number(u.input_tokens || 0),
        outputTokens: Number(u.output_tokens || 0),
        cacheReadTokens: Number(u.cache_read_input_tokens || 0),
        cacheCreationTokens: Number(u.cache_creation_input_tokens || 0),
      },
      raw: { id: res.id, model: res.model, stopDetails: res.stop_details || null },
    };
  },
};

PROVIDERS.anthropic = anthropicProvider;
module.exports.classifyAi = classifyAi;

// ---- open models -------------------------------------------------------------------------------
//
// Any service that speaks the OpenAI chat-completions API: Groq, OpenRouter, Together, DeepSeek,
// Mistral, and a self-hosted Ollama, vLLM or LM Studio. One adapter for all of them, because the API
// is the same and only the address, the key and the model name differ.
//
// The service and its turn loop stay in the Messages shape (content blocks, tool_use, tool_result);
// this adapter translates both ways and nothing outside it knows the other shape exists. That keeps
// the grounding check, the round limit and the tool runner exactly as they were proved for Claude.
//
// Things that are deliberately different from the Claude provider:
//   - no `effort` and no cache_control: neither exists in this API, and some hosts refuse unknown
//     fields with a 400;
//   - no `strict` on a tool: several hosts refuse it, and a small model given a strict schema it
//     cannot follow returns nothing at all. A bad argument is caught by toolkit.run instead;
//   - redirects are refused: the address was typed by a person, and a redirect is how a request to
//     an allowed address ends up somewhere that would not have been allowed;
//   - the key is optional: a self-hosted Ollama has none, so `Authorization` is sent only with one.

// Ready-made starting points for the settings screen. Data, not behaviour: choosing one only fills
// the address and suggests models. Model ids were checked against each host's own list on
// 16 Nov 2026 and rotate often, so the screen always lets a person type their own.
const OPEN_PRESETS = [
  {
    key: "groq",
    label: "Groq (free plan)",
    baseUrl: "https://api.groq.com/openai/v1",
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"],
    needsKey: true,
    note: "Free key from console.groq.com. The free plan has daily limits (about 1,000 questions a day per model). Very fast.",
  },
  {
    key: "openrouter",
    label: "OpenRouter (free models)",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [],
    needsKey: true,
    note: "Free key from openrouter.ai. Choose a model whose name ends in :free and that supports tools; 50 questions a day, 1,000 after a one-time $10 top-up.",
  },
  {
    key: "ollama",
    label: "Ollama (your own server)",
    baseUrl: "http://localhost:11434/v1",
    models: ["qwen3:8b", "qwen3:14b", "gpt-oss:20b"],
    needsKey: false,
    note: "Runs on a machine you control, so nothing leaves your network. Needs a GPU for a useful speed. Replace localhost with the server's address.",
  },
  {
    key: "custom",
    label: "Another OpenAI-compatible service",
    baseUrl: "",
    models: [],
    needsKey: false,
    note: "Together, DeepSeek, Mistral, vLLM, LM Studio or any service that speaks the OpenAI chat-completions API.",
  },
];

const FINISH = { tool_calls: "tool_use", function_call: "tool_use", stop: "end_turn", length: "max_tokens", content_filter: "refusal" };

const textOf = (content) => {
  if (typeof content === "string") return content;
  return (content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
};

/** Messages-shaped history -> chat-completions messages. Pure, exported for the tests. */
function toOpenMessages({ stable = "", context = "", messages = [] } = {}) {
  const out = [{ role: "system", content: [stable, context].filter(Boolean).join("\n\n") }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || [];
      const calls = blocks.filter((b) => b.type === "tool_use");
      const msg = { role: "assistant", content: textOf(blocks) || null };
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input || {}) } }));
      }
      out.push(msg);
      continue;
    }
    // A user turn is either the question (text) or the answers to the tools the model asked for.
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content || [];
    for (const r of blocks.filter((b) => b.type === "tool_result")) {
      out.push({ role: "tool", tool_call_id: r.tool_use_id, content: typeof r.content === "string" ? r.content : JSON.stringify(r.content) });
    }
    const said = textOf(blocks);
    if (said) out.push({ role: "user", content: said });
  }
  return out;
}

/** Tool definitions -> the function-calling shape. `strict` is dropped on purpose (see above). */
const toOpenTools = (tools = []) =>
  tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema || { type: "object", properties: {} } } }));

let openCall = 0;

/** A chat-completions reply -> the Messages-shaped result the service reads. Pure, exported for the tests. */
function fromOpenReply(body = {}) {
  const choice = (body.choices || [])[0] || {};
  const msg = choice.message || {};
  const content = [];
  const said = typeof msg.content === "string" ? msg.content.trim() : textOf(msg.content).trim();
  if (said) content.push({ type: "text", text: said });
  for (const call of msg.tool_calls || []) {
    if (!call || !call.function || !call.function.name) continue;
    let input = {};
    const args = call.function.arguments;
    if (args && typeof args === "object") input = args;
    else if (typeof args === "string" && args.trim()) {
      try {
        const parsed = JSON.parse(args);
        input = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        // A small model wrote arguments that are not JSON. The tool runs with none and says what it
        // needed, which the model can act on in the next round; throwing would lose the whole turn.
        input = {};
      }
    }
    content.push({ type: "tool_use", id: String(call.id || `call_${++openCall}`), name: String(call.function.name), input });
  }
  const hasCalls = content.some((b) => b.type === "tool_use");
  // Some hosts report "stop" even when they returned tool calls; the calls are what matter.
  const stopReason = hasCalls ? "tool_use" : FINISH[choice.finish_reason] || "end_turn";
  const u = body.usage || {};
  return {
    content,
    stopReason,
    usage: {
      inputTokens: Number(u.prompt_tokens || 0),
      outputTokens: Number(u.completion_tokens || 0),
      cacheReadTokens: Number(u.prompt_tokens_details?.cached_tokens || 0),
    },
    raw: { id: body.id || "", model: body.model || "", finishReason: choice.finish_reason || "" },
  };
}

const openProvider = {
  name: "openai",
  needsKey: false,
  async complete(
    { stable = "", context = "", messages = [], tools = [], model = "", maxTokens = 1024, effort = "" } = {},
    { key = "", baseUrl = "", timeoutMs = 60_000, fetchImpl = null } = {}
  ) {
    if (!baseUrl) throw new ProviderError("No address is set for the AI service.", { retryable: false, code: "AI_REQUEST_INVALID" });
    if (!model) throw new ProviderError("No model is chosen for the AI service.", { retryable: false, code: "AI_REQUEST_INVALID" });
    const doFetch = fetchImpl || globalThis.fetch;
    const body = { model, max_tokens: maxTokens, messages: toOpenMessages({ stable, context, messages }) };
    // gpt-oss thinks before it answers and that thinking is counted in max_tokens and in the per-minute allowance, so its effort
    // is passed on (the same low / medium / high setting Claude uses). Only to a model that takes it: another host may refuse the field.
    if (/gpt-oss/i.test(model) && ["low", "medium", "high"].includes(effort)) body.reasoning_effort = effort;
    if (tools.length) {
      body.tools = toOpenTools(tools);
      body.tool_choice = "auto";
    }
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let res;
    let text = "";
    try {
      res = await doFetch(`${baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: abort.signal, redirect: "manual" });
      text = await res.text();
    } catch (err) {
      const timedOut = err?.name === "AbortError";
      throw new ProviderError(timedOut ? "The AI service took too long to answer." : "The AI service could not be reached.", {
        retryable: true,
        code: "PROVIDER_UNREACHABLE",
        raw: String(err?.message || "").slice(0, 300),
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      throw new ProviderError("The AI service answered with a redirect, which is not followed. Check the address.", { retryable: false, code: "AI_REQUEST_INVALID", status: res.status });
    }
    if (!res.ok) {
      // Groq (and others) check a tool call against its schema and answer 400 "tool_use_failed" when the model wrote a
      // malformed one. That is the model's slip, not our request: the same question asked again usually works.
      if (res.status === 400 && /tool_use_failed/.test(text)) {
        throw new ProviderError("The model wrote a tool call the AI service could not read.", { retryable: true, code: "PROVIDER_TOOL_FAILED", status: 400, raw: text.slice(0, 300) });
      }
      const retryAfter = typeof res.headers?.get === "function" ? res.headers.get("retry-after") : undefined;
      const c = classifyAi({ status: res.status, headers: { "retry-after": retryAfter } });
      throw new ProviderError(c.message, { retryable: c.retryable, code: c.code, status: c.status, retryAfterMs: c.retryAfterMs, raw: text.slice(0, 300) });
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ProviderError("The AI service answered with something that is not JSON. Check the address ends in /v1.", { retryable: false, code: "AI_REQUEST_INVALID", status: res.status, raw: text.slice(0, 300) });
    }
    if (parsed && parsed.error) {
      // Some hosts answer 200 with an error body. Treat it as the request being refused.
      throw new ProviderError("The AI service refused the request.", { retryable: false, code: "AI_REQUEST_INVALID", raw: JSON.stringify(parsed.error).slice(0, 300) });
    }
    return fromOpenReply(parsed);
  },
};

PROVIDERS.openai = openProvider;
Object.assign(module.exports, { OPEN_PRESETS, toOpenMessages, toOpenTools, fromOpenReply });
