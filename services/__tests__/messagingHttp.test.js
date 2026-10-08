// Sending documents over HTTP: a real server process against a throwaway database, real login. The
// service tests call the code directly; this proves what only a request can: that the public link is
// reachable with no login and says nothing it should not, that a real multipart upload works and is
// refused when it is too big or not a PDF, that the browser's preflight lets Idempotency-Key through,
// that a client cannot hammer the public link, and that only an admin changes the setup.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const PORT = 3300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const ROOT = path.resolve(__dirname, "..", "..");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

let child;
let M;
const S = {};
let logs = "";

async function call(method, url, { body, token = S.token, headers: extra = {}, form } = {}) {
  const headers = { ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${url}`, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  const type = res.headers.get("content-type") || "";
  const data = type.includes("json") ? await res.json() : null;
  return { status: res.status, data, body: data?.data, headers: res.headers };
}

const upload = (fields, file, key) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append("pdf", new Blob([file.bytes], { type: file.type || "application/pdf" }), file.name || "invoice.pdf");
  return call("POST", "/messaging/send", { form, headers: key ? { "Idempotency-Key": key } : {} });
};

test.before(async () => {
  if (skip) return;
  const uri = process.env.MONGO_URI.replace(/\/([^/?]*)\?/, `/${DB}?`);
  assert.ok(uri.includes(DB), "could not point the server at the throwaway database");
  child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), LOG_SILENT: "1", TENANT_LEGACY_DEFAULT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  await mongoose.connect(uri);
  M = {
    Admin: require("../../models/core/adminModel"),
    Customer: require("../../models/modules/customerModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Stock: require("../../models/modules/stockModel"),
  };
  await mongoose.connection.syncIndexes();
  const deadline = Date.now() + 60000;
  for (;;) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.slice(-1500)}`);
    await new Promise((r) => setTimeout(r, 400));
  }
});

test.after(async () => {
  if (skip) return;
  child?.kill();
  if (mongoose.connection.readyState === 1) {
    assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

const settleAudit = () => new Promise((r) => setTimeout(r, 300)); // the audit write is fire-and-forget
const login = async (email) => (await call("POST", "/login", { body: { email, password: "12312312" }, token: null })).body.tokens.accessToken;

test("setup: an admin and an operator, a customer, stock, and an approved invoice", { skip }, async () => {
  await new M.Admin({ name: "Boss", email: "boss@test.uae", password: "12312312", type: "super_admin", status: "active", isActive: true, companyInfo: { companyName: "Harbour Trading LLC", phoneNumber: "04 123 4567" } }).save();
  await new M.Admin({ name: "Op", email: "op@test.uae", password: "12312312", type: "operator", status: "active", isActive: true }).save();
  S.token = await login("boss@test.uae");
  S.opToken = await login("op@test.uae");
  await call("GET", "/accounting/chart"); // opens the chart: posting on, accounts mapped

  S.customer = await M.Customer.create({ customerId: "C1", customerName: "Al Noor Trading", contactPerson: "Ali", email: "ali@alnoor.ae", phone: "050 111 2222", billingAddress: "Al Quoz" });
  const vendor = await M.Vendor.create({ vendorId: "V1", vendorName: "Vend", contactPerson: "x", address: "y" });
  const rice = await M.Stock.create({ itemId: "ITM1", sku: "SKU1", itemName: "Basmati Rice 5kg", category: new mongoose.Types.ObjectId() });
  const line = (qty, price) => ({ itemId: rice._id, description: "Basmati Rice 5kg", qty, price, rate: price, vatPercent: 5 });
  const buy = await call("POST", "/transactions/transactions", { body: { type: "purchase_order", partyId: vendor._id, partyType: "Vendor", items: [line(100, 10)] } });
  assert.equal((await call("PATCH", `/transactions/transactions/${buy.body._id}/process`, { body: { action: "approve" } })).status, 200);
  const so = await call("POST", "/transactions/transactions", { body: { type: "sales_order", partyId: S.customer._id, partyType: "Customer", items: [line(10, 20)] } });
  assert.equal(so.status, 201, JSON.stringify(so.data));
  assert.equal((await call("PATCH", `/transactions/transactions/${so.body._id}/process`, { body: { action: "approve" } })).status, 200);
  S.invoice = so.body;
});

test("every route that sends or reads history needs a login", { skip }, async () => {
  for (const [method, url] of [["GET", "/messaging/sends"], ["GET", "/messaging/settings"], ["POST", "/messaging/send"], ["POST", "/messaging/handoff"], ["GET", "/messaging/shares"], ["PUT", "/messaging/settings"]]) {
    const r = await call(method, url, { token: null });
    assert.equal(r.status, 401, `${method} ${url}`);
  }
});

test("only an admin changes the setup; anyone signed in can read the history", { skip }, async () => {
  const denied = await call("PUT", "/messaging/settings", { body: { provider: "console" }, token: S.opToken });
  assert.equal(denied.status, 403);
  assert.equal((await call("GET", "/messaging/sends", { token: S.opToken })).status, 200);
  const put = await call("PUT", "/messaging/settings", { body: { provider: "console", fromName: "Harbour Trading", fromEmail: "accounts@harbour.ae", enabled: true } });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.success, true);
  assert.equal(put.body.enabled, true);
  assert.equal(put.body.connected, false, "the console provider says it is not connected");
  const keyed = await call("PUT", "/messaging/settings", { body: { apiKey: "re_secret_value" } });
  assert.equal(keyed.body.hasApiKey, true);
  assert.equal(JSON.stringify(keyed.data).includes("re_secret_value"), false);
  const got = await call("GET", "/messaging/settings");
  assert.equal(JSON.stringify(got.data).includes("re_secret_value"), false);
  assert.equal(JSON.stringify(got.data).includes("apiKeyEnc"), false);
  const bad = await call("PUT", "/messaging/settings", { body: { fromEmail: "x@other.com", verifiedDomain: "harbour.ae" } });
  assert.equal(bad.status, 422);
  assert.equal(bad.data.errorCode, "FROM_DOMAIN_MISMATCH");
});

test("a real multipart upload sends the invoice, and the link opens with no login", { skip }, async () => {
  const sha = crypto.createHash("sha256").update(PDF).digest("hex");
  const r = await upload({ docType: "tax_invoice", sourceId: S.invoice._id, note: "Thank you" }, { bytes: PDF }, "http-test-press-0001");
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.success, true);
  assert.equal(r.body.send.status, "SENT");
  assert.equal(r.body.send.attachment.sha256, sha, "the bytes that arrived are the bytes that were posted");
  assert.deepEqual(r.body.send.to, ["ali@alnoor.ae"]);
  S.token2 = r.body.share.url.split("/d/")[1];

  // the same press again: the same row
  const again = await upload({ docType: "tax_invoice", sourceId: S.invoice._id }, { bytes: PDF }, "http-test-press-0001");
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.send._id, r.body.send._id);

  // the public link: NO Authorization header
  const open = await call("GET", `/share/${S.token2}`, { token: null });
  assert.equal(open.status, 200, JSON.stringify(open.data));
  assert.equal(open.body.kind, "tax_invoice");
  assert.equal(open.body.party.customerName, "Al Noor Trading");
  assert.equal(open.body.company.companyName, "Harbour Trading LLC");
  assert.equal(JSON.stringify(open.data).includes("secretHash"), false);
  assert.match(open.headers.get("cache-control"), /no-store/);
  assert.match(open.headers.get("x-robots-tag"), /noindex/);
  assert.equal(open.headers.get("referrer-policy"), "no-referrer");
  assert.equal(open.headers.get("set-cookie"), null);
});

test("a link that does not work answers 404 and names nothing", { skip }, async () => {
  const r = await call("GET", "/share/ZZZZZZZZZZZ.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", { token: null });
  assert.equal(r.status, 404);
  assert.equal(r.data.errorCode, "SHARE_NOT_FOUND");
  const text = JSON.stringify(r.data);
  assert.equal(/Al Noor|Harbour|INV|SO-/.test(text), false);
  assert.equal((await call("GET", "/share/not-a-token", { token: null })).status, 404);
  assert.match(r.headers.get("cache-control"), /no-store/, "an error is not cached either");
});

test("the page's 'I loaded' signal is a person; the invoice and the trail show it", { skip }, async () => {
  const beacon = await fetch(`${BASE}/share/${S.token2}/viewed`, { method: "POST" });
  assert.equal(beacon.status, 204);
  const trail = await call("GET", `/transactions/transactions/${S.invoice._id}/audit`);
  assert.equal(trail.status, 200);
  assert.equal(trail.body.sends.length, 1);
  assert.equal(trail.body.shares[0].viewCount, 1);
  assert.ok(trail.body.shares[0].firstViewedAt);
  assert.ok(trail.body.sends[0].openedAt);
  const actions = trail.body.activity.map((a) => a.action);
  assert.ok(actions.includes("DOCUMENT_EMAILED"), `the send is in the document's own activity (got ${actions})`);
  const one = await call("GET", `/transactions/transactions/${S.invoice._id}`);
  assert.equal(one.body.transaction.lastSend.status, "SENT");
  assert.ok(one.body.transaction.lastSend.openedAt);
  const list = await call("GET", "/transactions/transactions?type=sales_order&limit=50");
  assert.equal(list.body.find((t) => t._id === S.invoice._id).lastSend.channel, "email", "the list rows carry it too");
});

test("a file that is too big, or not a PDF, is refused before anything is sent", { skip }, async () => {
  const big = await upload({ docType: "tax_invoice", sourceId: S.invoice._id, force: "true" }, { bytes: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(5 * 1024 * 1024, 65)]) });
  assert.equal(big.status, 413);
  assert.equal(big.data.errorCode, "PDF_TOO_LARGE");
  const png = await upload({ docType: "tax_invoice", sourceId: S.invoice._id, force: "true" }, { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), name: "invoice.pdf" });
  assert.equal(png.status, 415);
  assert.equal(png.data.errorCode, "PDF_INVALID");
  const sends = await call("GET", "/messaging/sends");
  assert.equal(sends.body.total, 1, "neither refusal left a row");
});

test("a link-only send needs no file and works as plain JSON", { skip }, async () => {
  const r = await call("POST", "/messaging/send", { body: { docType: "tax_invoice", sourceId: S.invoice._id, force: true }, headers: { "Idempotency-Key": "http-test-linkonly-01" } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.body.send.attachment, undefined);
  assert.ok(r.body.share.url);
});

test("the browser's preflight lets Idempotency-Key through", { skip }, async () => {
  const res = await fetch(`${BASE}/messaging/send`, {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type,idempotency-key" },
  });
  assert.equal(res.status, 204);
  assert.match(String(res.headers.get("access-control-allow-headers")).toLowerCase(), /idempotency-key/);
});

test("a failed send answers with a code the screen can act on, and the row is there", { skip }, async () => {
  const r = await upload({ docType: "tax_invoice", sourceId: S.invoice._id, to: "netfail@example.com", force: "true" }, { bytes: PDF }, "http-test-netfail-001");
  assert.equal(r.status, 503);
  assert.equal(r.data.success, false);
  assert.equal(r.data.errorCode, "PROVIDER_UNREACHABLE");
  assert.equal(r.data.details.retryable, true);
  const one = await call("GET", `/messaging/sends/${r.data.details.sendId}`);
  assert.equal(one.body.status, "FAILED");
  assert.equal(one.body.lastErrorCode, "PROVIDER_UNREACHABLE");
  assert.equal("pending" in one.body, false, "never the held message");
  const trail = await call("GET", `/transactions/transactions/${S.invoice._id}/audit`);
  assert.ok(trail.body.activity.some((a) => a.action === "DOCUMENT_SEND_FAILED"), "the failure is in the document's own history");
});

test("WhatsApp over HTTP returns the link to open, and withdrawing a link is one call", { skip }, async () => {
  const r = await call("POST", "/messaging/handoff", { body: { docType: "tax_invoice", sourceId: S.invoice._id }, headers: { "Idempotency-Key": "http-test-wa-0000001" } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.ok(r.body.waUrl.startsWith("https://wa.me/971501112222?text="));
  assert.equal(r.body.send.status, "HANDED_OFF");
  const token = r.body.share.url.split("/d/")[1];
  assert.equal((await call("GET", `/share/${token}`, { token: null })).status, 200);

  const shares = await call("GET", `/messaging/shares?sourceType=Transaction&sourceId=${S.invoice._id}`);
  assert.equal(shares.status, 200);
  assert.equal(JSON.stringify(shares.data).includes("secretHash"), false);
  assert.equal(JSON.stringify(shares.data).includes("snapshot"), false);
  const row = shares.body.find((s) => s.publicId === token.split(".")[0]);
  const revoked = await call("POST", `/messaging/shares/${row._id}/revoke`, { body: { reason: "wrong number" } });
  assert.equal(revoked.status, 200);
  const gone = await call("GET", `/share/${token}`, { token: null });
  assert.equal(gone.status, 410);
  assert.equal(gone.data.errorCode, "SHARE_REVOKED");
  assert.equal((await call("POST", `/messaging/shares/${row._id}/revoke`)).status, 409);
});

// The signed path (a good signature accepted, a forged one refused) is proved by httpFlow.test.js, which
// needs the raw body this change narrowed. Here: an unconfigured webhook still answers as one.
test("the e-invoice webhook route is untouched by the narrowed body capture", { skip }, async () => {
  const res = await fetch(`${BASE}/einvoice/inbound/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-einvoice-signature": "sha256=deadbeef" }, body: JSON.stringify({ a: 1 }) });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).errorCode, "WEBHOOK_NOT_CONFIGURED");
});

test("someone hammering the public link is slowed down, and a real customer is not", { skip }, async () => {
  let limited = null;
  for (let i = 0; i < 80 && !limited; i += 1) {
    const r = await call("GET", "/share/ZZZZZZZZZZZ.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", { token: null, headers: { "X-Forwarded-For": "198.51.100.77" } });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, "the 61st request in a window is refused");
  assert.equal(limited.data.errorCode, "SHARE_RATE_LIMIT");
  assert.match(limited.headers.get("cache-control"), /no-store/);
  const other = await call("GET", "/share/ZZZZZZZZZZZ.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", { token: null, headers: { "X-Forwarded-For": "203.0.113.5" } });
  assert.equal(other.status, 404, "another address has its own allowance");
});

test("SMTP setup over HTTP: the password never comes back and never reaches the audit log; an operator cannot set it", { skip }, async () => {
  const ActivityLog = require("../../models/modules/financial/activityLogModel");
  const denied = await call("PUT", "/messaging/settings", { body: { smtpPassword: "op-tries-this" }, token: S.opToken });
  assert.equal(denied.status, 403);

  const put = await call("PUT", "/messaging/settings", { body: { provider: "smtp", smtpHost: "smtp.harbour.ae", smtpPort: 587, smtpUser: "accounts@harbour.ae", smtpPassword: "http-app-pass-77", fromEmail: "accounts@harbour.ae" } });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.body.provider, "smtp");
  assert.equal(put.body.hasSmtpPassword, true);
  assert.equal(JSON.stringify(put.data).includes("http-app-pass-77"), false);
  const got = await call("GET", "/messaging/settings");
  assert.equal(JSON.stringify(got.data).includes("http-app-pass-77"), false);
  assert.equal(JSON.stringify(got.data).includes("smtpPassEnc"), false);

  const bad = await call("PUT", "/messaging/settings", { body: { smtpPort: 8080 } });
  assert.equal(bad.status, 422);
  assert.equal(bad.data.errorCode, "SMTP_TARGET_NOT_ALLOWED");

  await settleAudit();
  const logged = JSON.stringify(await ActivityLog.find({ action: "MESSAGING_SETTINGS_CHANGED" }).lean());
  assert.equal(logged.includes("http-app-pass-77"), false, "the password is in no audit row");
  assert.equal(logged.includes("op-tries-this"), false);

  await call("PUT", "/messaging/settings", { body: { provider: "console" } }); // leave the setup as the other tests expect it
});
