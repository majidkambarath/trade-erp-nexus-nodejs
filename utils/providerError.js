// A failure reported by an outside provider (an e-invoice access point, an email service). `retryable`
// says whether trying again can help; `code` is the stable name the screens act on. Shared so the two
// pipelines classify failures the same way.
class ProviderError extends Error {
  constructor(message, { retryable = true, status, raw, code, retryAfterMs } = {}) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
    this.status = status;
    this.raw = raw;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

module.exports = { ProviderError };
