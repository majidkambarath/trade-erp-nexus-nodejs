// Who actually answers. Duck-typed registry, the house pattern from services/messaging/providers.js.
//
//   complete({ stable, context, messages, tools, model, maxTokens, effort }, { apiKey, timeoutMs })
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
