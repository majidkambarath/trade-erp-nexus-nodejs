// Where Zarvia AI may send a question when it runs on an open model. Pure.
const test = require("node:test");
const assert = require("node:assert/strict");
const { checkAiEndpoint, checkModelId } = require("../aiEndpoint");

const prod = { production: true };

test("a hosted service's address is accepted and normalised", () => {
  assert.deepEqual(checkAiEndpoint("https://api.groq.com/openai/v1/", prod), { ok: true, url: "https://api.groq.com/openai/v1" });
  assert.deepEqual(checkAiEndpoint("  https://openrouter.ai/api/v1  ", prod), { ok: true, url: "https://openrouter.ai/api/v1" });
});

test("nothing that is not a web address", () => {
  for (const bad of ["", "   ", null, undefined, "api.groq.com", "ftp://x.example/v1", "file:///etc/passwd", "javascript:alert(1)", `https://x.example/${"a".repeat(400)}`]) {
    assert.equal(checkAiEndpoint(bad).ok, false, String(bad).slice(0, 40));
  }
});

test("no key or password in the address, where it would be stored and shown", () => {
  assert.equal(checkAiEndpoint("https://user:pass@x.example/v1").ok, false);
  assert.equal(checkAiEndpoint("https://x.example/v1?api_key=abc").ok, false);
  assert.equal(checkAiEndpoint("https://x.example/v1#frag").ok, false);
});

test("in production: no plain http, and nothing on this machine or the private network", () => {
  assert.equal(checkAiEndpoint("http://api.example.com/v1", prod).ok, false);
  for (const host of ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.20", "172.16.0.1", "169.254.169.254", "[::1]", "gpu.local", "box.internal", "100.64.0.1"]) {
    assert.equal(checkAiEndpoint(`https://${host}:11434/v1`, prod).ok, false, host);
  }
});

test("a client's own Ollama on its network is allowed only when the installation says so", () => {
  assert.deepEqual(checkAiEndpoint("http://192.168.1.20:11434/v1", { production: true, allowPrivate: true }), { ok: true, url: "http://192.168.1.20:11434/v1" });
  // and outside production a local one is fine: a developer's own laptop
  assert.equal(checkAiEndpoint("http://localhost:11434/v1").ok, true);
});

test("a model name is what hosts write, and nothing that could break out of a field", () => {
  for (const ok of ["openai/gpt-oss-120b", "qwen3:8b", "meta-llama/llama-3.3-70b-instruct:free", "gpt-oss:20b", "Qwen/Qwen3-14B-AWQ"]) {
    assert.equal(checkModelId(ok), true, ok);
  }
  for (const bad of ["", "has space", "a\nb", "<script>", "x".repeat(201), "a;b"]) {
    assert.equal(checkModelId(bad), false, bad);
  }
});
