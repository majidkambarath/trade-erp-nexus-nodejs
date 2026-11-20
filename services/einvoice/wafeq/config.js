// Wafeq installation configuration: read from the environment, never stored per organisation. The partner model: Zarvia holds the Wafeq
// organisation and its keys; each client business only links its own taxpayer. Two modes, as Wafeq has two: "sandbox" uses the `pk_test_`
// key and "live" the `pk_live_` one (the key's prefix is what selects the mode at Wafeq; the base URL is the same).
const MODES = ["sandbox", "live"];
const SUFFIX = { sandbox: "TEST", live: "LIVE" };

const env = (k) => String(process.env[k] || "").trim();

function apiBase() {
  return (env("WAFEQ_API_BASE") || "https://api.wafeq.com/ae/v1").replace(/\/+$/, "");
}
function portalBase() {
  return (env("WAFEQ_PORTAL_BASE") || "https://einvoicing.wafeq.com").replace(/\/+$/, "");
}

/** A mode is available when its API key is installed; connecting by OAuth also needs the client id and secret. */
function modeConfig(mode) {
  const s = SUFFIX[mode];
  if (!s) return null;
  const apiKey = env(`WAFEQ_API_KEY_${s}`);
  const clientId = env(`WAFEQ_CLIENT_ID_${s}`);
  const clientSecret = env(`WAFEQ_CLIENT_SECRET_${s}`);
  return {
    mode, apiKey, clientId, clientSecret, webhookSecret: env(`WAFEQ_WEBHOOK_SECRET_${s}`),
    available: Boolean(apiKey), oauth: Boolean(clientId && clientSecret),
    // sandbox OAuth lives under /sandbox on the portal
    authorizeUrl: `${portalBase()}${mode === "sandbox" ? "/sandbox" : ""}/oauth/authorize`,
    tokenUrl: `${portalBase()}${mode === "sandbox" ? "/sandbox" : ""}/oauth/token`,
    registrationUrl: `${portalBase()}${mode === "sandbox" ? "/sandbox" : ""}/oauth/taxpayer-registration`,
  };
}

const modeOfWebhook = (m) => ({ test: "sandbox", live: "live" }[m] || null);

module.exports = { MODES, apiBase, portalBase, modeConfig, modeOfWebhook };
