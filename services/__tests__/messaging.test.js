// Sending a document to the customer, against a throwaway database (random name, dropped afterwards)
// with the console provider, which fails by recipient address the way the e-invoice sandbox fails by
// buyer name. What these prove, beyond the pure tests and the fetch-level provider test:
//   - a double click sends once, and a deliberate second send is a second row (the e-invoice unique
//     index would have refused it)
//   - a temporary failure is retried with the IDENTICAL message and the message is wiped when it settles
//   - a refusal is not retried and nothing is kept
//   - the public link shows what it should and nothing else, and counts a person, not a mail scanner
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env") });
const mongoose = require("mongoose");

const skip = !process.env.MONGO_URI && "MONGO_URI not set";
const DB = `erp_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let svc;
test.before(async () => {
  if (skip) return;
  process.env.LOG_SILENT = "1";
  await mongoose.connect(process.env.MONGO_URI, { dbName: DB });
  svc = {
    seed: require("../../utils/seedAccounting").seedAccounting,
    Tx: require("../orderPurchase/transactionService"),
    Msg: require("../messaging/messagingService"),
    Settings: require("../messaging/settingsService"),
    Share: require("../messaging/shareService"),
    Audit: require("../orderPurchase/documentAuditService"),
    M: require("../../models/modules/messagingModels"),
    Transaction: require("../../models/modules/transactionModel"),
    Stock: require("../../models/modules/stockModel"),
    Vendor: require("../../models/modules/vendorModel"),
    Customer: require("../../models/modules/customerModel"),
    Admin: require("../../models/core/adminModel"),
  };
  await mongoose.connection.syncIndexes();
  await svc.seed({ log: () => {} });
});

test.after(async () => {
  if (skip || mongoose.connection.readyState !== 1) return;
  assert.equal(mongoose.connection.name, DB, "refusing to drop anything but the throwaway database");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

// ---- fixtures ----
let admin, customer, mute, rice, invoice;
const L = (item, qty, price) => ({ itemId: item._id, description: item.itemName, qty, price, rate: price, vatPercent: 5 });
const reqOf = (key) => ({ admin: { id: String(admin._id), name: "Boss", email: "boss@test.uae" }, headers: {}, get: (h) => (String(h).toLowerCase() === "idempotency-key" ? key : undefined) });
let n = 0;
const fresh = () => reqOf(`press-${Date.now()}-${(n += 1)}-abcdefgh`);
const pdf = (bytes = "%PDF-1.4\n%fake invoice\n") => ({ buffer: Buffer.from(bytes), originalname: "Tax-invoice_INV.pdf", size: Buffer.byteLength(bytes) });
const send = (over = {}, file = pdf(), req = fresh()) => svc.Msg.send({ docType: "tax_invoice", sourceId: invoice._id, force: true, ...over }, file, req);
const rows = () => svc.M.DocumentSend.find({}).select("+pending").sort({ createdAt: 1 });
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const reset = () => Promise.all([svc.M.DocumentSend.deleteMany({}), svc.M.ShareLink.deleteMany({})]);
const configure = (over = {}) => svc.M.MessagingSettings.updateOne({ companyId: "default" }, { $set: { enabled: true, provider: "console", fromEmail: "accounts@harbour.ae", fromName: "Harbour Trading", retryMax: 3, dailyLimit: 200, attachPdf: true, shareEnabled: true, ...over } }, { upsert: true });

test("setup: an admin with a company profile, a customer, stock, and an approved invoice", { skip }, async () => {
  admin = await new svc.Admin({
    name: "Boss", email: "boss@test.uae", password: "12312312", type: "super_admin", status: "active", isActive: true,
    companyInfo: { companyName: "Harbour Trading LLC", addressLine1: "Al Quoz, Dubai", phoneNumber: "04 123 4567", emailAddress: "accounts@harbour.ae", website: "harbour.ae" },
  }).save();
  const vendor = await svc.Vendor.create({ vendorId: "V1", vendorName: "Vend", contactPerson: "x", address: "y" });
  customer = await svc.Customer.create({ customerId: "C1", customerName: "Al Noor Trading", contactPerson: "Ali", email: "Ali@AlNoor.ae", phone: "050 111 2222", billingAddress: "Al Quoz", paymentTerms: "Net 30", contacts: [{ name: "Sara", email: "sara@alnoor.ae", isPrimary: true }] });
  mute = await svc.Customer.create({ customerId: "C2", customerName: "No Contact Trading", contactPerson: "Nobody" });
  const category = new mongoose.Types.ObjectId();
  rice = await svc.Stock.create({ itemId: "ITM1", sku: "SKU1", itemName: "Basmati Rice 5kg", category });
  const buy = await svc.Tx.createTransaction({ type: "purchase_order", partyId: vendor._id, partyType: "Vendor", partyTypeRef: "Vendor", items: [L(rice, 500, 10)] }, "tester");
  await svc.Tx.processTransaction(buy._id, "approve", "tester");
  const so = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [L(rice, 10, 20)] }, "tester");
  invoice = await svc.Tx.processTransaction(so._id, "approve", "tester");
  assert.equal(invoice.status, "APPROVED");
});

// ===================================== setup of sending =====================================

test("the key is saved encrypted, is never returned, and a wrong setup is refused in plain words", { skip }, async () => {
  const req = fresh();
  const out = await svc.Settings.update({ provider: "resend", apiKey: "re_live_secret", fromEmail: "Accounts@Harbour.ae", verifiedDomain: "@Harbour.ae", fromName: "Harbour" }, req);
  assert.equal(out.hasApiKey, true);
  assert.equal(out.connected, true);
  assert.equal(out.fromEmail, "accounts@harbour.ae");
  assert.equal(out.verifiedDomain, "harbour.ae");
  assert.equal(JSON.stringify(out).includes("re_live_secret"), false, "the key is write-only");
  assert.equal("apiKeyEnc" in out, false);
  const stored = await svc.M.MessagingSettings.findOne({ companyId: "default" }).select("+apiKeyEnc");
  assert.match(stored.apiKeyEnc, /^v1:/);
  assert.equal(stored.apiKeyEnc.includes("re_live_secret"), false);

  await assert.rejects(() => svc.Settings.update({ fromEmail: "x@other.com" }, req), { code: "FROM_DOMAIN_MISMATCH" });
  await assert.rejects(() => svc.Settings.update({ verifiedDomain: "gmail.com" }, req), { code: "FROM_DOMAIN_NOT_ALLOWED" });
  await assert.rejects(() => svc.Settings.update({ verifiedDomain: "not a domain" }, req), { code: "INVALID_DOMAIN" });
  await assert.rejects(() => svc.Settings.update({ replyTo: "nope" }, req), { code: "INVALID_EMAIL" });
  await assert.rejects(() => svc.Settings.update({ shareLinkDays: 0 }, req), { code: "INVALID_NUMBER" });
  await assert.rejects(() => svc.Settings.update({ provider: "carrier-pigeon" }, req), { code: "PROVIDER_NOT_AVAILABLE" });

  const kept = await svc.Settings.update({ fromName: "Harbour Trading" }, req); // no key in the body: the key is kept
  assert.equal(kept.hasApiKey, true);
});

test("sending cannot be switched on until the setup could work", { skip }, async () => {
  await svc.M.MessagingSettings.deleteMany({});
  const req = fresh();
  await svc.Settings.update({ provider: "resend", fromEmail: "accounts@harbour.ae" }, req); // no key, no verified domain
  const ready = await svc.Settings.readiness(req);
  assert.equal(ready.ready, false);
  assert.deepEqual(ready.checks.filter((c) => c.blocking && !c.ok).map((c) => c.key), ["key", "domain"]);
  await assert.rejects(() => svc.Settings.update({ enabled: true }, req), (e) => e.code === "MESSAGING_NOT_READY" && e.details.missing.includes("key"));
  await svc.Settings.update({ apiKey: "re_x", verifiedDomain: "harbour.ae" }, req);
  assert.equal((await svc.Settings.update({ enabled: true }, req)).enabled, true);
  // the console provider needs nothing, and says it is not connected
  const c = await svc.Settings.update({ provider: "console" }, req);
  assert.equal(c.connected, false);
});

test("while sending is off, or not set up, an email is refused with the reason", { skip }, async () => {
  await svc.M.MessagingSettings.deleteMany({});
  await assert.rejects(() => send(), { code: "MESSAGING_DISABLED" });
  await svc.M.MessagingSettings.create({ companyId: "default", enabled: true, provider: "resend", fromEmail: "accounts@harbour.ae" });
  await assert.rejects(() => send(), (e) => e.code === "MESSAGING_NOT_CONFIGURED" && e.details.missing.includes("key"));
  assert.equal(await svc.M.DocumentSend.countDocuments(), 0, "nothing was logged for a refusal that happened before any send");
});

test("an unsendable document is refused before anything is written", { skip }, async () => {
  await configure();
  const draft = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [L(rice, 1, 20)] }, "tester");
  await assert.rejects(() => send({ sourceId: draft._id }), (e) => e.code === "DOCUMENT_NOT_SENDABLE" && /not approved/.test(e.message));
  await assert.rejects(() => send({ docType: "carrier_pigeon" }), { code: "UNKNOWN_DOC_TYPE" });
  await assert.rejects(() => send({ docType: "quotation" }), { code: "UNKNOWN_DOC_TYPE" }, "stage 2");
  await assert.rejects(() => send({ sourceId: new mongoose.Types.ObjectId() }), { code: "DOCUMENT_NOT_FOUND" });
  await assert.rejects(() => send({ sourceId: "nope" }), { code: "DOCUMENT_NOT_FOUND" });
  assert.equal(await svc.M.DocumentSend.countDocuments(), 0);
  await svc.Tx.deleteTransaction(draft._id, "tester");
});

test("recipients are checked in plain words", { skip }, async () => {
  await assert.rejects(() => send({ to: "ali@alnoor.ae, not-an-address" }), (e) => e.code === "INVALID_EMAIL" && e.details.invalid[0] === "not-an-address");
  await assert.rejects(() => send({ to: Array.from({ length: 11 }, (_, i) => `a${i}@x.ae`) }), { code: "TOO_MANY_RECIPIENTS" });
  const so = await svc.Tx.createTransaction({ type: "sales_order", partyId: mute._id, partyType: "Customer", partyTypeRef: "Customer", items: [L(rice, 1, 20)] }, "tester");
  const bare = await svc.Tx.processTransaction(so._id, "approve", "tester");
  await assert.rejects(() => send({ sourceId: bare._id, to: "" }), { code: "NO_RECIPIENT" });
  await assert.rejects(() => send({ includeShareLink: false }, null), { code: "PDF_REQUIRED" });
  assert.equal(await svc.M.DocumentSend.countDocuments(), 0);
});

// ===================================== a send =====================================

test("an invoice is emailed: one row, a link, the message wiped, the invoice remembers it", { skip }, async () => {
  await configure();
  await reset();
  const file = pdf();
  const r = await send({ note: "Thank you for your order" }, file);
  assert.equal(r.duplicate, false);
  assert.equal(r.send.status, "SENT");
  assert.deepEqual(r.send.to, ["ali@alnoor.ae"], "the customer's own address, lowercased");
  assert.equal(r.send.channel, "email");
  assert.equal(r.send.provider, "console");
  assert.match(r.send.subject, /^Tax invoice .* from Harbour Trading LLC$/);
  assert.equal(r.send.attachment.sha256, require("crypto").createHash("sha256").update(file.buffer).digest("hex"));
  assert.equal(r.send.attachment.bytes, file.size);
  assert.equal(r.send.sentByName, "Boss");
  assert.deepEqual(r.send.history.map((h) => h.status), ["QUEUED", "SENT"]);
  assert.match(r.share.url, /\/d\/[0-9A-Z]{11}\.[A-Za-z0-9_-]{43}$/);
  assert.equal("pending" in r.send, false, "the response never carries the message");

  const [row] = await rows();
  assert.equal(row.pending, undefined, "settled: the PDF and the link-bearing HTML are not kept");
  const token = r.share.url.split("/d/")[1];
  assert.equal(JSON.stringify(row.toObject()).includes(token.split(".")[1]), false, "the secret is nowhere in the log");
  assert.ok(row.bodyPreview.includes("[document link]") && !row.bodyPreview.includes("/d/"));

  const tx = await svc.Transaction.findById(invoice._id);
  assert.equal(tx.lastSend.status, "SENT");
  assert.equal(tx.lastSend.channel, "email");
  assert.equal(tx.lastSend.to, "ali@alnoor.ae");
  assert.equal(tx.lastSend.openedAt ?? null, null, "not opened yet");
  assert.equal(tx.lastSend.provider, "console", "the document remembers the mode, so a screen can say Recorded only, never Emailed");
});

test("the customer's primary contact is a recipient too, and a copy to oneself is added when asked", { skip }, async () => {
  await reset();
  const r = await send({ to: "ali@alnoor.ae, SARA@alnoor.ae, ali@alnoor.ae", cc: "boss@alnoor.ae" });
  assert.deepEqual(r.send.to, ["ali@alnoor.ae", "sara@alnoor.ae"], "unique, lowercased");
  assert.deepEqual(r.send.cc, ["boss@alnoor.ae"]);
  await configure({ bccSelf: true });
  const r2 = await send();
  assert.deepEqual(r2.send.bcc, ["boss@test.uae"]);
  await configure({ bccSelf: false });
});

test("a double click sends once; a deliberate second send is a second row", { skip }, async () => {
  await reset();
  const same = reqOf("one-press-of-the-button-1");
  const [a, b] = await Promise.all([send({}, pdf(), same), send({}, pdf(), same)]);
  assert.equal([a, b].filter((x) => x.duplicate).length, 1, "exactly one of the two was the repeat");
  assert.equal(await svc.M.DocumentSend.countDocuments(), 1);
  assert.equal(await svc.M.ShareLink.countDocuments(), 1, "and a repeat does not mint a second link");
  // the same key again, later: still the same row
  const again = await send({}, pdf(), same);
  assert.equal(again.duplicate, true);
  assert.equal(await svc.M.DocumentSend.countDocuments(), 1);

  // a new press of the button is a new send, inside the window only if the person says so
  await assert.rejects(() => send({ force: false }, pdf(), fresh()), (e) => e.code === "DUPLICATE_SEND" && Boolean(e.details.sendId));
  const third = await send({ force: true }, pdf(), fresh());
  assert.equal(third.duplicate, false);
  assert.equal(await svc.M.DocumentSend.countDocuments(), 2, "the same invoice emailed twice: two rows");
  assert.equal(await svc.M.ShareLink.countDocuments(), 2);
});

test("a header-less client still cannot double send", { skip }, async () => {
  await reset();
  const bare = () => ({ admin: { id: String(admin._id), name: "Boss", email: "boss@test.uae" }, headers: {}, get: () => undefined });
  const [a, b] = await Promise.all([send({ force: true }, pdf(), bare()), send({ force: true }, pdf(), bare())]);
  assert.equal([a, b].filter((x) => x.duplicate).length, 1);
  assert.equal(await svc.M.DocumentSend.countDocuments(), 1);
});

test("a link-only send (no PDF) works, and a company can run link-only", { skip }, async () => {
  await reset();
  const r = await send({}, null);
  assert.equal(r.send.attachment, undefined);
  assert.ok(r.share.url);
  await configure({ attachPdf: false });
  const r2 = await send({}, pdf());
  assert.equal(r2.send.attachment, undefined, "a PDF sent to a link-only company is ignored");
  await configure({ attachPdf: true });
});

test("a daily limit stops a runaway", { skip }, async () => {
  await reset();
  await configure({ dailyLimit: 2 });
  await send();
  await send();
  await assert.rejects(() => send(), { code: "SEND_LIMIT_REACHED" });
  await configure({ dailyLimit: 200 });
});

// ===================================== failures and retries =====================================

const failing = (over = {}, file = pdf(), req = fresh()) => send(over, file, req).then(() => assert.fail("expected the send to fail"), (e) => e);

test("a refused address is not retried, nothing is kept, and the person is told why", { skip }, async () => {
  await reset();
  const e = await failing({ to: "badaddr@example.com" });
  assert.equal(e.code, "INVALID_ADDRESS");
  assert.equal(e.statusCode, 400);
  assert.equal(e.details.retryable, false);
  const [row] = await rows();
  assert.equal(row.status, "FAILED");
  assert.equal(row.retryable, false);
  assert.equal(row.nextRetryAt, null);
  assert.equal(row.lastErrorCode, "INVALID_ADDRESS");
  assert.equal(row.pending, undefined, "a refusal needs a fresh send, so no message is held");
  assert.equal(row.attempts, 1);
  const tx = await svc.Transaction.findById(invoice._id);
  assert.equal(tx.lastSend.status, "FAILED");
  assert.match(tx.lastSend.error, /refused one of the addresses/);
  await assert.rejects(() => svc.Msg.retry(row._id, fresh()), { code: "RETRY_NOT_POSSIBLE" });
});

test("a bad key says so and is noted on the settings", { skip }, async () => {
  await reset();
  const e = await failing({ to: "authfail@example.com" });
  assert.equal(e.code, "PROVIDER_AUTH");
  assert.equal(e.statusCode, 502);
  const s = await svc.M.MessagingSettings.findOne({ companyId: "default" });
  assert.ok(s.lastAuthFailureAt);
  await svc.M.MessagingSettings.updateOne({ companyId: "default" }, { $set: { lastAuthFailureAt: null } });
});

test("a temporary failure keeps the message, is retried by the background pass, and sends the identical message", { skip }, async () => {
  await reset();
  const file = pdf("%PDF-1.4\n%the exact bytes\n");
  const e = await failing({ to: "netfailonce@example.com" }, file);
  assert.equal(e.code, "PROVIDER_UNREACHABLE");
  assert.equal(e.statusCode, 503);
  assert.equal(e.details.retryable, true);
  assert.ok(e.details.nextRetryAt);

  let [row] = await rows();
  assert.equal(row.status, "FAILED");
  assert.equal(row.retryable, true);
  assert.equal(row.attempts, 1);
  assert.ok(row.nextRetryAt > new Date(), "a retry is booked for a minute from now");
  assert.ok(row.pending.bytes.length > 0, "the message is held for the retry");
  const before = { sha: row.attachment.sha256, html: row.pending.html };

  await svc.Msg.processDue(); // not due yet: nothing happens
  [row] = await rows();
  assert.equal(row.attempts, 1);

  await svc.M.DocumentSend.updateOne({ _id: row._id }, { $set: { nextRetryAt: new Date(Date.now() - 1000) } });
  await svc.Msg.processDue();
  [row] = await rows();
  assert.equal(row.status, "SENT");
  assert.equal(row.attempts, 2);
  assert.equal(row.attachment.sha256, before.sha, "the same file");
  assert.equal(row.pending, undefined, "settled: wiped");
  assert.deepEqual(row.history.map((h) => h.status), ["QUEUED", "FAILED", "SENT"], "queued, failed, then sent on the retry");
  assert.equal((await svc.Transaction.findById(invoice._id)).lastSend.status, "SENT");
});

test("out of automatic attempts, the message is still held so a person can press Retry", { skip }, async () => {
  await reset();
  await configure({ retryMax: 1 });
  const e = await failing({ to: "netfail@example.com" });
  assert.equal(e.code, "PROVIDER_UNREACHABLE");
  let [row] = await rows();
  assert.equal(row.nextRetryAt, null, "no more automatic tries");
  assert.equal(row.retryable, true);
  assert.ok(row.pending.html, "but the message is kept");
  await svc.Msg.processDue();
  [row] = await rows();
  assert.equal(row.attempts, 1, "the pass leaves it alone");

  await assert.rejects(() => svc.Msg.retry(row._id, fresh()), { code: "PROVIDER_UNREACHABLE" }, "it fails again, honestly");
  [row] = await rows();
  assert.equal(row.attempts, 2);
  assert.equal(row.status, "FAILED");

  await svc.M.DocumentSend.updateOne({ _id: row._id }, { $set: { to: ["ali@alnoor.ae"] } }); // the address was fixed
  const done = await svc.Msg.retry(row._id, fresh());
  assert.equal(done.status, "SENT");
  assert.equal(done.attempts, 3);
  await assert.rejects(() => svc.Msg.retry(row._id, fresh()), { code: "RETRY_NOT_POSSIBLE" }, "already sent");
  await configure({ retryMax: 3 });
});

test("a message held too long is gone, and a retry then says to send again", { skip }, async () => {
  await reset();
  await configure({ retryMax: 1 });
  await failing({ to: "netfail@example.com" });
  let [row] = await rows();
  await svc.M.DocumentSend.collection.updateOne({ _id: row._id }, { $set: { updatedAt: new Date(Date.now() - 25 * 3600 * 1000) } });
  await svc.Msg.processDue();
  [row] = await rows();
  assert.equal(row.pending, undefined, "wiped by the daily sweep");
  await assert.rejects(() => svc.Msg.retry(row._id, fresh()), { code: "ATTACHMENT_GONE" });
  await configure({ retryMax: 3 });
});

test("a send that was interrupted is called what it is", { skip }, async () => {
  await reset();
  await configure({ retryMax: 1 });
  await failing({ to: "netfail@example.com" });
  let [row] = await rows();
  await svc.M.DocumentSend.collection.updateOne({ _id: row._id }, { $set: { status: "QUEUED", updatedAt: new Date(Date.now() - 20 * 60 * 1000) } });
  await svc.Msg.processDue();
  [row] = await rows();
  assert.equal(row.status, "FAILED");
  assert.equal(row.lastErrorCode, "SEND_INTERRUPTED");
  assert.equal(row.retryable, false);
  assert.match(row.lastError, /may or may not have gone out/);
  assert.equal(row.pending, undefined);
  await configure({ retryMax: 3 });
});

test("the background pass does nothing while sending is switched off", { skip }, async () => {
  await reset();
  await configure({ retryMax: 3 });
  await failing({ to: "netfailonce@example.com" });
  let [row] = await rows();
  await svc.M.DocumentSend.updateOne({ _id: row._id }, { $set: { nextRetryAt: new Date(Date.now() - 1000) } });
  await configure({ enabled: false });
  await svc.Msg.processDue();
  [row] = await rows();
  assert.equal(row.status, "FAILED");
  assert.equal(row.attempts, 1);
  await configure({ enabled: true });
});

// ===================================== the public link =====================================

const tokenOf = (r) => r.share.url.split("/d/")[1];
const visitor = (ip = "203.0.113.9") => ({ headers: { "x-forwarded-for": ip }, ip: "10.0.0.1", get: () => "Mozilla/5.0 test" });

test("the link shows the invoice and nothing internal, and counts a person, not a scanner", { skip }, async () => {
  await reset();
  const r = await send();
  const token = tokenOf(r);
  const link = await svc.Share.resolve(token);
  const data = link.snapshot;
  assert.equal(data.kind, "tax_invoice");
  assert.equal(data.document.transactionNo, invoice.transactionNo);
  assert.equal(data.document.items[0].description, "Basmati Rice 5kg");
  assert.equal(data.document.pricing.grandTotal, 210);
  assert.equal(data.party.customerName, "Al Noor Trading");
  assert.equal(data.company.companyName, "Harbour Trading LLC", "the company block comes from the sender's profile");
  const text = JSON.stringify(data);
  for (const forbidden of ["currentPurchasePrice", "allocations", "createdBy", "partyId", "paidAmount", "outstandingAmount", "closedShort", "lastSend", "itemId", "_id", "contacts", "secretHash"]) {
    assert.equal(text.includes(`"${forbidden}"`), false, `${forbidden} reached the public snapshot`);
  }
  assert.ok(Math.abs(link.expiresAt - (Date.now() + 30 * 24 * 3600 * 1000)) < 60000, "30 days");

  await svc.Share.recordFetch(link); // a mail scanner or a chat preview
  let l = await svc.M.ShareLink.findById(link._id);
  assert.equal(l.fetchCount, 1);
  assert.equal(l.viewCount, 0, "a raw fetch proves nothing about a person");
  assert.equal(l.firstViewedAt, null);

  await svc.Share.recordView(token, visitor()); // the page loaded
  l = await svc.M.ShareLink.findById(link._id);
  assert.equal(l.viewCount, 1);
  assert.ok(l.firstViewedAt);
  assert.equal(l.views[0].ip, "203.0.113.0", "a shortened address is kept, not the whole one");
  const first = l.firstViewedAt;
  const send1 = await svc.M.DocumentSend.findOne({ shareLinkId: link._id });
  assert.ok(send1.openedAt);
  assert.ok((await svc.Transaction.findById(invoice._id)).lastSend.openedAt, "the invoice says it was opened");

  await svc.Share.recordView(token, visitor("198.51.100.4"));
  l = await svc.M.ShareLink.findById(link._id);
  assert.equal(l.viewCount, 2);
  assert.equal(String(l.firstViewedAt), String(first), "the first open is never overwritten");
});

test("a link that is not valid says nothing about why, and tells the real holder the truth", { skip }, async () => {
  await reset();
  const r = await send();
  const token = tokenOf(r);
  const [publicId, secret] = token.split(".");
  const wrongSecret = `${publicId}.${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;
  const answers = [];
  for (const bad of [wrongSecret, "ZZZZZZZZZZZ." + secret, "nope", "", `${publicId}.`]) {
    const e = await svc.Share.resolve(bad).then(() => assert.fail("expected a refusal"), (x) => x);
    assert.equal(e.statusCode, 404);
    assert.equal(e.code, "SHARE_NOT_FOUND");
    answers.push(e.message);
    assert.equal(e.details, undefined);
  }
  assert.equal(new Set(answers).size, 1, "one answer for every kind of bad link");
  assert.equal(answers[0].includes("Al Noor") || answers[0].includes(invoice.transactionNo), false);

  const link = await svc.M.ShareLink.findOne({ publicId });
  await svc.Share.revoke(link._id, { by: "boss", reason: "wrong address" }, fresh());
  const gone = await svc.Share.resolve(token).then(() => assert.fail("expected"), (x) => x);
  assert.equal(gone.statusCode, 410);
  assert.equal(gone.code, "SHARE_REVOKED");
  assert.equal(gone.details.company, "Harbour Trading LLC", "someone holding the real link is told who to ask");
  await assert.rejects(() => svc.Share.revoke(link._id, {}, fresh()), { code: "ALREADY_REVOKED" });
  await assert.rejects(() => svc.Share.recordView(token, visitor()), { code: "SHARE_REVOKED" });

  const r2 = await send();
  await svc.M.ShareLink.updateOne({ publicId: tokenOf(r2).split(".")[0] }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const old = await svc.Share.resolve(tokenOf(r2)).then(() => assert.fail("expected"), (x) => x);
  assert.equal(old.statusCode, 410);
  assert.equal(old.code, "SHARE_EXPIRED");
});

test("deleting the order withdraws the link a customer was sent", { skip }, async () => {
  await reset();
  const so = await svc.Tx.createTransaction({ type: "sales_order", partyId: customer._id, partyType: "Customer", partyTypeRef: "Customer", items: [L(rice, 2, 20)] }, "tester");
  const inv = await svc.Tx.processTransaction(so._id, "approve", "tester");
  const r = await svc.Msg.send({ docType: "tax_invoice", sourceId: inv._id, force: true }, pdf(), fresh());
  await svc.Tx.deleteTransaction(inv._id, "tester");
  await settle(300);
  const e = await svc.Share.resolve(tokenOf(r)).then(() => assert.fail("expected"), (x) => x);
  assert.equal(e.code, "SHARE_REVOKED");
});

// ===================================== WhatsApp =====================================

test("WhatsApp is handed over, never claimed as sent, and needs no email setup", { skip }, async () => {
  await reset();
  await configure({ enabled: false });
  const r = await svc.Msg.handoff({ docType: "tax_invoice", sourceId: invoice._id, note: "Thanks again" }, fresh());
  assert.equal(r.send.status, "HANDED_OFF");
  assert.equal(r.send.channel, "whatsapp");
  assert.equal(r.send.phone, "971501112222", "the customer's own number, in wa.me form");
  assert.equal(r.send.providerMessageId, null);
  assert.deepEqual(r.send.to, []);
  assert.ok(r.send.bodyPreview.includes("[document link]") && !r.send.bodyPreview.includes("/d/"));
  assert.ok(r.waUrl.startsWith("https://wa.me/971501112222?text="));
  const text = decodeURIComponent(r.waUrl.split("?text=")[1]);
  assert.ok(text.includes(r.share.url), "the link is in the message");
  assert.match(text, /^Dear Ali, tax invoice .* from Harbour Trading LLC for 210\.00 AED\./);
  assert.ok(text.includes("Thanks again"));
  assert.ok(text.length <= 460, `short enough for a phone: ${text.length}`);
  const tx = await svc.Transaction.findById(invoice._id);
  assert.equal(tx.lastSend.status, "HANDED_OFF");
  assert.equal(tx.lastSend.channel, "whatsapp");

  const typed = await svc.Msg.handoff({ docType: "tax_invoice", sourceId: invoice._id, phone: "+971 55 000 1111" }, fresh());
  assert.equal(typed.send.phone, "971550001111", "a typed number wins");
  await assert.rejects(() => svc.Msg.handoff({ docType: "tax_invoice", sourceId: invoice._id, phone: "call me" }, fresh()), { code: "INVALID_PHONE" });
  await configure({ enabled: true });
});

test("WhatsApp needs a number and a link, and a double click hands over once", { skip }, async () => {
  await reset();
  const so = await svc.Tx.createTransaction({ type: "sales_order", partyId: mute._id, partyType: "Customer", partyTypeRef: "Customer", items: [L(rice, 1, 20)] }, "tester");
  const bare = await svc.Tx.processTransaction(so._id, "approve", "tester");
  await assert.rejects(() => svc.Msg.handoff({ docType: "tax_invoice", sourceId: bare._id }, fresh()), { code: "NO_PHONE" });

  const same = reqOf("one-whatsapp-press-123");
  const a = await svc.Msg.handoff({ docType: "tax_invoice", sourceId: invoice._id }, same);
  const b = await svc.Msg.handoff({ docType: "tax_invoice", sourceId: invoice._id }, same);
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(b.waUrl, null, "a repeat does not open WhatsApp again");
  assert.equal(await svc.M.DocumentSend.countDocuments(), 1);

  await configure({ shareEnabled: false });
  await assert.rejects(() => svc.Msg.handoff({ docType: "tax_invoice", sourceId: invoice._id }, fresh()), { code: "SHARE_DISABLED" });
  await configure({ shareEnabled: true });
});

// ===================================== history =====================================

test("each document has a history, with the state of its link, and the audit trail carries it", { skip }, async () => {
  await reset();
  await send({ to: "ali@alnoor.ae" });
  await svc.Msg.handoff({ docType: "tax_invoice", sourceId: invoice._id }, fresh());
  const list = await svc.Msg.list(fresh(), { sourceType: "Transaction", sourceId: String(invoice._id) });
  assert.equal(list.total, 2);
  assert.deepEqual(list.rows.map((x) => x.channel).sort(), ["email", "whatsapp"]);
  assert.ok(list.rows.every((x) => x.share && x.share.publicId), "each row says what became of its link");
  assert.ok(list.rows.every((x) => !("pending" in x) && !("providerResponse" in x)), "no message bytes, no provider payload");
  assert.equal((await svc.Msg.list(fresh(), { channel: "email" })).total, 1);
  assert.equal((await svc.Msg.list(fresh(), { status: "HANDED_OFF" })).total, 1);

  const one = await svc.Msg.get(list.rows[0]._id, fresh());
  assert.equal(String(one._id), String(list.rows[0]._id));
  await assert.rejects(() => svc.Msg.get("nope", fresh()), { code: "SEND_NOT_FOUND" });
  await assert.rejects(() => svc.Msg.get(new mongoose.Types.ObjectId(), fresh()), { code: "SEND_NOT_FOUND" });

  const trail = await svc.Audit.trail(invoice._id);
  assert.equal(trail.sends.length, 2);
  assert.equal(trail.shares.length, 2);
  assert.equal(JSON.stringify(trail.shares).includes("secretHash"), false);
  assert.equal(JSON.stringify(trail.shares).includes("snapshot"), false);
});

test("SMTP: the password is write-only, the server is checked, and it cannot be switched on half set up", { skip }, async () => {
  await svc.M.MessagingSettings.deleteMany({});
  const req = fresh();
  const first = await svc.Settings.update({ provider: "smtp", fromEmail: "accounts@harbour.ae" }, req);
  assert.equal(first.connected, true);
  const ready = await svc.Settings.readiness(req);
  assert.equal(ready.ready, false);
  assert.deepEqual(ready.checks.filter((c) => c.blocking && !c.ok).map((c) => c.key), ["server", "login"]);
  assert.equal(ready.checks.some((c) => c.key === "domain" || c.key === "key"), false, "the Resend checks do not apply");
  await assert.rejects(() => svc.Settings.update({ enabled: true }, req), (e) => e.code === "MESSAGING_NOT_READY" && e.details.missing.includes("server"));

  const out = await svc.Settings.update({ smtpHost: "SMTP.Harbour.ae", smtpPort: 587, smtpUser: "accounts@harbour.ae", smtpPassword: "  app-pass-123  " }, req);
  assert.equal(out.smtpHost, "smtp.harbour.ae");
  assert.equal(out.hasSmtpPassword, true);
  assert.equal(JSON.stringify(out).includes("app-pass-123"), false, "the password is write-only");
  assert.equal("smtpPassEnc" in out, false);
  const stored = await svc.M.MessagingSettings.findOne({ companyId: "default" }).select("+smtpPassEnc");
  assert.match(stored.smtpPassEnc, /^v1:/);
  assert.equal(stored.smtpPassEnc.includes("app-pass-123"), false);
  assert.equal(svc.Settings.keyOf(stored), "app-pass-123", "stored without the stray spaces");
  assert.deepEqual(svc.Settings.optionsOf(stored), { smtp: { host: "smtp.harbour.ae", port: 587, user: "accounts@harbour.ae" } });

  await assert.rejects(() => svc.Settings.update({ smtpPort: 8080 }, req), { code: "SMTP_TARGET_NOT_ALLOWED" });
  await assert.rejects(() => svc.Settings.update({ smtpPort: "abc" }, req), { code: "INVALID_NUMBER" });
  await assert.rejects(() => svc.Settings.update({ smtpHost: "not a host" }, req), { code: "SMTP_TARGET_NOT_ALLOWED" });
  await assert.rejects(() => svc.Settings.update({ smtpUser: "a b" }, req), { code: "INVALID_USERNAME" });

  // the sender need not be the login, but the checklist advises it, and it does not stop sending
  await svc.Settings.update({ fromEmail: "billing@harbour.ae" }, req);
  const advised = await svc.Settings.readiness(req);
  assert.equal(advised.ready, true);
  assert.equal(advised.checks.find((c) => c.key === "sender-login").ok, false);
  assert.equal(advised.checks.find((c) => c.key === "sender-login").blocking, false);
  assert.equal((await svc.Settings.update({ enabled: true }, req)).enabled, true);

  // a domain verified for another provider no longer gets in the way of the mailbox's own address
  await svc.Settings.update({ verifiedDomain: "harbour.ae" }, req);
  const gmail = await svc.Settings.update({ fromEmail: "owner@gmail.com", smtpUser: "owner@gmail.com", smtpHost: "smtp.gmail.com" }, req);
  assert.equal(gmail.fromEmail, "owner@gmail.com");

  // leaving the provider and coming back keeps the password, and an omitted password keeps it too
  await svc.Settings.update({ provider: "console" }, req);
  assert.equal((await svc.Settings.update({ provider: "smtp" }, req)).hasSmtpPassword, true);
  assert.equal((await svc.Settings.update({ smtpUser: "owner@gmail.com" }, req)).hasSmtpPassword, true);
});

test("an invoice goes out through the saved mail server and password, and failures are told apart", { skip }, async () => {
  await reset();
  await svc.M.MessagingSettings.deleteMany({});
  const req = fresh();
  await svc.Settings.update({ provider: "smtp", smtpHost: "smtp.harbour.ae", smtpPort: 587, smtpUser: "accounts@harbour.ae", smtpPassword: "app-pass-123", fromEmail: "accounts@harbour.ae", fromName: "Harbour Trading", enabled: true }, req);

  const nodemailer = require("nodemailer");
  const real = nodemailer.createTransport;
  const seen = [];
  let behaviour = async () => ({ messageId: "<ok@harbour.ae>", accepted: ["ali@alnoor.ae"], rejected: [], response: "250 2.0.0 OK" });
  nodemailer.createTransport = (options) => ({ sendMail: async (mail) => { seen.push({ options, mail }); return behaviour(mail); }, close() {} });
  try {
    const ok = await send({ to: "ali@alnoor.ae" });
    assert.equal(ok.send.status, "SENT");
    assert.equal(ok.send.provider, "smtp");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].options.host, "smtp.harbour.ae");
    assert.deepEqual(seen[0].options.auth, { user: "accounts@harbour.ae", pass: "app-pass-123" }, "the saved password is what is sent");
    assert.ok(seen[0].mail.to.includes("ali@alnoor.ae"));
    assert.equal(seen[0].mail.attachments[0].content.toString().startsWith("%PDF"), true, "the customer's PDF travels as bytes");
    assert.equal(seen[0].mail.messageId, `<${ok.send._id}@harbour.ae>`);
    const sent = await svc.Transaction.findById(invoice._id);
    assert.equal(sent.lastSend.status, "SENT");
    assert.equal(sent.lastSend.provider, "smtp");

    behaviour = async () => { throw Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535, response: "535 5.7.8 nope" }); };
    const refused = await failing({ to: "ali@alnoor.ae" });
    assert.equal(refused.code, "PROVIDER_AUTH");
    assert.match(refused.message, /app password/);
    const refusedRow = (await rows()).at(-1);
    assert.equal(refusedRow.retryable, false, "a wrong password is not retried");
    assert.equal(refusedRow.pending, undefined, "and nothing is kept");
    assert.ok((await svc.M.MessagingSettings.findOne({ companyId: "default" })).lastAuthFailureAt, "it is noted on the settings");

    behaviour = async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); };
    const down = await failing({ to: "ali@alnoor.ae" });
    assert.equal(down.code, "PROVIDER_UNREACHABLE");
    const downRow = (await rows()).at(-1);
    assert.equal(downRow.retryable, true, "an unreachable server is tried again");
    assert.ok(downRow.nextRetryAt);
    assert.ok(downRow.pending?.html, "the message is held so the retry sends the same one");

    const everything = JSON.stringify(await svc.M.DocumentSend.find({}).select("+pending").lean());
    assert.equal(everything.includes("app-pass-123"), false, "the password is in no row of the log");
  } finally {
    nodemailer.createTransport = real;
  }
});

test("the customer's link points at the frontend the sender is actually using", { skip }, async () => {
  const req = (origin) => ({ get: (h) => (String(h).toLowerCase() === "origin" ? origin : undefined) });
  const saved = process.env.PUBLIC_APP_URL;
  delete process.env.PUBLIC_APP_URL;
  try {
    // a send from the dev server must not hand the sender a link into a deployed build that may not
    // carry the page yet - that is a 404 for a customer, and it happened
    assert.equal(svc.Share.baseUrl(req("http://localhost:5173")), "http://localhost:5173");
    assert.equal(svc.Share.urlFor("TOKEN", req("http://localhost:5173")), "http://localhost:5173/d/TOKEN");
    // an origin we do not trust is ignored: a forged header cannot redirect a customer anywhere new
    assert.equal(svc.Share.baseUrl(req("https://evil.example")), "https://zarvia.onrender.com");
    assert.equal(svc.Share.baseUrl(undefined), "https://zarvia.onrender.com");
    // where it is set, the setting wins over everything, with a trailing slash tolerated
    process.env.PUBLIC_APP_URL = "https://books.client.ae/";
    assert.equal(svc.Share.baseUrl(req("http://localhost:5173")), "https://books.client.ae");
  } finally {
    if (saved === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = saved;
  }

  // and a real send carries that link into the email and the row
  await reset();
  await configure();
  const out = await send({ to: "ali@alnoor.ae" }, pdf(), { ...fresh(), get: (h) => (String(h).toLowerCase() === "origin" ? "http://localhost:5173" : fresh().get(h)) });
  assert.ok(out.share.url.startsWith("http://localhost:5173/d/"), out.share.url);
});
