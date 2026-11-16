// Where Zarvia AI may send a question when it runs on an open model. Pure: { ok, url } or
// { ok: false, reason }.
//
// An "open model" is reached through the OpenAI-compatible API that Groq, OpenRouter, Together,
// Ollama, vLLM and LM Studio all speak, so the address is something an administrator TYPES - and the
// server then makes requests to it. The rules keep that from becoming a way to reach this machine or
// the private network (in production), and keep a key or a password out of an address that is stored
// and shown. A host NAME that resolves to a private address is not caught: this is a guard against a
// mistake, the same as utils/smtp.js checkSmtpTarget, not a boundary.
const { isLocalOrPrivateHost } = require("./smtp");

const MAX_LENGTH = 300;

// A model id as the hosts write them: "openai/gpt-oss-120b", "qwen3:8b", "meta-llama/llama-3.3-70b-instruct:free".
const MODEL_ID = /^[\w.:/@+-]{1,200}$/;
const checkModelId = (m) => MODEL_ID.test(String(m || "").trim());

function checkAiEndpoint(raw, { production = false, allowPrivate = false } = {}) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, reason: "Enter the address of the AI service, for example https://api.groq.com/openai/v1" };
  if (text.length > MAX_LENGTH) return { ok: false, reason: "That address is too long." };
  let u;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, reason: "That does not look like a web address. It starts with https://" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "The address must start with https://" };
  if (u.username || u.password) return { ok: false, reason: "Put the key in the API key box, not in the address." };
  if (u.search || u.hash) return { ok: false, reason: "The address must not carry ? or # parts. Put the key in the API key box." };
  const local = isLocalOrPrivateHost(u.hostname);
  if (production && !allowPrivate) {
    if (local) return { ok: false, reason: "An AI service on this machine or the private network cannot be used here." };
    if (u.protocol !== "https:") return { ok: false, reason: "The address must start with https:// so the question and the key are encrypted on the way." };
  }
  // Normalised so ".../v1" and ".../v1/" are one address, and the provider can append "/chat/completions".
  const url = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  return { ok: true, url };
}

module.exports = { checkAiEndpoint, checkModelId, MAX_LENGTH };
