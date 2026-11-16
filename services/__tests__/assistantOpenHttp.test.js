// Zarvia AI on an open model, end to end: a real server in strict tenant mode, a fake
// OpenAI-compatible service on this machine (standing in for Groq, OpenRouter or a client's Ollama),
// and a question asked over HTTP that goes through a real tool round.
//
// What it proves, beyond the pure adapter tests in assistantProviders.test.js:
//   - the installation can default every organisation to an open model with one key in the environment;
//   - that key reaches ONLY the installation's own address, never an address an organisation typed;
//   - an organisation's own key is stored encrypted and never comes back in a response or a log;
//   - changing the address forgets the stored key;
//   - the connection test says whether the model can use tools, and only settings.manage may run it;
//   - a refused key ends the turn honestly, not with a stub answer.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const H = require("./support/httpHarness");

const skip = H.skipReason();
const INSTALL_KEY = "gsk_INSTALLATION_ONLY_7f3a";
const ORG_KEY = "sk-org-OWN-KEY-91c2";

// ---- the fake service --------------------------------------------------------------------------
const seen = [];
let mode = "ok"; // "ok" | "noTools" | "auth"
function reply(body) {
  const hadToolResult = (body.messages || []).some((m) => m.role === "tool");
  if (mode === "noTools" || hadToolResult) {
    return { id: "c2", model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Close the year from Accounting setup, Fiscal years." } }], usage: { prompt_tokens: 1200, completion_tokens: 18 } };
  }
  return {
    id: "c1",
    model: body.model,
    choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "search_help", arguments: '{"question":"close a fiscal year"}' } }] } }],
    usage: { prompt_tokens: 1000, completion_tokens: 12 },
  };
}
const fake = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch (_) {
      /* recorded as empty */
    }
    seen.push({ path: req.url, auth: req.headers.authorization || "", body });
    if (mode === "auth") {
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "invalid api key" } }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply(body)));
  });
});

let stack;
let call;
let fakeBase;
const tokens = {};

test.before(async () => {
  if (skip) return;
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  fakeBase = `http://127.0.0.1:${fake.address().port}`;
  // Read by the spawned server: the installation's own free open model.
  Object.assign(process.env, {
    ASSISTANT_PROVIDER: "openai",
    ASSISTANT_OPEN_BASE_URL: `${fakeBase}/install/v1`,
    ASSISTANT_OPEN_MODEL: "openai/gpt-oss-120b",
    ASSISTANT_OPEN_API_KEY: INSTALL_KEY,
    ASSISTANT_ALLOW_PRIVATE_HOSTS: "true",
  });
  delete process.env.ASSISTANT_API_KEY;
  stack = await H.startStack("aiopen");
  call = H.makeCaller(stack.base);
  const Admin = require("../../models/core/adminModel");
  for (const code of ["aiorga", "aiorgb"]) {
    await stack.Org.create({ legalName: `${code} Trading LLC`, code, country: "AE", baseCurrency: "AED", timezone: "Asia/Dubai", planCode: "premium" });
    for (const [who, type] of [["owner", "super_admin"], ["viewer", "viewer"]]) {
      const email = `${who}@${code}.ai.test`;
      await stack.as(code, () => new Admin({ name: `${who} ${code}`, email, password: H.PASSWORD, status: "active", isActive: true, type }).save());
      const r = await call("POST", "/login", { body: { email, password: H.PASSWORD } });
      assert.equal(r.status, 200, r.text);
      tokens[`${code}.${who}`] = r.body.tokens.accessToken;
    }
  }
});

test.after(async () => {
  if (stack) await stack.stop();
  fake.close();
});

const as = (code, who, method, url, body) => call(method, url, { token: tokens[`${code}.${who}`], body });

test("with nothing set up, an organisation asks the installation's open model with the installation's key", { skip }, async () => {
  mode = "ok";
  seen.length = 0;
  const r = await as("aiorgb", "viewer", "POST", "/assistant/ask", { question: "How do I close a fiscal year?" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.outcome, "answered", JSON.stringify(r.body));
  assert.equal(r.body.testMode, false);
  assert.match(r.body.answer, /Accounting setup/);
  assert.equal(seen.length, 2, "one round for the tool, one for the answer");
  for (const s of seen) {
    assert.equal(s.path, "/install/v1/chat/completions");
    assert.equal(s.auth, `Bearer ${INSTALL_KEY}`);
    assert.equal(s.body.model, "openai/gpt-oss-120b");
  }
  assert.ok(seen[0].body.tools.some((t) => t.function.name === "search_help"));
  const toolMsg = seen[1].body.messages.find((m) => m.role === "tool");
  assert.equal(toolMsg.tool_call_id, "call_a", "the tool's answer goes back bound to the call that asked for it");

  const { AssistantMessage } = require("../../models/modules/assistant/assistantModels");
  const row = await stack.as("aiorgb", () => AssistantMessage.findOne({}).sort({ createdAt: -1 }).lean());
  assert.equal(row.provider, "openai");
  assert.equal(row.model, "openai/gpt-oss-120b");
  assert.equal(row.usage.inputTokens, 2200);
  assert.equal(row.costMicros, 0, "a free model costs nothing in the report");
});

test("an organisation's own address gets its own key, never the installation's, and the key never comes back", { skip }, async () => {
  const put = await as("aiorga", "owner", "PUT", "/assistant/settings", {
    provider: "openai",
    openBaseUrl: `${fakeBase}/org/v1/`,
    openModel: "qwen3:8b",
    openApiKey: ORG_KEY,
  });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.body.openBaseUrl, `${fakeBase}/org/v1`, "stored without the trailing slash");
  assert.equal(put.body.hasOpenApiKey, true);
  assert.equal(put.body.effective.source, "organisation");
  assert.ok(!put.text.includes(ORG_KEY) && !put.text.includes(INSTALL_KEY), "no key in a response, ever");
  assert.ok(Array.isArray(put.body.presets) && put.body.presets.length >= 3);

  const got = await as("aiorga", "viewer", "GET", "/assistant/settings");
  assert.equal(got.status, 403, "reading the AI settings needs settings.view");

  mode = "ok";
  seen.length = 0;
  const r = await as("aiorga", "viewer", "POST", "/assistant/ask", { question: "How do I close a fiscal year?" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.outcome, "answered");
  assert.ok(seen.length >= 1);
  for (const s of seen) {
    assert.equal(s.path, "/org/v1/chat/completions");
    assert.equal(s.auth, `Bearer ${ORG_KEY}`);
    assert.notEqual(s.auth, `Bearer ${INSTALL_KEY}`);
    assert.equal(s.body.model, "qwen3:8b");
  }

  const { AssistantSettings } = require("../../models/modules/assistant/assistantModels");
  const stored = await stack.as("aiorga", () => AssistantSettings.findOne({}).select("+openApiKeyEnc").lean());
  assert.ok(stored.openApiKeyEnc && !stored.openApiKeyEnc.includes(ORG_KEY), "stored encrypted");
  assert.ok(!stack.logs().includes(ORG_KEY) && !stack.logs().includes(INSTALL_KEY), "no key in the server's log");
});

test("an address the organisation types with no key of its own gets no key at all", { skip }, async () => {
  // A new address without a new key forgets the stored one: nobody can redirect it by editing one box.
  const put = await as("aiorga", "owner", "PUT", "/assistant/settings", { openBaseUrl: `${fakeBase}/elsewhere/v1` });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.body.hasOpenApiKey, false);
  mode = "ok";
  seen.length = 0;
  await as("aiorga", "viewer", "POST", "/assistant/ask", { question: "How do I close a fiscal year?" });
  assert.ok(seen.length >= 1);
  for (const s of seen) {
    assert.equal(s.path, "/elsewhere/v1/chat/completions");
    assert.equal(s.auth, "", "neither the old key nor the installation's follows the address");
  }
});

test("addresses that are not one are refused with the reason", { skip }, async () => {
  for (const bad of ["ftp://x.example/v1", "https://user:pw@x.example/v1", "https://x.example/v1?key=abc", "not a url"]) {
    const r = await as("aiorga", "owner", "PUT", "/assistant/settings", { openBaseUrl: bad });
    assert.equal(r.status, 400, bad);
    assert.equal(r.code, "AI_ENDPOINT_INVALID", bad);
  }
  const model = await as("aiorga", "owner", "PUT", "/assistant/settings", { openModel: "bad model; drop" });
  assert.equal(model.status, 400);
  assert.equal(model.code, "MODEL_NOT_SUPPORTED");
});

test("the connection test says whether the model can use tools, and only settings.manage may run it", { skip }, async () => {
  mode = "ok";
  const ok = await as("aiorga", "owner", "POST", "/assistant/settings/test", { openBaseUrl: `${fakeBase}/org/v1`, openModel: "qwen3:8b", openApiKey: ORG_KEY });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.toolCalling, true);
  assert.equal(typeof ok.body.latencyMs, "number");

  mode = "noTools";
  const weak = await as("aiorga", "owner", "POST", "/assistant/settings/test", {});
  assert.equal(weak.body.ok, true);
  assert.equal(weak.body.toolCalling, false, "a model that never uses the help search is named before a client finds out");

  mode = "auth";
  const refused = await as("aiorga", "owner", "POST", "/assistant/settings/test", {});
  assert.equal(refused.status, 200);
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.code, "PROVIDER_AUTH");

  const viewer = await as("aiorga", "viewer", "POST", "/assistant/settings/test", {});
  assert.equal(viewer.status, 403);

  // testing saved nothing: the settings are as the last save left them
  const after = await as("aiorga", "owner", "GET", "/assistant/settings");
  assert.equal(after.body.openBaseUrl, `${fakeBase}/elsewhere/v1`);
  mode = "ok";
});

test("a refused key ends the question honestly and is remembered for the settings screen", { skip }, async () => {
  mode = "auth";
  const r = await as("aiorga", "viewer", "POST", "/assistant/ask", { question: "How do I close a fiscal year?" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.outcome, "failed");
  assert.match(r.body.answer, /went wrong/);
  const s = await as("aiorga", "owner", "GET", "/assistant/settings");
  assert.equal(s.body.lastErrorCode, "PROVIDER_AUTH");
  mode = "ok";
});
