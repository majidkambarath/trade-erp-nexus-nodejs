// The one place that talks to Wafeq. Plain fetch behind an injectable `http` (the pattern of googleCalendarService), so every rule above it is
// proved with recorded sandbox answers and no account. Answers are returned as { status, headers, body } and classified by the callers;
// `classify` turns a refusal into a ProviderError (retryable or not).
const { ProviderError } = require("../../../utils/providerError");
const { apiBase, modeConfig } = require("./config");

const TIMEOUT_MS = 30000;

async function fetchHttp(url, { method = "GET", headers = {}, body } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: json, text };
  } finally {
    clearTimeout(timer);
  }
}

// Wafeq's limits are per Wafeq ORGANISATION, so every client of ours shares them: 60 submits, 120 validates, 120 reads a minute.
const LIMITS = { submit: 60, validate: 120, read: 120 };
const windows = new Map(); // `${mode}|${kind}` -> [timestamps]
function take(mode, kind, now = Date.now()) {
  const k = `${mode}|${kind}`;
  const w = (windows.get(k) || []).filter((t) => now - t < 60000);
  if (w.length >= LIMITS[kind]) { windows.set(k, w); return false; }
  w.push(now);
  windows.set(k, w);
  return true;
}

class WafeqClient {
  static get http() { return WafeqClient._http || fetchHttp; }
  /** Tests replace the one function that reaches the network. */
  static useHttp(fn) { WafeqClient._http = fn; }
  static resetLimits() { windows.clear(); }

  static config(mode) {
    const cfg = modeConfig(mode);
    if (!cfg || !cfg.available) throw new ProviderError(`Wafeq ${mode === "live" ? "live" : "test"} access is not installed on this server`, { retryable: false, code: "WAFEQ_MODE_UNAVAILABLE" });
    return cfg;
  }

  static headers(cfg, taxpayerId, extra = {}) {
    return { Authorization: `Api-Key ${cfg.apiKey}`, "Content-Type": "application/json", Accept: "application/json", ...(taxpayerId ? { "x-ae-taxpayer-id": taxpayerId } : {}), ...extra };
  }

  /** One call as a taxpayer. kind = "submit" | "validate" | "read" (the shared rate bucket). */
  static async call(mode, taxpayerId, { method = "GET", path, body, kind = "read", headers = {}, grantId } = {}) {
    const cfg = WafeqClient.config(mode);
    if (!take(mode, kind)) throw new ProviderError("Wafeq's rate limit was reached; trying again shortly", { retryable: true, status: 429, code: "RATE_LIMITED" });
    let res;
    try {
      res = await WafeqClient.http(`${apiBase()}${path}`, {
        method, headers: WafeqClient.headers(cfg, taxpayerId, { ...(grantId ? { "x-ae-grant-id": grantId } : {}), ...headers }), body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ProviderError(`Could not reach Wafeq: ${err.name === "AbortError" ? "timed out" : err.message}`, { retryable: true, code: "NETWORK" });
    }
    return res;
  }

  // ---- a taxpayer's calls ----------------------------------------------------------------------------------------
  static profile(mode, taxpayerId) { return WafeqClient.call(mode, taxpayerId, { path: "/settings/profile" }); }
  static validate(mode, taxpayerId, path, body) { return WafeqClient.call(mode, taxpayerId, { method: "POST", path: `${path}/validate`, body, kind: "validate" }); }
  static submit(mode, taxpayerId, path, body, { idempotencyKey, grantId } = {}) {
    return WafeqClient.call(mode, taxpayerId, { method: "POST", path, body, kind: "submit", grantId, headers: { "Idempotency-Key": idempotencyKey, Prefer: "respond-async" } });
  }
  static getDocument(mode, taxpayerId, documentId) { return WafeqClient.call(mode, taxpayerId, { path: `/invoices/${encodeURIComponent(documentId)}` }); }
  static list(mode, taxpayerId, path, query = "") { return WafeqClient.call(mode, taxpayerId, { path: `${path}?limit=200${query ? `&${query}` : ""}` }); }
  /** The e-invoice as received or sent (UBL XML). Wafeq answers the XML directly, or a redirect to a 15-minute link which fetch follows. */
  static xml(mode, taxpayerId, documentId) { return WafeqClient.call(mode, taxpayerId, { path: `/invoices/${encodeURIComponent(documentId)}/xml`, headers: { Accept: "application/xml" } }); }

  // ---- OAuth and the organisation's own calls ---------------------------------------------------------------------
  static async form(url, cfg, fields) {
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
    try {
      return await WafeqClient.http(url, {
        method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(fields).toString(),
      });
    } catch (err) {
      throw new ProviderError(`Could not reach Wafeq: ${err.message}`, { retryable: true, code: "NETWORK" });
    }
  }
  static exchangeCode(mode, { code, verifier, redirectUri }) {
    const cfg = WafeqClient.config(mode);
    return WafeqClient.form(cfg.tokenUrl, cfg, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri });
  }
  static orgToken(mode) {
    const cfg = WafeqClient.config(mode);
    return WafeqClient.form(cfg.tokenUrl, cfg, { grant_type: "client_credentials" });
  }
  static async orgCall(mode, token, { method = "GET", path }) {
    const cfg = WafeqClient.config(mode);
    try {
      return await WafeqClient.http(`${apiBase()}${path}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
    } catch (err) {
      throw new ProviderError(`Could not reach Wafeq: ${err.message}`, { retryable: true, code: "NETWORK" });
    } finally { void cfg; }
  }
  static async registrationCheck(mode, tin) {
    const cfg = WafeqClient.config(mode);
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
    try {
      return await WafeqClient.http(cfg.registrationUrl, { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" }, body: JSON.stringify({ tin }) });
    } catch (err) {
      throw new ProviderError(`Could not reach Wafeq: ${err.message}`, { retryable: true, code: "NETWORK" });
    }
  }
}

/** A non-success answer as a ProviderError: whether trying again can help, and the words a person sees. */
function classify(res) {
  const status = res.status;
  const d = res.body?.detail;
  const code = (d && typeof d === "object" && !Array.isArray(d) ? d.code : null) || res.body?.status || null;
  const text = (d && typeof d === "object" && !Array.isArray(d) ? d.message : typeof d === "string" ? d : null) || res.body?.error || `Wafeq answered ${status}`;
  const mk = (message, retryable, c) => new ProviderError(message, { retryable, status, raw: res.body, code: c || code || undefined });
  if (status === 429) return mk("Wafeq's rate limit was reached; trying again shortly", true, "RATE_LIMITED");
  if (status >= 500) return mk(`Wafeq is unavailable (${status}${code ? `: ${code}` : ""})`, true);
  if (status === 402) return mk("Wafeq subscription or document credit is needed", false, "PAYMENT_REQUIRED");
  if (status === 403 && code === "grant_not_active") return mk("The Wafeq connection was withdrawn; connect again", false, "grant_not_active");
  if (status === 404 && /unknown taxpayer/i.test(String(text))) return mk("Wafeq does not know this business; connect it again", false, "unknown_taxpayer");
  if (status === 409 && code === "idempotency_in_progress") return mk("Wafeq is still processing this document", true, code);
  if (status === 401 || status === 403) return mk(`Wafeq refused the access key (${status})`, false, code || "unauthorised");
  return mk(text, false);
}

module.exports = { WafeqClient, classify, take, LIMITS };
