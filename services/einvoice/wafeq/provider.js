// The Wafeq provider: implements the same two methods as the built-in sandbox (services/einvoice/providers.js), so nothing else in the
// pipeline (payload, validation, state machine, retries, screens) changes.
//
//   submit(payload, { idempotencyKey, settings, submission }) -> { entryId, status, raw, extra }
//   getStatus(submission, { settings })                        -> { status, taxStatus, note, extra }
//
// `payload.wafeq` ({ path, body }) is the body Wafeq takes, built and stored with the invoice by EInvoiceService.build, so what was sent is
// reproducible. Rules below were measured in the Wafeq sandbox on 20 Nov 2026.
const { ProviderError } = require("../../../utils/providerError");
const { WafeqClient, classify } = require("./client");

// A correction after a buyer's rejection (same number, corrects_document_id): Wafeq's refusals, in words a person can act on.
const CORRECTION_RETRY = new Set(["correction_not_ready", "transport_reconciliation_required"]); // wait, then send the same body with the same key
const CORRECTION_TEXT = {
  sandbox_reporting_disabled: "Corrections are only possible in live mode (Wafeq's sandbox does not report to the tax authority)",
  c3_validation_rejection_required: "The buyer's rejection was for a reason that cannot be corrected: issue a credit note and a new invoice instead",
  correction_number_or_type_mismatch: "A correction must keep the same number and the same document type",
  correction_not_ready_or_already_replaced: "This invoice was already corrected, or is not ready to be",
  different_recovery_requires_reconciliation: "Wafeq must reconcile this invoice first: contact Wafeq support",
  queued_document_not_found: "Wafeq cannot find the original to correct",
  document_owner_changed: "The original was sent by another business",
};

const DELIVERED = new Set(["sent", "received_by_ap", "forwarded", "delivered_confirmed"]);
const modeOf = (settings) => (settings?.environment === "live" ? "live" : "sandbox");
const taxpayerOf = (settings) => {
  const id = settings?.wafeq?.taxpayerId;
  if (!id || settings.wafeq.status !== "active") throw new ProviderError("Wafeq is not connected for this organisation", { retryable: false, code: "WAFEQ_NOT_CONNECTED" });
  return id;
};

// One key per document version: the same body retried replays Wafeq's stored answer, a corrected body gets a new key.
const keyFor = (submission, fallback) => (submission?.payloadHash ? `${submission._id}:${String(submission.payloadHash).slice(0, 16)}` : String(fallback));

// The invoice may already be at Wafeq (a lost answer, a repeated number): find it by its number rather than send it twice.
async function findByNumber(mode, taxpayerId, path, number) {
  const res = await WafeqClient.list(mode, taxpayerId, path === "/credit-notes" ? "/credit-notes" : "/invoices");
  if (res.status !== 200) return null;
  return (res.body?.items || []).find((i) => i.invoice_number === number) || null;
}

const extraOf = (b) => ({ deliveryStatus: b?.delivery_status || b?.status || null, deliveryJobId: b?.delivery_job_id || null, route: b?.delivery_result?.route || null });

const wafeq = {
  label: "Wafeq",

  async submit(payload, { idempotencyKey, settings, submission } = {}) {
    const mode = modeOf(settings);
    const taxpayerId = taxpayerOf(settings);
    if (!payload?.wafeq?.body) throw new ProviderError("This invoice was not prepared for Wafeq", { retryable: false, code: "NOT_PREPARED" });
    const { path, body } = payload.wafeq;
    const number = body.invoice_number || body.credit_note_number;

    const res = await WafeqClient.submit(mode, taxpayerId, path, body, { idempotencyKey: keyFor(submission, idempotencyKey), grantId: settings.wafeq.grantId });
    const b = res.body || {};
    const detailCode = b?.detail?.code;
    if (CORRECTION_RETRY.has(detailCode)) throw new ProviderError("Wafeq is still withdrawing the rejected invoice; sending the correction again shortly", { retryable: true, status: res.status, raw: b, code: detailCode });
    if (CORRECTION_TEXT[detailCode]) throw new ProviderError(CORRECTION_TEXT[detailCode], { retryable: false, status: res.status, raw: b, code: detailCode });

    const adopt = async () => {
      const found = await findByNumber(mode, taxpayerId, path, number);
      // Only OUR document may be adopted: the number may have been used at Wafeq by another document (another system, or an earlier
      // test on a shared sandbox taxpayer). We always send source_id = our transaction id, so it must match.
      if (found && body.source_id && String(found.source_id || "") !== String(body.source_id)) {
        throw new ProviderError(`${number} is already used at Wafeq by another document; this invoice needs a different number`, { retryable: false, raw: b, code: "NUMBER_TAKEN_AT_WAFEQ" });
      }
      if (found) return { entryId: found.id, status: "SUBMITTED", raw: found, extra: { deliveryStatus: found.delivery_status || null, deliveryJobId: null, route: null } };
      throw new ProviderError(`Wafeq reports ${number} was already submitted but it could not be found; check it in the Wafeq portal`, { retryable: false, raw: b, code: "NOT_FOUND_AT_WAFEQ" });
    };

    if (res.status === 200 || res.status === 202) {
      if (b.success === false) {
        if (b.status === "duplicate_number") return adopt();
        // refused and not stored: validation_failed and friends wait for a person to correct the invoice
        throw new ProviderError(b.error || `Wafeq refused the invoice (${b.status})`, { retryable: false, status: res.status, raw: b, code: b.status });
      }
      // "failed" with a document: the buyer could not be reached but the tax authority is still reported; never sent again
      return { entryId: b.document_id, status: "SUBMITTED", raw: b, extra: extraOf(b) };
    }
    if (res.status === 409 && ["idempotency_unconfirmed", "document_already_submitted", "idempotency_key_reused"].includes(b?.detail?.code)) return adopt();
    if (res.status === 422) {
      const list = Array.isArray(b.detail) ? b.detail.map((d) => `${(d.loc || []).slice(1).join(".") || "body"}: ${d.msg}`).join("; ") : classify(res).message;
      throw new ProviderError(`Wafeq refused the invoice: ${list}`, { retryable: false, status: 422, raw: b, code: "validation" });
    }
    throw classify(res);
  },

  async getStatus(submission, { settings } = {}) {
    const mode = modeOf(settings);
    const taxpayerId = taxpayerOf(settings);
    if (!submission.providerEntryId) throw new ProviderError("No Wafeq document id is stored for this invoice", { retryable: false, code: "NO_ENTRY" });
    const res = await WafeqClient.getDocument(mode, taxpayerId, submission.providerEntryId);
    if (res.status !== 200) throw classify(res);
    return statusFrom(res.body);
  },
};

/** One Wafeq document (or a webhook's data) -> our status step. Pure. */
function statusFrom(d = {}) {
  const tdd = d.tdd_status || d.tax_authority_status || null;
  const delivery = d.delivery_status || null;
  // why the buyer rejected it (BV / SV can be corrected, FD cannot), from a webhook or from the stored document
  const reasonCode = d.reason_code || d.delivery_reason_code || null;
  const reasonText = d.reason_text || d.delivery_reason_text || null;
  const extra = { deliveryStatus: delivery, taxStatus: tdd, reasonCode, reasonText };
  const tddLow = String(tdd || "").toLowerCase();
  if (tddLow === "reported") return { status: "REPORTED", taxStatus: tdd, note: "Reported to the FTA", extra };
  if (tddLow === "rejected" || tddLow === "not_compliant") return { status: "REJECTED", taxStatus: tdd, note: "Not compliant with the FTA", extra: { ...extra, rejectedBy: "fta" } };
  if (delivery === "rejected") return { status: "REJECTED", taxStatus: tdd, note: reasonText ? `Rejected by the buyer: ${reasonText}` : "Rejected by the buyer", extra: { ...extra, rejectedBy: "buyer" } };
  if (DELIVERED.has(delivery) || d.status === "delivered") return { status: "ACKNOWLEDGED", taxStatus: tdd, note: tddLow === "not_reported" ? "Delivered (Wafeq sandbox: not reported to the FTA)" : undefined, extra };
  return { status: null, taxStatus: tdd, extra };
}

module.exports = { wafeq, statusFrom, keyFor };
