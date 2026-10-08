// What a failed email request means, and whether trying again can help. Pure, so the whole table is
// tested without a network. `status` is the HTTP status, `body` the parsed JSON (or null).
//
// Resend answers { statusCode, name, message }. The name is the stable part, so it is read first.

const retryAfterMsFrom = (header) => {
  if (header === undefined || header === null || header === "") return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3600 * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.min(Math.max(at - Date.now(), 0), 3600 * 1000);
};

// What a person is told. Plain words, no provider jargon.
const MESSAGES = {
  PROVIDER_AUTH: "The email service refused our key. Check it in Settings, under Sending.",
  FROM_NOT_VERIFIED: "The email service has not verified the sender domain yet. Add its DNS records, then try again.",
  INVALID_ADDRESS: "The email service refused one of the addresses. Check them and try again.",
  PROVIDER_REJECTED: "The email service refused this message.",
  PROVIDER_QUOTA: "The email plan sending limit has been reached. It resets later; the message was not sent.",
  PROVIDER_RATE_LIMIT: "The email service is slowing us down. It will try again shortly.",
  PROVIDER_BUSY: "The email service is busy with this message. It will try again shortly.",
  PROVIDER_UNAVAILABLE: "The email service is not responding. It will try again shortly.",
  PROVIDER_UNREACHABLE: "We could not reach the email service. It will try again shortly.",
  PROVIDER_TIMEOUT: "The email service took too long to answer. It will try again shortly.",
};

function classify(status, body, { retryAfter } = {}) {
  const name = String(body?.name || "").toLowerCase();
  const detail = String(body?.message || "").trim();
  const mk = (code, retryable, withDetail = false) => ({
    code, retryable, status,
    message: MESSAGES[code] + (withDetail && detail ? ` (${detail})` : ""),
    retryAfterMs: retryable ? retryAfterMsFrom(retryAfter) : undefined,
  });

  if (name === "daily_quota_exceeded" || name === "monthly_quota_exceeded") return mk("PROVIDER_QUOTA", false);
  if (status === 429) return mk("PROVIDER_RATE_LIMIT", true);
  if (status === 401 || name === "missing_api_key" || name === "invalid_api_key") return mk("PROVIDER_AUTH", false);
  if (status === 403) {
    // The sender domain not being verified is the first wall every client meets.
    return /domain|verif/i.test(detail) ? mk("FROM_NOT_VERIFIED", false, true) : mk("PROVIDER_AUTH", false);
  }
  if (name === "concurrent_idempotent_requests") return mk("PROVIDER_BUSY", true);
  if (status === 409) return mk("PROVIDER_REJECTED", false, true);
  if (name === "invalid_from_address") return mk("FROM_NOT_VERIFIED", false, true);
  if (status === 422 || name === "validation_error") {
    return /\b(to|cc|bcc)\b.*(email|address)|invalid.*(email|address)/i.test(detail) ? mk("INVALID_ADDRESS", false, true) : mk("PROVIDER_REJECTED", false, true);
  }
  if (status >= 500) return mk("PROVIDER_UNAVAILABLE", true);
  if (status >= 400) return mk("PROVIDER_REJECTED", false, true);
  return mk("PROVIDER_UNAVAILABLE", true);
}

module.exports = { classify, MESSAGES, retryAfterMsFrom };
