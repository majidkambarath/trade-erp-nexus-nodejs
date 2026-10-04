// Delivery providers for e-invoices.
//
// A provider is how an invoice leaves the system and how its status comes back. Each one exposes
// two methods:
//
//   submit(payload, { idempotencyKey })  -> { entryId, status, raw }
//   getStatus(submission)                -> { status, taxStatus, note }
//
// and throws ProviderError({ retryable }) on failure: a temporary fault is retryable, a refusal
// of the payload is not and waits for a person to correct it.
//
// Only the built-in sandbox exists today. The connection to a Ministry-accredited service provider
// is not built yet: when it is, it is a second provider implementing these same two methods, and
// nothing else in the pipeline (payload, validation, state machine, retries) changes.

class ProviderError extends Error {
  constructor(message, { retryable = true, status, raw } = {}) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
    this.status = status;
    this.raw = raw;
  }
}

// The sandbox needs no account. Its behaviour is driven by the buyer's name so every path of the
// pipeline can be exercised: "NETFAIL" -> temporary network failure, "BADREQ" -> payload refused,
// "REJECT" -> delivered, then rejected downstream. Otherwise the invoice is delivered on the
// first check and reported to the tax authority on the second.
const sandbox = {
  label: "Sandbox",
  async submit(payload, { idempotencyKey }) {
    const name = String(payload.buyerName || "");
    if (name.includes("NETFAIL")) throw new ProviderError("Sandbox: simulated network failure", { retryable: true });
    if (name.includes("BADREQ")) throw new ProviderError("Sandbox: payload refused", { retryable: false, status: 400 });
    return { entryId: `SBX-${String(idempotencyKey).slice(-10)}`, status: "SUBMITTED", raw: { sandbox: true } };
  },
  async getStatus(submission) {
    if (String(submission.buyerName || "").includes("REJECT")) {
      return { status: "REJECTED", taxStatus: null, note: "Sandbox: rejected by the receiving access point" };
    }
    return submission.pollCount >= 2
      ? { status: "REPORTED", taxStatus: "REPORTING_CONFIRMED" }
      : { status: "ACKNOWLEDGED", taxStatus: "PENDING" };
  },
};

const PROVIDERS = { sandbox };
module.exports = { PROVIDERS, ProviderError };
