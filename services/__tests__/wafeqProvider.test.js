// The Wafeq provider against RECORDED sandbox answers (20 Nov 2026): the network function is replaced, nothing leaves the machine.
process.env.WAFEQ_API_KEY_TEST = "pk_test_unit";
const test = require("node:test");
const assert = require("node:assert/strict");
const { wafeq, statusFrom, keyFor } = require("../einvoice/wafeq/provider");
const { WafeqClient, classify } = require("../einvoice/wafeq/client");

const settings = { environment: "sandbox", wafeq: { taxpayerId: "txpay_abc", grantId: "tgr_abc", status: "active", mode: "sandbox" } };
const payload = { wafeq: { path: "/invoices", body: { invoice_number: "SO-1", line_items: [] } } };
const sub = { _id: "sub1", payloadHash: "abcdef0123456789abcdef" };
const ok = (body, status = 200) => ({ status, headers: {}, body });

let calls;
const fake = (...answers) => {
  calls = [];
  WafeqClient.useHttp(async (url, opts) => { calls.push({ url, ...opts }); const a = answers.shift(); if (a instanceof Error) throw a; return typeof a === "function" ? a(url, opts) : a; });
};
test.beforeEach(() => WafeqClient.resetLimits());
test.after(() => WafeqClient.useHttp(null));

test("a sync delivery becomes SUBMITTED with the document id, headers and idempotency key Wafeq needs", async () => {
  fake(ok({ success: true, status: "delivered", document_id: "inv_1", delivery_job_id: null, delivery_result: { simulated: true, status: "delivered" } }));
  const r = await wafeq.submit(payload, { idempotencyKey: "x", settings, submission: sub });
  assert.equal(r.entryId, "inv_1");
  assert.equal(r.status, "SUBMITTED");
  assert.equal(r.extra.deliveryStatus, "delivered");
  const c = calls[0];
  assert.equal(c.url, "https://api.wafeq.com/ae/v1/invoices");
  assert.equal(c.headers.Authorization, "Api-Key pk_test_unit");
  assert.equal(c.headers["x-ae-taxpayer-id"], "txpay_abc");
  assert.equal(c.headers["x-ae-grant-id"], "tgr_abc");
  assert.equal(c.headers["Idempotency-Key"], "sub1:abcdef0123456789");
  assert.equal(c.headers.Prefer, "respond-async");
});

test("an async 202 keeps the delivery job", async () => {
  fake(ok({ success: true, status: "queued", document_id: "inv_2", delivery_job_id: "djob_9", delivery_result: { phase: "discovery" } }, 202));
  const r = await wafeq.submit(payload, { settings, submission: sub });
  assert.equal(r.extra.deliveryJobId, "djob_9");
  assert.equal(r.extra.deliveryStatus, "queued");
});

test("the idempotency key changes with the body and not otherwise", () => {
  assert.equal(keyFor(sub), keyFor({ ...sub }));
  assert.notEqual(keyFor(sub), keyFor({ ...sub, payloadHash: "ffff0123456789abcdef" }));
});

test("a refused document (validation_failed) is not retryable and carries Wafeq's reasons", async () => {
  fake(ok({ success: false, status: "validation_failed", error: "invalid", validation_errors: [{ code: "SCH:ibr-167-ae", message: "needs a reason" }] }));
  await assert.rejects(() => wafeq.submit(payload, { settings, submission: sub }), (e) => e.retryable === false && e.raw.validation_errors[0].code === "SCH:ibr-167-ae");
});

test("duplicate_number adopts the document Wafeq already holds", async () => {
  fake(
    ok({ success: false, status: "duplicate_number", error: "already submitted" }),
    ok({ items: [{ id: "inv_old", invoice_number: "SO-1", delivery_status: "sent" }] })
  );
  const r = await wafeq.submit(payload, { settings, submission: sub });
  assert.equal(r.entryId, "inv_old");
  assert.equal(r.status, "SUBMITTED");
});

test("a number Wafeq holds for ANOTHER document is never adopted", async () => {
  const mine = { wafeq: { path: "/invoices", body: { invoice_number: "SO-1", source_id: "tx-mine", line_items: [] } } };
  fake(ok({ success: false, status: "duplicate_number" }), ok({ items: [{ id: "inv_theirs", invoice_number: "SO-1", source_id: "tx-someone-else" }] }));
  await assert.rejects(() => wafeq.submit(mine, { settings, submission: sub }), (e) => e.retryable === false && e.code === "NUMBER_TAKEN_AT_WAFEQ");
  fake(ok({ success: false, status: "duplicate_number" }), ok({ items: [{ id: "inv_mine", invoice_number: "SO-1", source_id: "tx-mine" }] }));
  assert.equal((await wafeq.submit(mine, { settings, submission: sub })).entryId, "inv_mine");
});

test("an idempotency key reused with another body also looks for the document, and fails plainly when it is not there", async () => {
  fake({ status: 409, body: { detail: { code: "idempotency_key_reused", message: "different payload" } } }, ok({ items: [] }));
  await assert.rejects(() => wafeq.submit(payload, { settings, submission: sub }), (e) => e.retryable === false && e.code === "NOT_FOUND_AT_WAFEQ");
});

test("a 422 lists what is wrong and is not retryable", async () => {
  fake({ status: 422, body: { detail: [{ type: "value_error", loc: ["body", "customer"], msg: "required" }] } });
  await assert.rejects(() => wafeq.submit(payload, { settings, submission: sub }), (e) => e.retryable === false && /customer: required/.test(e.message));
});

test("429, 503 and a network failure are retryable; 402 and a withdrawn grant are not", async () => {
  fake({ status: 429, body: { error: "Rate limit exceeded: 60 per 1 minute" } });
  await assert.rejects(() => wafeq.submit(payload, { settings, submission: sub }), (e) => e.retryable === true);
  fake({ status: 503, body: { detail: { code: "smp_unavailable" } } });
  await assert.rejects(() => wafeq.submit(payload, { settings, submission: sub }), (e) => e.retryable === true);
  fake(new Error("socket hang up"));
  await assert.rejects(() => wafeq.submit(payload, { settings, submission: sub }), (e) => e.retryable === true && e.code === "NETWORK");
  fake({ status: 402, body: { detail: { code: "subscription_required" } } });
  await assert.rejects(() => wafeq.submit(payload, { settings, submission: sub }), (e) => e.retryable === false && e.code === "PAYMENT_REQUIRED");
  fake({ status: 403, body: { detail: { code: "grant_not_active" } } });
  await assert.rejects(() => wafeq.submit(payload, { settings, submission: sub }), (e) => e.retryable === false && e.code === "grant_not_active");
  fake({ status: 404, body: { detail: "Unknown taxpayer" } });
  await assert.rejects(() => wafeq.submit(payload, { settings, submission: sub }), (e) => e.code === "unknown_taxpayer");
});

test("an unlinked organisation never reaches the network", async () => {
  fake(ok({}));
  await assert.rejects(() => wafeq.submit(payload, { settings: { environment: "sandbox", wafeq: { status: "revoked", taxpayerId: "txpay_abc" } }, submission: sub }), { code: "WAFEQ_NOT_CONNECTED" });
  assert.equal(calls.length, 0);
});

test("the live mode needs the live key to be installed", async () => {
  fake(ok({}));
  await assert.rejects(() => wafeq.submit(payload, { settings: { ...settings, environment: "live" }, submission: sub }), { code: "WAFEQ_MODE_UNAVAILABLE" });
});

test("the shared rate limit is respected before any call is made", async () => {
  fake(...Array.from({ length: 70 }, () => ok({ success: true, status: "queued", document_id: "inv_x" }, 202)));
  let limited = 0;
  for (let i = 0; i < 65; i++) { try { await wafeq.submit(payload, { settings, submission: sub }); } catch (e) { if (e.code === "RATE_LIMITED") limited += 1; } }
  assert.equal(limited, 5);
  assert.equal(calls.length, 60);
});

test("status: delivered in the sandbox is ACKNOWLEDGED, never REPORTED (the sandbox reports nothing to the FTA)", () => {
  const r = statusFrom({ status: "delivered", delivery_status: "sent", tdd_status: "not_reported" });
  assert.equal(r.status, "ACKNOWLEDGED");
  assert.equal(r.taxStatus, "not_reported");
  assert.match(r.note, /sandbox/);
});

test("status: reported, FTA-rejected, buyer-rejected, in flight", () => {
  assert.equal(statusFrom({ delivery_status: "delivered_confirmed", tdd_status: "reported" }).status, "REPORTED");
  assert.equal(statusFrom({ delivery_status: "sent", tdd_status: "rejected" }).status, "REJECTED");
  assert.equal(statusFrom({ tax_authority_status: "NOT_COMPLIANT" }).status, "REJECTED");
  assert.equal(statusFrom({ delivery_status: "rejected" }).note, "Rejected by the buyer");
  assert.equal(statusFrom({ delivery_status: "sending", tdd_status: "reporting" }).status, null);
});

test("getStatus reads the stored document and classifies a failed read", async () => {
  fake(ok({ status: "delivered", delivery_status: "sent", tdd_status: "not_reported" }));
  const r = await wafeq.getStatus({ providerEntryId: "inv_1" }, { settings });
  assert.equal(r.status, "ACKNOWLEDGED");
  assert.equal(calls[0].url, "https://api.wafeq.com/ae/v1/invoices/inv_1");
  fake({ status: 500, body: null });
  await assert.rejects(() => wafeq.getStatus({ providerEntryId: "inv_1" }, { settings }), (e) => e.retryable === true);
});

test("classify never treats an unknown 4xx as retryable", () => {
  assert.equal(classify({ status: 400, body: { detail: "bad" } }).retryable, false);
});
